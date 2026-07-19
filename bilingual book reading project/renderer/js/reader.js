/**
 * 渲染进程 —— 阅读器 UI 逻辑
 *
 * 职责：
 * - 响应用户操作（打开文件、切换章节）
 * - API 设置管理
 * - 翻译调度 + 缓存读取
 * - 渲染双语段落到 DOM
 */

// ---- 工具函数 ----
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ---- 应用状态 ----
const state = {
  allParagraphs: [],       // 全书所有段落
  chapterList: [],         // [{ num, title, startIndex, count }]
  currentChapterNum: 1,
  metadata: null,
  fileToChapter: {},       // XHTML 文件名 → 章节号 映射
  apiConfig: {             // API 配置
    apiBaseUrl: 'https://api.openai.com',
    apiKey: '',
    modelName: 'gpt-4o-mini',
  },
  isTranslating: false,    // 翻译进行中
  stopRequested: false,     // 用户请求停止翻译
  annotations: [],          // 当前书的标注 [{paragraphId, type, startOffset, endOffset, ...}]
};

// ---- DOM 元素引用 ----
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const els = {
  // 书架
  shelfView: $('#shelfView'),
  shelfGrid: $('#shelfGrid'),
  shelfLoading: $('#shelfLoading'),
  btnBackToShelf: $('#btnBackToShelf'),

  // 阅读器
  readerView: $('#readerView'),
  bookTitle: $('#bookTitle'),
  paragraphsArea: $('#paragraphsArea'),
  pageNav: $('#pageNav'),
  btnPrevChapter: $('#btnPrevChapter'),
  btnNextChapter: $('#btnNextChapter'),
  pageNavInfo: $('#pageNavInfo'),
  statsBar: $('#statsBar'),
  statsText: $('#statsText'),
  chapterNav: $('#chapterNav'),
  chapterSelect: $('#chapterSelect'),
  chapterInfo: $('#chapterInfo'),

  // API 设置
  btnSettings: $('#btnSettings'),
  settingsModal: $('#settingsModal'),
  btnCloseSettings: $('#btnCloseSettings'),
  inputApiUrl: $('#inputApiUrl'),
  inputApiKey: $('#inputApiKey'),
  inputModelName: $('#inputModelName'),
  inputModelNameCustom: $('#inputModelNameCustom'),
  btnTestApi: $('#btnTestApi'),
  btnSaveSettings: $('#btnSaveSettings'),
  settingsMsg: $('#settingsMsg'),

  // 翻译
  btnTranslate: $('#btnTranslate'),
  btnTranslateAll: $('#btnTranslateAll'),
  btnStopTranslate: $('#btnStopTranslate'),

  // 标注
  annotationToolbar: $('#annotationToolbar'),
  contextMenu: $('#contextMenu'),
  notesOverlay: $('#notesOverlay'),
  notesPanel: $('#notesPanel'),
  notesPanelBody: $('#notesPanelBody'),
  btnCloseNotes: $('#btnCloseNotes'),
  commentPopover: $('#commentPopover'),
  commentPopoverText: $('#commentPopoverText'),
  btnClosePopover: $('#btnClosePopover'),
  commentModal: $('#commentModal'),
  commentQuote: $('#commentQuote'),
  commentTextarea: $('#commentTextarea'),
  btnSaveComment: $('#btnSaveComment'),

  // 字体 & 搜索
  btnFontDown: $('#btnFontDown'),
  btnFontUp: $('#btnFontUp'),
  btnToggleSearch: $('#btnToggleSearch'),
  searchBar: $('#searchBar'),
  searchInput: $('#searchInput'),
  searchInfo: $('#searchInfo'),
  btnSearchPrev: $('#btnSearchPrev'),
  btnSearchNext: $('#btnSearchNext'),
  btnSearchClose: $('#btnSearchClose'),
  btnCancelComment: $('#btnCancelComment'),
  btnCloseCommentModal: $('#btnCloseCommentModal'),
};

// ---- 初始化 ----
async function init() {
  // 返回书架
  els.btnBackToShelf.addEventListener('click', showShelf);

  // 加载书架 + 字号
  await initFontSize();
  await loadShelf();

  // 章节切换
  els.chapterSelect.addEventListener('change', async (e) => {
    const chapterNum = parseInt(e.target.value, 10);
    if (chapterNum) {
      state.currentChapterNum = chapterNum;
      await loadCachedTranslations();  // ★ 先加载该章翻译
      renderChapter(chapterNum);
    }
  });

  // ★ 拦截英文列中的链接点击（脚注 / 外部链接）
  els.paragraphsArea.addEventListener('click', handleLinkClick);

  // 章节翻页按钮
  els.btnPrevChapter.addEventListener('click', () => navigateChapter(-1));
  els.btnNextChapter.addEventListener('click', () => navigateChapter(1));

  // API 设置弹窗
  els.btnSettings.addEventListener('click', openSettings);
  els.btnCloseSettings.addEventListener('click', closeSettings);
  els.settingsModal.addEventListener('click', (e) => {
    if (e.target === els.settingsModal) closeSettings();
  });
  els.btnSaveSettings.addEventListener('click', saveSettings);
  els.btnTestApi.addEventListener('click', testApiConnection);

  // 预设按钮
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
  });

  // 模型下拉：选"自定义"时显示输入框
  els.inputModelName.addEventListener('change', () => {
    els.inputModelNameCustom.style.display =
      els.inputModelName.value === '__custom__' ? '' : 'none';
  });

  // 翻译按钮
  els.btnTranslate.addEventListener('click', translateCurrentChapter);
  els.btnTranslateAll.addEventListener('click', translateAllChapters);
  els.btnStopTranslate.addEventListener('click', stopTranslation);

  // 标注系统
  initAnnotationSystem();

  // 字体缩放
  els.btnFontUp.addEventListener('click', () => changeFontSize(1));
  els.btnFontDown.addEventListener('click', () => changeFontSize(-1));

  // 搜索
  els.btnToggleSearch.addEventListener('click', toggleSearch);
  els.btnSearchClose.addEventListener('click', closeSearch);
  els.searchInput.addEventListener('input', doSearch);
  els.searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') e.shiftKey ? searchPrev() : searchNext();
    if (e.key === 'Escape') closeSearch();
  });
  els.btnSearchPrev.addEventListener('click', searchPrev);
  els.btnSearchNext.addEventListener('click', searchNext);
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      if (els.readerView.style.display === 'block') toggleSearch();
    }
  });
}

// ---- 章节翻页 ----
async function navigateChapter(delta) {
  const chapters = state.chapterList;
  const currentIdx = chapters.findIndex(c => c.num === state.currentChapterNum);
  if (currentIdx === -1) return;

  const newIdx = currentIdx + delta;
  if (newIdx < 0 || newIdx >= chapters.length) return;

  const targetChapter = chapters[newIdx].num;
  state.currentChapterNum = targetChapter;
  await loadCachedTranslations();   // ★ 加载新章节的已有翻译
  renderChapter(targetChapter);
  els.chapterSelect.value = targetChapter;
}

// ---- API 预设 ----
const API_PRESETS = {
  openai:    { apiBaseUrl: 'https://api.openai.com',           modelName: 'gpt-4o-mini' },
  deepseek:  { apiBaseUrl: 'https://api.deepseek.com',         modelName: 'deepseek-chat' },
  qwen:      { apiBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode', modelName: 'qwen-turbo' },
  glm:       { apiBaseUrl: 'https://open.bigmodel.cn/api/paas/v4', modelName: 'glm-4-flash' },
};
// 注意：所有预设默认使用 Flash 级别模型（便宜够用，翻译首选）
//       如需更高质量翻译，可手动在下拉框中选择 Pro 级别模型

// ---- 设置弹窗 ----
async function openSettings() {
  els.settingsModal.style.display = 'flex';
  // 加载已保存的配置
  const saved = await window.electronAPI.loadSettings();
  if (saved) {
    state.apiConfig = {
      apiBaseUrl: saved.apiBaseUrl || 'https://api.openai.com',
      apiKey: saved.apiKey || '',
      modelName: saved.modelName || 'gpt-4o-mini',
    };
  }
  els.inputApiUrl.value = state.apiConfig.apiBaseUrl;
  els.inputApiKey.value = state.apiConfig.apiKey;

  // 模型名：先匹配预设选项，匹配不到就用自定义
  const modelSelect = els.inputModelName;
  const modelOpt = Array.from(modelSelect.options).find(o => o.value === state.apiConfig.modelName);
  if (modelOpt) {
    modelSelect.value = state.apiConfig.modelName;
    els.inputModelNameCustom.style.display = 'none';
  } else if (state.apiConfig.modelName) {
    modelSelect.value = '__custom__';
    els.inputModelNameCustom.style.display = '';
    els.inputModelNameCustom.value = state.apiConfig.modelName;
  }

  els.settingsMsg.textContent = '';

  // ★ 加载用量统计
  await loadUsageStats();
}

function closeSettings() {
  els.settingsModal.style.display = 'none';
}

// ---- 用量统计 ----
async function loadUsageStats() {
  const stats = await window.electronAPI.getApiUsageStats();
  const container = document.getElementById('usageStats');

  if (!stats || stats.length === 0) {
    container.innerHTML = '<p class="usage-empty">暂无统计数据（翻译后自动记录）</p>';
    return;
  }

  // 按 Key 分组
  const grouped = {};
  let grandTotal = 0;
  for (const s of stats) {
    const k = s.keyPrefix || '(未知)';
    if (!grouped[k]) grouped[k] = { rows: [], subTotal: 0 };
    grouped[k].rows.push(s);
    grouped[k].subTotal += s.totalTokens;
    grandTotal += s.totalTokens;
  }

  let html = '<table class="usage-table"><thead><tr><th>Key (前8位)</th><th>模型</th><th class="num">调用次数</th><th class="num">Token 消耗</th></tr></thead><tbody>';

  for (const [keyPrefix, group] of Object.entries(grouped)) {
    const rowSpan = group.rows.length;
    group.rows.forEach((s, i) => {
      html += '<tr>';
      if (i === 0) {
        html += `<td rowspan="${rowSpan}" style="vertical-align:top">🔑 ${escapeHtml(keyPrefix)}…</td>`;
      }
      html += `<td>${escapeHtml(s.model)}</td>`;
      html += `<td class="num">${s.calls} 次</td>`;
      html += `<td class="num">${formatTokens(s.totalTokens)}</td>`;
      html += '</tr>';
    });
  }

  html += '</tbody></table>';
  html += `<p class="usage-total">合计：${formatTokens(grandTotal)}</p>`;

  container.innerHTML = html;
}

function formatTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function applyPreset(preset) {
  const cfg = API_PRESETS[preset];
  if (!cfg) return;
  els.inputApiUrl.value = cfg.apiBaseUrl;

  // 模型名：匹配下拉选项
  const modelOpt = Array.from(els.inputModelName.options).find(o => o.value === cfg.modelName);
  if (modelOpt) {
    els.inputModelName.value = cfg.modelName;
    els.inputModelNameCustom.style.display = 'none';
  } else {
    els.inputModelName.value = '__custom__';
    els.inputModelNameCustom.style.display = '';
    els.inputModelNameCustom.value = cfg.modelName;
  }

  els.settingsMsg.textContent = `已填充 ${preset} 预设，请填写 API Key`;
  els.settingsMsg.className = 'settings-msg';
}

async function saveSettings() {
  const modelVal = els.inputModelName.value;
  const modelName = modelVal === '__custom__'
    ? els.inputModelNameCustom.value.trim()
    : modelVal;

  const config = {
    apiBaseUrl: els.inputApiUrl.value.trim(),
    apiKey: els.inputApiKey.value.trim(),
    modelName,
  };
  if (!config.apiKey) {
    els.settingsMsg.textContent = '请填写 API Key';
    els.settingsMsg.className = 'settings-msg error';
    return;
  }
  await window.electronAPI.saveSettings(config);
  state.apiConfig = config;
  els.settingsMsg.textContent = '设置已保存';
  els.settingsMsg.className = 'settings-msg success';
}

async function testApiConnection() {
  const modelVal = els.inputModelName.value;
  const modelName = modelVal === '__custom__'
    ? els.inputModelNameCustom.value.trim()
    : modelVal;

  const config = {
    apiBaseUrl: els.inputApiUrl.value.trim(),
    apiKey: els.inputApiKey.value.trim(),
    modelName,
  };
  els.settingsMsg.textContent = '正在测试连接...';
  els.settingsMsg.className = 'settings-msg';
  els.btnTestApi.disabled = true;

  const result = await window.electronAPI.testApiConnection(config);
  els.btnTestApi.disabled = false;
  els.settingsMsg.textContent = result.message;
  els.settingsMsg.className = result.success ? 'settings-msg success' : 'settings-msg error';
}

// ---- 翻译 ----
async function translateCurrentChapter() {
  if (state.isTranslating) return;
  if (!state.apiConfig.apiKey) {
    alert('请先在设置中配置 API Key');
    return;
  }

  const ch = state.chapterList.find(c => c.num === state.currentChapterNum);
  if (!ch) return;

  // 收集当前章节待翻译的段落
  const chapterParagraphs = state.allParagraphs
    .slice(ch.startIndex, ch.startIndex + ch.count)
    .filter(p => !p.zh && p.en.length > 2);

  if (chapterParagraphs.length === 0) {
    alert('当前章节已全部翻译完成');
    return;
  }

  state.isTranslating = true;
  try {
  const BATCH_SIZE = 8;

  for (let i = 0; i < chapterParagraphs.length; i += BATCH_SIZE) {
    const batch = chapterParagraphs.slice(i, i + BATCH_SIZE);

    // 更新 UI：显示翻译中
    for (const p of batch) {
      const row = document.getElementById(
        p.is_footnote && p.footnote_id ? p.footnote_id : p.id
      );
      if (row) {
        const zhCol = row.querySelector('.column-zh');
        if (zhCol) {
          zhCol.classList.remove('is-empty');
          zhCol.classList.add('is-translating');
          zhCol.textContent = '⏳ 翻译中...';
        }
      }
    }

    try {
      const result = await window.electronAPI.translateBatch(
        batch.map(p => ({ id: p.id, en: p.en })),
        state.apiConfig
      );

      if (result.success) {
        for (const r of result.results) {
          // 更新内存中的数据
          const para = state.allParagraphs.find(p => p.id === r.id);
          if (para) para.zh = r.zh;

          // 更新 DOM
          const row = document.getElementById(
            para.is_footnote && para.footnote_id ? para.footnote_id : para.id
          );
          if (row) {
            const zhCol = row.querySelector('.column-zh');
            if (zhCol) {
              zhCol.classList.remove('is-translating');
              zhCol.textContent = r.zh;
            }
          }
        }
      } else {
        // 翻译失败，恢复占位符
        for (const p of batch) {
          const row = document.getElementById(
            p.is_footnote && p.footnote_id ? p.footnote_id : p.id
          );
          if (row) {
            const zhCol = row.querySelector('.column-zh');
            if (zhCol) {
              zhCol.classList.remove('is-translating');
              zhCol.classList.add('is-empty');
              zhCol.textContent = '（翻译失败）';
            }
          }
        }
        console.error('翻译批处理失败:', result.error);
      }
    } catch (err) {
      console.error('翻译请求异常:', err);
    }

    // 批次间短暂延迟，避免触发 API 限流
    if (i + BATCH_SIZE < chapterParagraphs.length) {
      await new Promise(r => setTimeout(r, 800));
    }
  }

  } finally {
    state.isTranslating = false;
  }
  await updateStats();
  updatePageNav(state.currentChapterNum);
}

// ---- 翻译全书 ----
async function translateAllChapters() {
  if (state.isTranslating) return;
  if (!state.apiConfig.apiKey) {
    alert('请先在设置中配置 API Key');
    return;
  }

  const chapters = state.chapterList;
  if (chapters.length === 0) return;

  state.isTranslating = true;
  state.stopRequested = false;
  els.btnTranslateAll.style.display = 'none';
  els.btnTranslate.style.display = 'none';
  els.btnStopTranslate.style.display = '';
  els.btnStopTranslate.disabled = false;

  try {

  const BATCH_SIZE = 8;
  let totalTranslated = 0;
  let stopped = false;

  for (let ci = 0; ci < chapters.length; ci++) {
    if (state.stopRequested) { stopped = true; break; }

    const ch = chapters[ci];

    // ★ 先从数据库加载该章的缓存翻译，避免重复翻译
    state.currentChapterNum = ch.num;
    await loadCachedTranslations();

    // 收集该章待翻译段落（此时 p.zh 已从数据库填充）
    const chapterParagraphs = state.allParagraphs
      .slice(ch.startIndex, ch.startIndex + ch.count)
      .filter(p => !p.zh && p.en.length > 2);

    if (chapterParagraphs.length === 0) {
      els.chapterInfo.textContent = `[${ci + 1}/${chapters.length}] ${ch.title} (已缓存)`;
      continue;
    }

    // 切换到该章以显示译文
    renderChapter(ch.num);
    els.chapterSelect.value = ch.num;
    els.chapterInfo.textContent = `[${ci + 1}/${chapters.length}] 🔄 ${ch.title} 翻译中...`;

    await new Promise(r => setTimeout(r, 200));

    for (let i = 0; i < chapterParagraphs.length; i += BATCH_SIZE) {
      if (state.stopRequested) { stopped = true; break; }

      const batch = chapterParagraphs.slice(i, i + BATCH_SIZE);

      for (const p of batch) {
        const row = document.getElementById(
          p.is_footnote && p.footnote_id ? p.footnote_id : p.id
        );
        if (row) {
          const zhCol = row.querySelector('.column-zh');
          if (zhCol) {
            zhCol.classList.remove('is-empty');
            zhCol.classList.add('is-translating');
            zhCol.textContent = '⏳ 翻译中...';
          }
        }
      }

      try {
        const result = await window.electronAPI.translateBatch(
          batch.map(p => ({ id: p.id, en: p.en })),
          state.apiConfig
        );

        if (result.success) {
          for (const r of result.results) {
            const para = state.allParagraphs.find(p => p.id === r.id);
            if (para) para.zh = r.zh;

            const row = document.getElementById(
              para.is_footnote && para.footnote_id ? para.footnote_id : para.id
            );
            if (row) {
              const zhCol = row.querySelector('.column-zh');
              if (zhCol) {
                zhCol.classList.remove('is-translating');
                zhCol.textContent = r.zh;
              }
            }
          }
          totalTranslated += result.results.length;
        }
      } catch (err) {
        console.error('翻译失败:', err);
      }

      if (i + BATCH_SIZE < chapterParagraphs.length && !state.stopRequested) {
        await new Promise(r => setTimeout(r, 800));
      }
    }

    if (ci < chapters.length - 1 && !state.stopRequested) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  if (stopped) {
    els.chapterInfo.textContent = `⏸ 已停止（已完成 ${totalTranslated} 段），可再次点击继续`;
    await loadCachedTranslations();
    renderChapter(state.currentChapterNum);
  } else {
    els.chapterInfo.textContent = `✅ 全书翻译完成，共 ${totalTranslated} 段`;
  }

  await updateStats();
  updatePageNav(state.currentChapterNum);

  } finally {
    // ★ 无论成功、失败还是停止，始终恢复按钮
    state.isTranslating = false;
    state.stopRequested = false;
    els.btnTranslateAll.style.display = '';
    els.btnTranslate.style.display = '';
    els.btnStopTranslate.style.display = 'none';
    els.btnStopTranslate.textContent = '⏹ 停止翻译';
  }
}

function stopTranslation() {
  state.stopRequested = true;
  els.btnStopTranslate.disabled = true;
  els.btnStopTranslate.textContent = '⏳ 正在停止...';
}

// ---- 从数据库加载当前章节的已有翻译 ----
async function loadCachedTranslations() {
  if (!state.metadata) return;
  const bookId = state.metadata.title;
  const rows = await window.electronAPI.loadTranslations(bookId, state.currentChapterNum);

  for (const r of rows) {
    if (r.zh_text) {
      const para = state.allParagraphs.find(p => p.id === r.paragraph_id);
      if (para) para.zh = r.zh_text;
    }
  }
}

// ---- 链接点击处理 ----
async function handleLinkClick(e) {
  const link = e.target.closest('a');
  if (!link) return;

  const href = link.getAttribute('href');
  if (!href) return;

  e.preventDefault();

  // 外部链接（http / https）→ 系统浏览器打开
  if (href.startsWith('http://') || href.startsWith('https://')) {
    window.electronAPI.openExternal(href);
    return;
  }

  // 内部链接（如 cE8.xhtml#a6FK）→ 跳转到对应章节的精确锚点
  const [file, anchor] = href.split('#');
  const targetChapter = state.fileToChapter[file];
  if (targetChapter) {
    // 同一章节内跳转 → 直接滚动，无需重新渲染
    if (targetChapter === state.currentChapterNum && anchor) {
      const targetEl = document.getElementById(anchor);
      if (targetEl) {
        targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        targetEl.style.transition = 'background 0.3s';
        targetEl.style.background = 'rgba(74, 124, 89, 0.15)';
        setTimeout(() => { targetEl.style.background = ''; }, 1500);
      }
      return;
    }

    state.currentChapterNum = targetChapter;
    await loadCachedTranslations();       // ★ 先加载该章翻译
    renderChapter(targetChapter, anchor);  // ★ 传递锚点，精确滚动到对应尾注
    els.chapterSelect.value = targetChapter;
  }
}

// ---- 书架 ----
async function loadShelf() {
  const books = await window.electronAPI.listBooks();

  els.shelfGrid.innerHTML = '';

  // 渲染已有书籍
  for (const book of books) {
    const card = document.createElement('div');
    card.className = 'book-card';
    card.style.position = 'relative';
    card.addEventListener('click', () => openBookFromShelf(book));
    card.addEventListener('contextmenu', (e) => showBookContextMenu(e, book));

    // ★ 删除按钮
    const delBtn = document.createElement('button');
    delBtn.className = 'book-card-delete';
    delBtn.textContent = '✕';
    delBtn.title = '删除此书';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();  // 阻止触发卡片点击
      if (confirm(`确定删除「${book.title}」？\n翻译缓存也会一并清除。`)) {
        window.electronAPI.deleteBook(book.id);
        loadShelf(); // 刷新书架
      }
    });
    card.appendChild(delBtn);

    // 封面
    const cover = document.createElement('div');
    cover.className = 'book-card-cover';
    if (book.coverPath) {
      const coverUrl = await window.electronAPI.getCoverUrl(book.coverPath);
      if (coverUrl) {
        cover.innerHTML = `<img src="${coverUrl}" alt="${escapeHtml(book.title)}">`;
      } else {
        cover.textContent = '📖';
      }
    } else {
      cover.textContent = '📖';
    }
    card.appendChild(cover);

    // 书名 + 作者
    const info = document.createElement('div');
    info.className = 'book-card-info';
    info.innerHTML = `
      <div class="book-card-title">${escapeHtml(book.title)}</div>
      <div class="book-card-author">${escapeHtml(book.author)}</div>
    `;
    card.appendChild(info);

    els.shelfGrid.appendChild(card);
  }

  // 添加新书按钮（始终在最后）
  const addCard = document.createElement('div');
  addCard.className = 'book-card-add';
  addCard.innerHTML = '<span class="add-icon">+</span><span class="add-label">导入新书</span>';
  addCard.addEventListener('click', handleOpenBook);
  els.shelfGrid.appendChild(addCard);
}

async function openBookFromShelf(book) {
  // 复用已有数据或重新解析
  els.shelfLoading.style.display = 'block';
  els.shelfGrid.style.display = 'none';

  const result = await window.electronAPI.parseEpub(book.filePath);
  if (!result.success) {
    alert('打开失败：' + result.error);
    els.shelfLoading.style.display = 'none';
    els.shelfGrid.style.display = '';
    return;
  }

  state.allParagraphs = result.paragraphs;
  state.metadata = result.metadata;
  state.fileToChapter = {};
  for (const p of result.paragraphs) {
    if (p.xhtml_file && !state.fileToChapter[p.xhtml_file]) {
      state.fileToChapter[p.xhtml_file] = p.chapter;
    }
  }
  buildChapterList();

  // ★ 先确定要打开的章节，再加载翻译（修复首次打开翻译不显示）
  const saved = await window.electronAPI.loadSettings();
  const lastChapter = (saved && saved.lastBookId === state.metadata.title)
    ? parseInt(saved.lastChapter, 10) || 1 : 1;
  state.currentChapterNum = lastChapter;
  await loadCachedTranslations();

  // ★ 加载该书的标注
  state.annotations = await window.electronAPI.getAnnotations(state.metadata.title);

  populateChapterSelect();
  await updateStats();

  // 切换到阅读器视图
  els.shelfView.style.display = 'none';
  els.readerView.style.display = 'block';
  els.btnBackToShelf.style.display = '';
  setReaderToolsVisible(true);
  els.bookTitle.textContent = state.metadata.title;
  els.pageNav.style.display = 'flex';
  els.statsBar.style.display = 'block';
  els.chapterNav.style.display = 'flex';

  els.shelfLoading.style.display = 'none';
  els.shelfGrid.style.display = '';

  renderChapter(lastChapter);
}

function setReaderToolsVisible(visible) {
  const display = visible ? '' : 'none';
  document.querySelectorAll('.reader-only').forEach(el => el.style.display = display);
}

function showShelf() {
  els.readerView.style.display = 'none';
  els.btnBackToShelf.style.display = 'none';
  els.bookTitle.textContent = '';
  els.pageNav.style.display = 'none';
  els.statsBar.style.display = 'none';
  els.chapterNav.style.display = 'none';
  els.searchBar.style.display = 'none';
  els.shelfView.style.display = 'block';
  setReaderToolsVisible(false);
  state.allParagraphs = [];
  state.chapterList = [];
  state.metadata = null;
  loadShelf(); // 刷新书架
}

// ---- 打开书籍（从文件对话框导入新书）----
async function handleOpenBook() {
  const result = await window.electronAPI.openFileDialog();
  if (!result.success || result.canceled) return;

  // 显示加载状态
  showLoading();

  // 让主进程解析 EPUB
  const parseResult = await window.electronAPI.parseEpub(result.filePath);
  if (!parseResult.success) {
    alert('解析 EPUB 失败：' + parseResult.error);
    hideLoading();
    return;
  }

  // 保存状态
  state.allParagraphs = parseResult.paragraphs;
  state.metadata = parseResult.metadata;

  // ★ 构建 XHTML 文件名 → 章节号 映射（脚注跳转用）
  state.fileToChapter = {};
  for (const p of parseResult.paragraphs) {
    if (p.xhtml_file && !state.fileToChapter[p.xhtml_file]) {
      state.fileToChapter[p.xhtml_file] = p.chapter;
    }
  }

  buildChapterList();

  // 切换到阅读器视图
  els.shelfView.style.display = 'none';
  els.readerView.style.display = 'block';
  els.btnBackToShelf.style.display = '';
  setReaderToolsVisible(true);
  els.bookTitle.textContent = state.metadata.title;
  els.pageNav.style.display = 'flex';
  els.statsBar.style.display = 'block';
  els.chapterNav.style.display = 'flex';

  // ★ 先确定要打开的章节，再加载翻译和标注（修复首次打开翻译不显示）
  const saved = await window.electronAPI.loadSettings();
  const lastChapter = (saved && saved.lastBookId === state.metadata.title)
    ? parseInt(saved.lastChapter, 10) || 1 : 1;
  state.currentChapterNum = lastChapter;
  await loadCachedTranslations();

  // ★ 加载该书的标注
  state.annotations = await window.electronAPI.getAnnotations(state.metadata.title);

  renderChapter(lastChapter);
  populateChapterSelect();
  await updateStats();
}

// ---- 构建章节列表 ----
function buildChapterList() {
  const chapters = [];
  let currentChapter = null;

  for (let i = 0; i < state.allParagraphs.length; i++) {
    const p = state.allParagraphs[i];
    if (currentChapter === null || p.chapter !== currentChapter.num) {
      if (currentChapter) {
        currentChapter.count = i - currentChapter.startIndex;
      }
      currentChapter = {
        num: p.chapter,
        title: p.chapter_title,
        startIndex: i,
        count: 0,
      };
      chapters.push(currentChapter);
    }
  }
  // 最后一个章节
  if (currentChapter) {
    currentChapter.count = state.allParagraphs.length - currentChapter.startIndex;
  }

  state.chapterList = chapters;
}

// ---- 填充章节下拉框 ----
function populateChapterSelect() {
  els.chapterSelect.innerHTML = '';
  for (const ch of state.chapterList) {
    const opt = document.createElement('option');
    opt.value = ch.num;
    opt.textContent = `第 ${ch.num} 章：${ch.title}`;
    els.chapterSelect.appendChild(opt);
  }
}

// ---- 渲染指定章节 ----
// anchorId: 可选的尾注锚点（如 "a6FK"），渲染后自动滚动到该位置
function renderChapter(chapterNum, anchorId) {
  const ch = state.chapterList.find(c => c.num === chapterNum);
  if (!ch) return;

  const chapterParagraphs = state.allParagraphs.slice(
    ch.startIndex,
    ch.startIndex + ch.count
  );

  els.paragraphsArea.innerHTML = '';

  let prevWasFootnote = false;

  for (const p of chapterParagraphs) {
    const row = document.createElement('div');

    // 样式类名
    const classes = ['bilingual-row'];
    if (p.is_heading) classes.push('is-heading');
    if (p.is_footnote) {
      classes.push('is-footnote');
      // ★ 尾注块首条（前一段不是尾注）加分隔线
      if (!prevWasFootnote) {
        classes.push('first-in-block');
      }
    }
    row.className = classes.join(' ');
    prevWasFootnote = p.is_footnote;

    // ★ 尾注行用 footnote_id 作为 DOM id（锚点定位用）
    //    普通行用 paragraph id。所有行加 data-pid 用于标注定位
    row.id = p.is_footnote && p.footnote_id ? p.footnote_id : p.id;
    row.setAttribute('data-pid', p.id);

    // 英文列 —— 始终用 en_html（保留链接），标注后续打在 DOM 上
    const colEn = document.createElement('div');
    colEn.className = 'column-en';
    colEn.innerHTML = p.en_html || escapeHtml(p.en);

    // 中文列
    const colZh = document.createElement('div');
    colZh.className = 'column-zh';
    if (p.zh) {
      colZh.textContent = p.zh;
    } else {
      colZh.classList.add('is-empty');
      colZh.textContent = '（待翻译）';
    }

    row.appendChild(colEn);
    row.appendChild(colZh);
    els.paragraphsArea.appendChild(row);
  }

  // 更新导航信息
  els.chapterSelect.value = chapterNum;
  els.chapterInfo.textContent = `${ch.count} 个段落`;
  state.currentChapterNum = chapterNum;

  // ★ 保存阅读进度
  if (state.metadata) {
    window.electronAPI.saveSettings({
      lastBookId: state.metadata.title,
      lastChapter: String(chapterNum),
    });
  }

  // ★ 更新上一页/下一页按钮状态
  updatePageNav(chapterNum);

  // ★ 滚动到锚点位置（尾注链接跳转）或页面顶部
  if (anchorId) {
    const targetEl = document.getElementById(anchorId);
    if (targetEl) {
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // 短暂高亮目标行
      targetEl.style.transition = 'background 0.3s';
      targetEl.style.background = 'rgba(74, 124, 89, 0.15)';
      setTimeout(() => { targetEl.style.background = ''; }, 1500);
    }
  } else {
    els.paragraphsArea.scrollIntoView({ behavior: 'smooth' });
  }

  // ★ 渲染完成后在 DOM 上打标注
  const rows = els.paragraphsArea.querySelectorAll('.bilingual-row');
  rows.forEach(row => {
    const paraId = row.getAttribute('data-pid');
    const colEn = row.querySelector('.column-en');
    if (paraId && colEn) applyAnnotationsToDOM(colEn, paraId);
  });
}

// ---- 更新翻页按钮状态 ----
function updatePageNav(chapterNum) {
  const chapters = state.chapterList;
  const currentIdx = chapters.findIndex(c => c.num === chapterNum);

  // 上一章按钮：第一章时禁用
  els.btnPrevChapter.disabled = (currentIdx <= 0);

  // 下一章按钮：最后一章时禁用
  els.btnNextChapter.disabled = (currentIdx >= chapters.length - 1);

  // 章节信息：如 "第 6 / 114 章"
  els.pageNavInfo.textContent = `第 ${currentIdx + 1} / ${chapters.length} 章`;
}

// ---- 更新统计信息 ----
async function updateStats() {
  const total = state.allParagraphs.length;
  const chapters = state.chapterList.length;
  // ★ 从数据库查真实翻译数，而非内存中当前章的 zh
  let translated = 0;
  if (state.metadata) {
    const progress = await window.electronAPI.getTranslationProgress(state.metadata.title);
    translated = progress.translated;
  }
  const pct = total > 0 ? ((translated / total) * 100).toFixed(1) : '0.0';
  els.statsText.textContent =
    `共 ${chapters} 章 · ${total} 段 · 已翻译 ${translated} 段（${pct}%）`;
}

// ---- UI 状态切换 ----
function showLoading() {
  els.shelfGrid.style.display = 'none';
  els.shelfLoading.style.display = 'block';
}

function hideLoading() {
  els.shelfGrid.style.display = '';
  els.shelfLoading.style.display = 'none';
}

// ================================================================
// 字体缩放 & 搜索
// ================================================================

let fontSizeLevel = 2; // 0-4 五档
const FONT_SIZES_EN  = [0.85, 0.95, 1.05, 1.2, 1.4];
const FONT_SIZES_ZH = [0.8, 0.9, 1.0, 1.15, 1.35];

function changeFontSize(delta) {
  fontSizeLevel = Math.max(0, Math.min(4, fontSizeLevel + delta));
  document.documentElement.style.setProperty('--font-size-en', FONT_SIZES_EN[fontSizeLevel] + 'rem');
  document.documentElement.style.setProperty('--font-size-zh', FONT_SIZES_ZH[fontSizeLevel] + 'rem');
  // ★ 持久化字号
  window.electronAPI.saveSettings({ fontSize: String(fontSizeLevel) });
}

// 初始化字号（从设置恢复）
async function initFontSize() {
  const saved = await window.electronAPI.loadSettings();
  fontSizeLevel = parseInt(saved.fontSize, 10) || 2;
  changeFontSize(0);
}

let searchResults = [];
let searchIdx = -1;

function toggleSearch() {
  if (els.searchBar.style.display === 'none' || !els.searchBar.style.display) {
    els.searchBar.style.display = 'flex';
    els.searchInput.focus();
    if (els.searchInput.value) doSearch();
  } else {
    closeSearch();
  }
}

function closeSearch() {
  els.searchBar.style.display = 'none';
  els.searchInput.value = '';
  clearSearchHighlights();
  searchResults = [];
  searchIdx = -1;
}

function doSearch() {
  clearSearchHighlights();
  searchResults = [];
  searchIdx = -1;

  const query = els.searchInput.value.trim().toLowerCase();
  if (!query || !state.allParagraphs.length) {
    els.searchInfo.textContent = '';
    return;
  }

  // 遍历所有段落，找匹配
  for (const p of state.allParagraphs) {
    const enIdx = p.en.toLowerCase().indexOf(query);
    const zhIdx = p.zh ? p.zh.toLowerCase().indexOf(query) : -1;
    if (enIdx >= 0 || zhIdx >= 0) {
      searchResults.push({ paragraphId: p.id, chapter: p.chapter });
    }
  }

  if (searchResults.length === 0) {
    els.searchInfo.textContent = '无匹配';
    return;
  }

  searchIdx = 0;
  updateSearchInfo();
  highlightCurrentSearch();
}

function clearSearchHighlights() {
  els.paragraphsArea.querySelectorAll('.search-highlight').forEach(el => {
    el.replaceWith(el.textContent);
  });
  els.paragraphsArea.normalize();
}

async function highlightCurrentSearch() {
  clearSearchHighlights();
  if (searchIdx < 0 || searchIdx >= searchResults.length) return;

  const result = searchResults[searchIdx];
  // 跳转到对应章节
  if (state.currentChapterNum !== result.chapter) {
    state.currentChapterNum = result.chapter;
    await loadCachedTranslations();
    renderChapter(result.chapter);
    els.chapterSelect.value = result.chapter;
  }

  // 高亮匹配文字
  requestAnimationFrame(() => {
    const query = els.searchInput.value.trim().toLowerCase();
    const row = document.getElementById(result.paragraphId) ||
                els.paragraphsArea.querySelector(`[data-pid="${result.paragraphId}"]`);
    if (!row) return;

    const colEn = row.querySelector('.column-en');
    const colZh = row.querySelector('.column-zh');
    [colEn, colZh].forEach(col => {
      if (!col) return;
      highlightTextInNode(col, query);
    });

    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}

function highlightTextInNode(container, query) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);

  for (const node of nodes) {
    const text = node.textContent;
    const idx = text.toLowerCase().indexOf(query);
    if (idx < 0) continue;

    const range = document.createRange();
    range.setStart(node, idx);
    range.setEnd(node, idx + query.length);

    const mark = document.createElement('mark');
    mark.className = 'search-highlight';
    try { range.surroundContents(mark); } catch (_) {}
  }
}

function searchNext() {
  if (!searchResults.length) return;
  searchIdx = (searchIdx + 1) % searchResults.length;
  updateSearchInfo();
  highlightCurrentSearch();
}

function searchPrev() {
  if (!searchResults.length) return;
  searchIdx = (searchIdx - 1 + searchResults.length) % searchResults.length;
  updateSearchInfo();
  highlightCurrentSearch();
}

function updateSearchInfo() {
  if (!searchResults.length) { els.searchInfo.textContent = ''; return; }
  els.searchInfo.textContent = `${searchIdx + 1} / ${searchResults.length}`;
}

// ================================================================
// 标注系统
// ================================================================

let lastSelectionRange = null;
let pendingCommentTarget = null;  // ★ 评论弹窗期间保留选区信息

function initAnnotationSystem() {
  // 文本选择 → 弹出工具栏
  document.addEventListener('mouseup', (e) => {
    setTimeout(() => {
      // ★ 评论弹窗 / 设置弹窗打开时不弹出工具栏
      if (els.commentModal.style.display === 'flex') return;
      if (els.settingsModal.style.display === 'flex') return;

      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        hideAnnotationToolbar();
        return;
      }
      // 只在英文列内选择时才显示
      const enCol = sel.anchorNode?.parentElement?.closest('.column-en');
      if (!enCol) { hideAnnotationToolbar(); return; }

      // 获取段落行元素
      const row = enCol.closest('.bilingual-row');
      if (!row) return;

      lastSelectionRange = { row };
      showAnnotationToolbar(e.clientX, e.clientY);
    }, 10);
  });

  // 点击工具栏外 → 关闭
  document.addEventListener('mousedown', (e) => {
    if (!els.annotationToolbar.contains(e.target)) {
      hideAnnotationToolbar();
    }
  });

  // 工具栏按钮
  els.annotationToolbar.querySelectorAll('button[data-type]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const type = btn.dataset.type;
      if (type === 'comment') {
        showCommentModal();
      } else {
        captureAnnotation(type);
      }
    });
  });

  // 评论弹窗：打开 & 关闭 & 保存
  els.btnSaveComment.addEventListener('click', () => {
    const text = els.commentTextarea.value.trim();
    els.commentModal.style.display = 'none';
    captureAnnotation('comment', text);
  });
  const closeCommentModal = () => {
    els.commentModal.style.display = 'none';
    els.commentTextarea.value = '';
    pendingCommentTarget = null;
    window.getSelection().removeAllRanges();  // 清除选区，防止工具栏弹出
  };
  els.btnCancelComment.addEventListener('click', closeCommentModal);
  els.btnCloseCommentModal.addEventListener('click', closeCommentModal);
  els.commentModal.addEventListener('click', (e) => {
    if (e.target === els.commentModal) closeCommentModal();
  });

  // 关闭笔记面板
  els.btnCloseNotes.addEventListener('click', closeNotesView);
  els.notesOverlay.addEventListener('click', closeNotesView);

  // 生词本

  // 右键菜单全局关闭
  document.addEventListener('click', () => { els.contextMenu.style.display = 'none'; });

  // 点击评论标记 → 弹出卡片；右键标注 → 删除
  els.paragraphsArea.addEventListener('click', (e) => {
    const annEl = e.target.closest?.('.ann-comment');
    if (annEl) {
      e.stopPropagation();
      showCommentPopover(annEl, e.clientX, e.clientY);
      return;
    }
    // 点击其他地方关闭评论卡片
    if (!e.target.closest?.('.comment-popover')) {
      hideCommentPopover();
    }
  });

  // 关闭评论卡片
  els.btnClosePopover.addEventListener('click', hideCommentPopover);

  els.paragraphsArea.addEventListener('contextmenu', (e) => {
    const annEl = e.target.closest?.('.ann-highlight, .ann-underline, .ann-bold, .ann-comment');
    if (!annEl) return;
    e.preventDefault();
    e.stopPropagation();

    const annIds = (annEl.dataset.annId || '').split(',').map(Number).filter(Boolean);
    if (!annIds.length) return;

    // 从所有标注中找对应的，用于显示类型
    const matched = state.annotations.filter(a => annIds.includes(a.id));
    const typeLabels = { highlight: '🖍高亮', underline: '〰波浪线', bold: '𝐁加粗', comment: '💬评论' };
    const items = matched.map(a =>
      `<button class="context-menu-item danger" data-delid="${a.id}">🗑 删除 ${typeLabels[a.type] || a.type}</button>`
    ).join('');

    const menu = els.contextMenu;
    menu.innerHTML = items;
    menu.style.display = 'block';
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';

    menu.querySelectorAll('button').forEach(btn => {
      btn.onclick = async () => {
        const delId = parseInt(btn.dataset.delid, 10);
        menu.style.display = 'none';
        await window.electronAPI.deleteAnnotation(delId);
        state.annotations = state.annotations.filter(a => a.id !== delId);

        // ★ 解包标注 span，保留内部文字，然后重新渲染当前章
        const parent = annEl.parentNode;
        while (annEl.firstChild) {
          parent.insertBefore(annEl.firstChild, annEl);
        }
        parent.removeChild(annEl);
        parent.normalize();
      };
    });

    setTimeout(() => {
      const closeMenu = () => { menu.style.display = 'none'; document.removeEventListener('click', closeMenu); };
      document.addEventListener('click', closeMenu);
    }, 0);
  });
}

// ---- 工具栏显示/隐藏 ----
function showAnnotationToolbar(x, y) {
  const tb = els.annotationToolbar;
  tb.style.display = 'flex';
  tb.style.left = x + 'px';
  tb.style.top = y + 'px';
}

function hideAnnotationToolbar() {
  els.annotationToolbar.style.display = 'none';
  lastSelectionRange = null;
}

// ---- 捕获标注 ----
// commentText: 仅 comment 类型使用，由评论输入框传入
async function captureAnnotation(type, commentText) {
  // ★ 评论通过 pendingCommentTarget，其他标注通过 lastSelectionRange
  const source = (type === 'comment' && pendingCommentTarget)
    ? pendingCommentTarget
    : lastSelectionRange;
  if (!source || !state.metadata) return;

  const { row } = source;
  const paraId = row.getAttribute('data-pid');
  if (!paraId) return;

  const para = state.allParagraphs.find(p => p.id === paraId);
  if (!para) return;

  // ★ 评论用预存的偏移量（选区已失效），其他标注用 DOM Range 实时计算
  let startOffset, endOffset;
  if (type === 'comment' && pendingCommentTarget) {
    startOffset = pendingCommentTarget.startOffset;
    endOffset = pendingCommentTarget.endOffset;
  } else {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const enCol = row.querySelector('.column-en');
    if (!enCol) return;

    const preRange = document.createRange();
    preRange.selectNodeContents(enCol);
    preRange.setEnd(range.startContainer, range.startOffset);
    startOffset = preRange.toString().length;
    endOffset = startOffset + sel.toString().length;
  }

  // 边界检查
  if (startOffset < 0 || endOffset > para.en.length || startOffset >= endOffset) return;

  const color = type === 'highlight' ? '#ffeb3b' : type === 'underline' ? '#e67e22' : '#333';
  const comment = commentText || '';

  const ann = {
    bookId: state.metadata.title,
    paragraphId: paraId,
    startOffset,
    endOffset,
    type,
    color,
    comment,
  };

  await window.electronAPI.saveAnnotation(ann);
  pendingCommentTarget = null;  // ★ 评论保存成功，清除暂存

  // ★ 重新加载标注（获取数据库生成的 id）
  state.annotations = await window.electronAPI.getAnnotations(state.metadata.title);

  hideAnnotationToolbar();
  window.getSelection().removeAllRanges();

  // ★ 只重建当前段落的英文列 DOM，不重渲染整章
  const colEn = row.querySelector('.column-en');
  if (colEn) {
    colEn.innerHTML = para.en_html || escapeHtml(para.en);
    applyAnnotationsToDOM(colEn, para.id);
  }
}

// ---- 标注应用到 DOM（事件点分段，逐段 re-walk 避免节点失效）----
function applyAnnotationsToDOM(containerEl, paragraphId) {
  const anns = state.annotations.filter(a => a.paragraphId === paragraphId);
  if (anns.length === 0) return;

  // 1. 计算非重叠分段（事件点算法）
  const events = [];
  anns.forEach(ann => {
    events.push({ pos: ann.startOffset, type: 'start', ann });
    events.push({ pos: ann.endOffset,   type: 'end',   ann });
  });
  events.sort((a, b) => a.pos - b.pos || (a.type === 'end' ? -1 : 1));

  const segments = [];
  let cursor = 0;
  const active = [];

  for (const evt of events) {
    if (evt.pos > cursor) {
      segments.push({ start: cursor, end: evt.pos, activeAnns: [...active] });
      cursor = evt.pos;
    }
    if (evt.type === 'start') active.push(evt.ann);
    else active.splice(active.findIndex(a => a.id === evt.ann.id), 1);
  }

  // 2. ★ 逐段处理，每段重新 walk 文本节点（避免 surroundContents 后节点失效）
  for (const seg of segments) {
    if (seg.activeAnns.length === 0) continue;
    wrapSegmentFresh(containerEl, seg);
  }
}

function wrapSegmentFresh(containerEl, seg) {
  // ★ 每次都重新收集文本节点
  const textNodes = [];
  const walker = document.createTreeWalker(containerEl, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  let cumLen = 0;
  for (const node of textNodes) {
    const nodeLen = node.textContent.length;
    const nodeEnd = cumLen + nodeLen;

    if (seg.start >= nodeEnd) { cumLen = nodeEnd; continue; }
    if (seg.end <= cumLen) break;

    const localStart = Math.max(0, seg.start - cumLen);
    const localEnd = Math.min(nodeLen, seg.end - cumLen);

    if (localStart < localEnd) {
      const range = document.createRange();
      range.setStart(node, localStart);
      range.setEnd(node, localEnd);

      const span = buildAnnotationSpan(seg.activeAnns);
      try {
        range.surroundContents(span);
        // ★ surroundContents 成功后立即返回，下一次调用会重新 walk
        return;
      } catch (_) { /* 跨元素边界 */ }
    }
    cumLen = nodeEnd;
  }
}

function buildAnnotationSpan(activeAnns) {
  const span = document.createElement('span');
  const classes = [];
  let commentText = '';
  let hasBold = false;

  for (const ann of activeAnns) {
    switch (ann.type) {
      case 'highlight': classes.push('ann-highlight'); break;
      case 'underline': classes.push('ann-underline'); break;
      case 'bold': hasBold = true; break;
      case 'comment':
        classes.push('ann-comment');
        if (ann.comment) commentText = ann.comment;
        break;
    }
  }

  span.className = classes.join(' ');
  if (hasBold) span.style.fontWeight = '700';
  if (commentText) { span.dataset.comment = commentText; span.title = commentText; }

  // ★ 所有标注 ID 存到 DOM 上，用于删除
  span.dataset.annId = activeAnns.map(a => a.id).join(',');

  return span;
}

function escapeAttr(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---- 右键菜单（书架卡片）----
function showBookContextMenu(e, book) {
  e.preventDefault();
  e.stopPropagation();

  const menu = els.contextMenu;
  menu.innerHTML = `
    <button class="context-menu-item" data-action="open">📖 开始阅读</button>
    <button class="context-menu-item" data-action="notes">📝 查看笔记</button>
    <button class="context-menu-item" data-action="export-bilingual">📖 导出双语 EPUB</button>
    <button class="context-menu-item" data-action="export-original">📄 导出原版副本</button>
    <button class="context-menu-item danger" data-action="delete">🗑 删除图书</button>
  `;
  menu.style.display = 'block';
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';

  // 点击菜单项
  menu.querySelectorAll('button').forEach(btn => {
    btn.onclick = async () => {
      menu.style.display = 'none';
      const action = btn.dataset.action;
      if (action === 'open') openBookFromShelf(book);
      else if (action === 'notes') showNotesView(book);
      else if (action === 'export-bilingual' || action === 'export-original') {
        const mode = action === 'export-bilingual' ? 'bilingual' : 'original';
        // 获取翻译数据：如果当前没加载这本书，先加载
        let paragraphs = state.allParagraphs;
        if (!state.metadata || state.metadata.title !== book.id) {
          const result = await window.electronAPI.parseEpub(book.filePath);
          if (result.success) paragraphs = result.paragraphs;
        }
        // 补充 zh：从数据库加载
        const rows = await window.electronAPI.loadTranslations(book.id, 1);
        // 需要加载全书翻译 — 简化处理：直接用 state.allParagraphs（如果当前已加载）
        const exportResult = await window.electronAPI.exportEpub(
          book.filePath, mode, state.allParagraphs.length > 0 ? state.allParagraphs : paragraphs
        );
        if (exportResult.success) {
          alert('导出成功！\n' + exportResult.path);
        } else if (!exportResult.canceled) {
          alert('导出失败：' + (exportResult.error || '未知错误'));
        }
      }
      else if (action === 'delete') {
        if (confirm(`确定删除「${book.title}」？\n所有翻译缓存和笔记也会一并清除。`)) {
          window.electronAPI.deleteBook(book.id);
          state.annotations = [];
          loadShelf();
        }
      }
    };
  });

  // 点击其他地方关闭
  setTimeout(() => {
    const closeMenu = () => { menu.style.display = 'none'; document.removeEventListener('click', closeMenu); };
    document.addEventListener('click', closeMenu);
  }, 0);
}

// ---- 笔记查看面板 ----
async function showNotesView(book) {
  const annotations = await window.electronAPI.getAnnotations(book.id);
  const body = els.notesPanelBody;

  if (annotations.length === 0) {
    body.innerHTML = '<p class="note-empty">📭 暂无笔记</p>';
    els.notesOverlay.style.display = 'block';
    els.notesPanel.style.display = 'flex';
    return;
  }

  // 如果当前没加载这本书，先加载段落数据
  if (!state.metadata || state.metadata.title !== book.id) {
    els.notesPanelBody.innerHTML = '<p class="note-empty">⏳ 加载中...</p>';
    els.notesOverlay.style.display = 'block';
    els.notesPanel.style.display = 'flex';

    const result = await window.electronAPI.parseEpub(book.filePath);
    if (result.success) {
      state.allParagraphs = result.paragraphs;
      state.metadata = result.metadata;
      state.fileToChapter = {};
      for (const p of result.paragraphs) {
        if (p.xhtml_file && !state.fileToChapter[p.xhtml_file]) {
          state.fileToChapter[p.xhtml_file] = p.chapter;
        }
      }
      buildChapterList();
      state.annotations = annotations;
    }
  }

  // 构建章节标题映射
  const chapterMap = {};
  state.allParagraphs.forEach(p => { if (!chapterMap[p.chapter]) chapterMap[p.chapter] = p.chapter_title; });

  // 按章节分组
  const grouped = {};
  for (const a of annotations) {
    const chNum = a.paragraphId?.match(/c(\d+)_/) ? parseInt(a.paragraphId.match(/c(\d+)_/)[1]) : 0;
    if (!grouped[chNum]) grouped[chNum] = { title: chapterMap[chNum] || `第 ${chNum} 章`, items: [] };
    grouped[chNum].items.push(a);
  }

  const typeLabel = { highlight: '🖍', underline: '〰', bold: '𝐁', comment: '💬' };

  let html = '';
  for (const [chNum, group] of Object.entries(grouped).sort((a,b) => parseInt(a[0])-parseInt(b[0]))) {
    html += `<div style="font-weight:600;margin-top:1rem;margin-bottom:0.3rem;font-size:0.85rem;color:#333;">${group.title}</div>`;
    for (const a of group.items) {
      const para = state.allParagraphs.find(p => p.id === a.paragraphId);
      const excerpt = para
        ? para.en.substring(a.startOffset, Math.min(a.endOffset, a.startOffset + 100))
        : '(原文未加载)';
      const dots = para && (a.endOffset - a.startOffset) > 100 ? '…' : '';

      html += `<div class="note-item" data-chapter="${chNum}" data-annid="${a.id}">
        <div class="note-item-main">
          <div class="note-chapter">${typeLabel[a.type] || a.type} ${escapeHtml(excerpt)}${dots}</div>
          ${a.comment ? `<div class="note-comment">💬 ${escapeHtml(a.comment)}</div>` : ''}
        </div>
        <button class="note-item-del" data-delid="${a.id}" title="删除此笔记">✕</button>
      </div>`;
    }
  }

  body.innerHTML = html;

  // 点击笔记项 → 跳转阅读器；点击删除按钮 → 删除该笔记
  body.querySelectorAll('.note-item-del').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const delId = parseInt(btn.dataset.delid, 10);
      if (!delId) return;
      await window.electronAPI.deleteAnnotation(delId);
      state.annotations = state.annotations.filter(a => a.id !== delId);
      // 从面板中移除该项
      btn.closest('.note-item')?.remove();
      // 如果当前在阅读器，刷新显示
      if (state.metadata && els.readerView.style.display !== 'none') {
        renderChapter(state.currentChapterNum);
      }
    });
  });

  body.querySelectorAll('.note-item').forEach(item => {
    item.addEventListener('click', async () => {
      const chNum = parseInt(item.dataset.chapter, 10);
      if (!chNum) return;
      closeNotesView();

      // 切换到阅读器视图
      els.shelfView.style.display = 'none';
      els.readerView.style.display = 'block';
      els.btnBackToShelf.style.display = '';
      setReaderToolsVisible(true);
      els.bookTitle.textContent = state.metadata.title;
      els.pageNav.style.display = 'flex';
      els.statsBar.style.display = 'block';
      els.chapterNav.style.display = 'flex';

      state.currentChapterNum = chNum;
      await loadCachedTranslations();
      renderChapter(chNum);
      els.chapterSelect.value = chNum;
      await updateStats();
    });
  });

  els.notesOverlay.style.display = 'block';
  els.notesPanel.style.display = 'flex';
}

function closeNotesView() {
  els.notesOverlay.style.display = 'none';
  els.notesPanel.style.display = 'none';
}

// ---- 评论弹出卡片 ----
function showCommentPopover(annEl, x, y) {
  const comment = annEl.dataset.comment || '';
  els.commentPopoverText.textContent = comment;
  els.commentPopover.style.display = 'block';
  els.commentPopover.style.left = Math.min(x, window.innerWidth - 340) + 'px';
  els.commentPopover.style.top = (y + 12) + 'px';
}

function hideCommentPopover() {
  els.commentPopover.style.display = 'none';
}

function showCommentModal() {
  // ★ 立即计算偏移量（此时选区有效），存入 pendingCommentTarget
  const sel = window.getSelection();
  const row = lastSelectionRange?.row;
  if (!sel || sel.isCollapsed || !row) return;

  const paraId = row.getAttribute('data-pid');
  const enCol = row.querySelector('.column-en');
  if (!paraId || !enCol) return;

  const range = sel.getRangeAt(0);
  const preRange = document.createRange();
  preRange.selectNodeContents(enCol);
  preRange.setEnd(range.startContainer, range.startOffset);
  const startOffset = preRange.toString().length;
  const endOffset = startOffset + sel.toString().length;

  pendingCommentTarget = { row, startOffset, endOffset };
  hideAnnotationToolbar();

  const selectedText = sel.toString().trim();
  els.commentQuote.textContent = `"${selectedText}"`;
  els.commentTextarea.value = '';
  els.commentModal.style.display = 'flex';
  setTimeout(() => els.commentTextarea.focus(), 100);
}

// ---- 启动 ----
init();
