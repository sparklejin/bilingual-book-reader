/**
 * Electron 主进程入口
 *
 * 职责：
 * - 创建应用窗口
 * - 处理来自渲染进程的 IPC 请求
 * - 管理本地数据库（sql.js）
 * - 所有文件 / 网络 / 敏感操作都在这里完成
 */

const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const PROJECT_DIR = path.join(__dirname, 'bilingual book reading project');
const { parseEpubToParagraphs, getEpubMetadata, extractCover } = require(
  path.join(PROJECT_DIR, 'src/parser/epubParser')
);
const { translateBatch, testConnection } = require(
  path.join(PROJECT_DIR, 'src/translator/translator')
);
const dbModule = require(
  path.join(PROJECT_DIR, 'src/database/db')
);
const initSqlJs = require('sql.js');

let mainWindow = null;
const DATA_DIR = path.join(app.getPath('userData'), 'data');
let dbReady = false;

// ============================================================
// 数据库初始化
// ============================================================
async function initDatabase() {
  try {
    await dbModule.openDatabase(DATA_DIR);
    dbReady = true;
  } catch (err) {
    console.error('数据库初始化失败:', err.message);
  }
}

// ============================================================
// 窗口创建
// ============================================================
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'Bilingual Book Reader',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),  // preload 在根目录
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(PROJECT_DIR, 'renderer', 'index.html'));

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
}

// ============================================================
// IPC：解析 EPUB + 写入数据库
// ============================================================
ipcMain.handle('parse-epub', async (_event, filePath) => {
  try {
    const metadata = getEpubMetadata(filePath);
    const paragraphs = parseEpubToParagraphs(filePath);
    const bookId = metadata.title;

    // 写入数据库（段落缓存 + 书籍信息 + 封面）
    if (dbReady) {
      dbModule.insertParagraphs(paragraphs, bookId);

      // 提取封面
      const coverPath = extractCover(filePath, DATA_DIR);

      // 保存书籍到书架
      const chapters = new Set(paragraphs.map(p => p.chapter)).size;
      dbModule.insertBook({
        id: bookId,
        title: metadata.title,
        author: metadata.author,
        filePath: filePath,
        coverPath: coverPath || '',
        totalChapters: chapters,
        totalParagraphs: paragraphs.length,
      });

      dbModule.saveToDisk(DATA_DIR);
    }

    return {
      success: true,
      metadata,
      paragraphs,
      totalParagraphs: paragraphs.length,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ============================================================
// IPC：打开文件对话框
// ============================================================
ipcMain.handle('open-file-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择 EPUB 电子书',
    filters: [{ name: 'EPUB 电子书', extensions: ['epub'] }],
    properties: ['openFile'],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { success: false, canceled: true };
  }
  return { success: true, filePath: result.filePaths[0] };
});

// ============================================================
// IPC：打开外部链接
// ============================================================
ipcMain.handle('open-external', async (_event, url) => {
  if (url.startsWith('http://') || url.startsWith('https://')) {
    await shell.openExternal(url);
  }
});

// ============================================================
// IPC：用户配置（API 设置）
// ============================================================
ipcMain.handle('save-settings', async (_event, settings) => {
  if (!dbReady) return { success: false, error: '数据库未就绪' };
  for (const [key, value] of Object.entries(settings)) {
    dbModule.setSetting(key, value);
  }
  dbModule.saveToDisk(DATA_DIR);
  return { success: true };
});

ipcMain.handle('load-settings', async () => {
  if (!dbReady) return { apiBaseUrl: '', apiKey: '', modelName: '' };
  return {
    ...dbModule.getApiConfig(),
    lastBookId: dbModule.getSetting('lastBookId', ''),
    lastChapter: dbModule.getSetting('lastChapter', ''),
  };
});

// ============================================================
// IPC：翻译
// ============================================================
ipcMain.handle('translate-batch', async (_event, paragraphs, apiConfig) => {
  try {
    const { translations, usage } = await translateBatch(paragraphs, apiConfig);

    // 写入数据库缓存
    if (dbReady) {
      for (const r of translations) {
        dbModule.updateTranslation(r.id, r.zh);
      }
      // ★ 记录 API token 用量
      if (usage) {
        dbModule.logApiUsage(apiConfig.apiKey, apiConfig.modelName, usage);
      }
      dbModule.saveToDisk(DATA_DIR);
    }

    return { success: true, results: translations, usage };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('test-api-connection', async (_event, apiConfig) => {
  return await testConnection(apiConfig);
});

// ============================================================
// IPC：从数据库加载已有的翻译
// ============================================================
ipcMain.handle('load-translations', async (_event, bookId, chapterNum) => {
  if (!dbReady) return [];
  const rows = dbModule.getChapterParagraphs(bookId, chapterNum);
  return rows.map(r => ({
    paragraph_id: r.paragraph_id,
    zh_text: r.zh_text || '',
  }));
});

// ============================================================
// IPC：获取翻译进度
// ============================================================
ipcMain.handle('get-translation-progress', async (_event, bookId) => {
  if (!dbReady) return { total: 0, translated: 0 };
  return dbModule.getTranslationProgress(bookId);
});

// ============================================================
// IPC：EPUB 导出
// ============================================================
ipcMain.handle('export-epub', async (_event, epubPath, mode, paragraphs) => {
  try {
    const { exportBilingualEpub, exportOriginalEpub } = require(
      path.join(PROJECT_DIR, 'src/exporter/epubExporter')
    );

    const defaultName = path.basename(epubPath, '.epub');
    const suffix = mode === 'bilingual' ? '_双语版' : '_副本';
    const ext = '.epub';

    const result = await dialog.showSaveDialog(mainWindow, {
      title: mode === 'bilingual' ? '导出双语 EPUB' : '导出 EPUB 副本',
      defaultPath: defaultName + suffix + ext,
      filters: [{ name: 'EPUB 电子书', extensions: ['epub'] }],
    });

    if (result.canceled || !result.filePath) return { success: false, canceled: true };

    if (mode === 'bilingual') {
      // ★ 从数据库加载所有翻译，填入 zh 字段
      const meta = getEpubMetadata(epubPath);
      for (const p of paragraphs) {
        if (dbReady) {
          const rows = dbModule.getChapterParagraphs(meta.title, p.chapter);
          const found = rows.find(r => r.paragraph_id === p.id);
          if (found?.zh_text) p.zh = found.zh_text;
        }
      }
      exportBilingualEpub(epubPath, result.filePath, paragraphs);
    } else {
      exportOriginalEpub(epubPath, result.filePath);
    }

    return { success: true, path: result.filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ============================================================
// IPC：笔记 / 标注
// ============================================================
ipcMain.handle('save-annotation', async (_event, annotation) => {
  if (!dbReady) return;
  dbModule.saveAnnotation(annotation);
  dbModule.saveToDisk(DATA_DIR);
});

ipcMain.handle('get-annotations', async (_event, bookId) => {
  if (!dbReady) return [];
  return dbModule.getAnnotations(bookId);
});

ipcMain.handle('delete-annotation', async (_event, id) => {
  if (!dbReady) return;
  dbModule.deleteAnnotation(id);
  dbModule.saveToDisk(DATA_DIR);
});

// ============================================================
// IPC：书架管理
// ============================================================
ipcMain.handle('list-books', async () => {
  if (!dbReady) return [];
  return dbModule.getAllBooks();
});

ipcMain.handle('get-cover-url', async (_event, coverPath) => {
  // 返回 cover-file:// 协议的 URL，直接读取文件，无需 base64
  if (!coverPath || !fs.existsSync(coverPath)) return null;
  // 将文件路径编码为 URL 安全格式
  return `cover-file://${encodeURIComponent(coverPath)}`;
});

ipcMain.handle('delete-book', async (_event, bookId) => {
  if (!dbReady) return;
  dbModule.deleteBook(bookId);
  dbModule.saveToDisk(DATA_DIR);
});

// ============================================================
// IPC：获取 API 用量统计
// ============================================================
ipcMain.handle('get-api-usage-stats', async () => {
  if (!dbReady) return [];
  return dbModule.getUsageStats();
});

// ============================================================
// 自定义协议：cover-file:// → 本地文件读取
// ============================================================
protocol.registerSchemesAsPrivileged([
  { scheme: 'cover-file', privileges: { bypassCSP: true, stream: true, supportFetchAPI: true } },
]);

// ============================================================
// 应用生命周期
// ============================================================
app.whenReady().then(async () => {
  // 注册 cover-file:// 协议处理器
  protocol.handle('cover-file', (request) => {
    const filePath = decodeURIComponent(request.url.replace('cover-file://', ''));
    return net.fetch(`file:///${filePath}`);
  });
  await initDatabase();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (dbReady) {
    dbModule.closeDatabase(DATA_DIR);
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
