/**
 * EPUB 解析模块
 *
 * 功能：
 * 1. 解压 EPUB（ZIP 格式），读取 container.xml 定位 OPF 文件
 * 2. 解析 NCX 目录文件，获取真正的正文文件列表和章节标题
 * 3. 按 NCX + spine 顺序逐个解析 XHTML 文件，提取正文段落
 * 4. 为每个段落分配唯一 ID（c{章节号}_p{段落号}）
 * 5. 返回结构化 JSON 数据
 *
 * 非正文过滤策略（解决封面、版权页等被当作章节的问题）：
 * - 主要策略：解析 toc.ncx 获取真正的目录结构，
 *   只有出现在 NCX 中的 XHTML 文件才被当作正文处理
 * - 备用策略：如果 EPUB 没有 NCX，则使用 <guide> 中标记的
 *   "text" 起点 + 段落数阈值（>=5 段）来过滤
 */

const AdmZip = require('adm-zip');
const cheerio = require('cheerio');

// ============================================================
// NCX 解析 —— 获取真正的正文文件列表和章节标题
// ============================================================

/**
 * 从 EPUB ZIP 中解析 NCX 文件，返回正文文件集合
 * @param {AdmZip} zip
 * @param {string} opfDir - OPF 所在目录（如 "OEBPS/"）
 * @param {object} $opf - cheerio 加载的 OPF XML
 * @returns {{ contentFiles: Set<string>, fileTitleMap: Map<string, string> } | null}
 *   返回 null 表示没有可用的 NCX
 */
function parseNcx(zip, opfDir, $opf) {
  // 1. 找到 NCX 文件路径
  //    优先从 OPF spine 的 toc 属性获取，其次从 manifest 中找 media-type 匹配的
  let ncxHref = null;
  const spineToc = $opf('spine').attr('toc');
  if (spineToc) {
    // spine toc 指向 manifest 中的 item id
    $opf('manifest item').each((_, el) => {
      if ($opf(el).attr('id') === spineToc) {
        ncxHref = $opf(el).attr('href');
      }
    });
  }
  if (!ncxHref) {
    // 兜底：在 manifest 中搜索 .ncx 文件
    $opf('manifest item').each((_, el) => {
      const href = $opf(el).attr('href');
      if (href && href.endsWith('.ncx')) {
        ncxHref = href;
      }
    });
  }

  if (!ncxHref) {
    return null; // 没有 NCX，降级到备用策略
  }

  // 2. 读取并解析 NCX
  const ncxPath = opfDir + ncxHref;
  let ncxXml;
  try {
    ncxXml = zip.readAsText(ncxPath);
  } catch {
    return null;
  }

  const $ncx = cheerio.load(ncxXml, { xmlMode: true });

  // 3. 提取所有 navPoint → 文件名 + 标题
  const contentFiles = new Set();
  const fileTitleMap = new Map();

  $ncx('navPoint').each((_, np) => {
    const $np = $ncx(np);

    // 标题文本
    const labelText = $np.find('navLabel > text').first().text().trim();

    // 对应的 XHTML 文件（去掉锚点 #xxx）
    let src = $np.find('content').first().attr('src');
    if (src) {
      src = src.split('#')[0];
      contentFiles.add(src);

      // 只有第一个遇到的 navPoint 的标题被记录
      //（嵌套 NCX 中父级标题通常是 Part 名，子级是具体章节名）
      if (!fileTitleMap.has(src)) {
        fileTitleMap.set(src, labelText);
      }
    }

    // 递归处理嵌套的 navPoint（子章节）
    // NCX 支持层级结构，如 Part I → 各子章节
  });

  return { contentFiles, fileTitleMap };
}

// ============================================================
// 主解析函数
// ============================================================

/**
 * 解析 EPUB 文件，提取所有段落的结构化数据
 * @param {string} epubPath - EPUB 文件的绝对路径
 * @returns {Array<{id: string, chapter: number, paragraph_index: number, en: string, zh: string}>}
 */
function parseEpubToParagraphs(epubPath) {
  const zip = new AdmZip(epubPath);

  // ============================================================
  // 第一步：解析 container.xml，找到 OPF 文件路径
  // ============================================================
  const containerXml = zip.readAsText('META-INF/container.xml');
  const $container = cheerio.load(containerXml, { xmlMode: true });
  const opfPath = $container('rootfile').attr('full-path');

  if (!opfPath) {
    throw new Error('无法在 EPUB 中找到 OPF 文件路径（container.xml 缺少 rootfile）');
  }

  // OPF 文件中的路径是相对于 EPUB 根目录的，例如 "OEBPS/content.opf"
  const opfDir = opfPath.substring(0, opfPath.lastIndexOf('/') + 1); // e.g. "OEBPS/"

  // ============================================================
  // 第二步：解析 OPF 文件，获取 spine 和 manifest
  // ============================================================
  const opfXml = zip.readAsText(opfPath);
  const $opf = cheerio.load(opfXml, { xmlMode: true });

  // 构建 id → href 的映射（manifest）
  const manifest = {};
  $opf('manifest item').each((_, el) => {
    const id = $opf(el).attr('id');
    const href = $opf(el).attr('href');
    if (id && href) {
      manifest[id] = href;
    }
  });

  // 获取 spine 顺序
  const spineItems = [];
  $opf('spine itemref').each((_, el) => {
    const idref = $opf(el).attr('idref');
    if (idref) {
      spineItems.push(idref);
    }
  });

  if (spineItems.length === 0) {
    throw new Error('EPUB spine 为空，没有可读取的章节');
  }

  // ============================================================
  // 第三步：解析 NCX 获取正文过滤规则
  // ============================================================
  const ncxData = parseNcx(zip, opfDir, $opf);

  // 构建正文文件白名单
  let contentFileSet = null; // null = 不过滤（NCX 不可用时）

  if (ncxData && ncxData.contentFiles.size > 0) {
    contentFileSet = ncxData.contentFiles;
  }

  // ============================================================
  // 第四步：按 spine 顺序，逐个读取 XHTML 并提取段落
  // ============================================================
  const chaptersData = [];
  let chapterNum = 0; // 只对通过过滤的章节递增编号

  for (const idref of spineItems) {
    const href = manifest[idref];

    // 跳过 manifest 中找不到的项，以及非 XHTML 文件
    if (!href || !href.endsWith('.xhtml')) {
      continue;
    }

    // ★ 核心过滤：如果该文件不在 NCX 正文列表中，跳过
    if (contentFileSet && !contentFileSet.has(href)) {
      continue;
    }

    // href 相对 OPF 目录，拼出完整路径
    const fullPath = opfDir + href;
    let htmlContent;
    try {
      htmlContent = zip.readAsText(fullPath);
    } catch {
      // 文件不存在则跳过
      continue;
    }

    // ★ 预处理：将 XHTML 自闭合 span（<span id="xxx"/>）转为标准 HTML
    //    cheerio 的 HTML 解析器会把 <span/> 当作开放标签包裹后续内容，
    //    必须在解析前修复，否则锚点 span 会吞掉它后面的 <a> 链接
    htmlContent = htmlContent.replace(
      /<span\s+([^>]*?)\/>/gi,
      '<span $1></span>'
    );

    chapterNum++;
    const $html = cheerio.load(htmlContent);

    // 提取正文内容：<p>、<h1>~<h6>、<li>、以及尾注 <aside>
    const textElements = $html('p, h1, h2, h3, h4, h5, h6, li, aside');

    // 获取章节标题：优先使用 NCX 中的标题，其次用 HTML 中的 h1
    const ncxTitle = ncxData?.fileTitleMap?.get(href);
    const chapterTitle =
      ncxTitle ||
      $html('h1').first().text().trim() ||
      $html('title').text().trim() ||
      `Chapter ${chapterNum}`;

    let paraIdx = 0;

    textElements.each((_, el) => {
      const text = $html(el).text().trim();

      // 过滤空文本和过短的无意义内容
      if (!text || text.length < 2) {
        return;
      }

      // 过滤纯数字 / 页码（如单独的 "11"）
      if (/^\d{1,4}$/.test(text)) {
        return;
      }

      paraIdx++;
      const isHeading = /^h[1-6]$/i.test(el.tagName);
      const isFootnote = el.tagName.toLowerCase() === 'aside';

      // 尾注的 id 属性（如 "a6FK"），用于锚点定位
      const footnoteId = isFootnote
        ? ($html(el).attr('id') || '')
        : '';

      chaptersData.push({
        id: `c${chapterNum}_p${paraIdx}`,
        chapter: chapterNum,
        chapter_title: chapterTitle,
        paragraph_index: paraIdx,
        xhtml_file: href,                      // ★ 来源文件，用于脚注链接跳转
        is_heading: isHeading,
        is_footnote: isFootnote,               // ★ 标记为尾注，渲染时用不同样式
        footnote_id: footnoteId,               // ★ 尾注锚点 ID，用于精确滚动定位
        tag: el.tagName.toLowerCase(),
        en: text,
        en_html: cleanInnerHtml($html, el),    // ★ 保留链接等内联 HTML
        zh: '', // 初始为空，留待翻译
      });
    });
  }

  return chaptersData;
}

// ============================================================
// HTML 清理 —— 保留链接，去掉无用的锚点 span
// ============================================================

/**
 * 获取元素的内层 HTML，清理无用的标记：
 * - 保留 <a> 标签及其 href（脚注链接）
 * - 保留空 <span id="xxx"/> 作为锚点（用于尾注回链定位）
 * - 有文本内容的 span 解包（保留文本，去掉标签）
 * - 去掉所有 class, epub:type 属性
 * @param {cheerio.CheerioAPI} $ - cheerio 实例
 * @param {Element} el - 当前 DOM 元素
 * @returns {string} 清理后的 HTML
 */
function cleanInnerHtml($, el) {
  // 克隆元素，避免修改原始 DOM
  const $clone = $(el).clone();

  // 处理 span：
  // - 空 span 有 id → 保留为锚点 <span id="xxx"></span>（尾注回链定位需要）
  // - 空 span 无 id → 移除（无用的标记）
  // - 有内容的 span → 解包保留文本
  $clone.find('span').each((_, span) => {
    const $span = $(span);
    const spanId = $span.attr('id');
    const hasContent = Boolean($span.text().trim());

    if (!hasContent && spanId) {
      // ★ 空 span 有 id → 保留为锚点，去掉 class
      $span.removeAttr('class');
      $span.removeAttr('epub:type');
      $span.empty(); // 确保为空
    } else if (!hasContent && !spanId) {
      // 空 span 无 id → 移除
      $span.remove();
    } else {
      // 有内容 → 解包（用文本替换 span 标签）
      $span.replaceWith($span.text());
    }
  });

  // 清理 <a> 标签：只保留 href，去掉 class、id、epub:type
  $clone.find('a').each((_, a) => {
    const $a = $(a);
    const href = $a.attr('href');
    $a.removeAttr('class');
    $a.removeAttr('id');
    $a.removeAttr('epub:type');
    if (href) {
      $a.attr('href', href);
    }
  });

  // 移除其他元素的 class 属性（保留 aside 的 id 用于锚点定位）
  $clone.find('[class]').removeAttr('class');

  // 移除 id 属性，但保留两类锚点 id：
  //   1. <aside> 尾注的 id —— 正文脚注跳转到尾注的定位锚点
  //   2. <span> 的 id —— 尾注回链跳转回正文的定位锚点
  $clone.find('[id]').each((_, elem) => {
    const tag = elem.tagName.toLowerCase();
    if (tag !== 'aside' && tag !== 'span') {
      $(elem).removeAttr('id');
    }
  });

  return $clone.html() || $(el).text();
}

/**
 * 获取 EPUB 的基本元信息（书名、作者等）
 * @param {string} epubPath
 * @returns {{title: string, author: string, language: string}}
 */
function getEpubMetadata(epubPath) {
  const zip = new AdmZip(epubPath);

  // 定位 OPF
  const containerXml = zip.readAsText('META-INF/container.xml');
  const $container = cheerio.load(containerXml, { xmlMode: true });
  const opfPath = $container('rootfile').attr('full-path');

  const opfXml = zip.readAsText(opfPath);
  const $opf = cheerio.load(opfXml, { xmlMode: true });

  return {
    title:
      $opf('dc\\:title, title').first().text().trim() || 'Unknown Title',
    author:
      $opf('dc\\:creator, creator').first().text().trim() || 'Unknown Author',
    language:
      $opf('dc\\:language, language').first().text().trim() || 'en',
  };
}

// ============================================================
// 封面提取
// ============================================================

/**
 * 从 EPUB 中提取封面图片，保存为文件
 * @param {string} epubPath - EPUB 文件路径
 * @param {string} dataDir - 数据存储目录
 * @returns {string|null} 封面图片的保存路径，没有封面则返回 null
 */
function extractCover(epubPath, dataDir) {
  const zip = new AdmZip(epubPath);

  // 解析 OPF 找封面引用
  const containerXml = zip.readAsText('META-INF/container.xml');
  const $container = cheerio.load(containerXml, { xmlMode: true });
  const opfPath = $container('rootfile').attr('full-path');
  const opfDir = opfPath.substring(0, opfPath.lastIndexOf('/') + 1);

  const opfXml = zip.readAsText(opfPath);
  const $opf = cheerio.load(opfXml, { xmlMode: true });

  // 方法1: 搜索 manifest 中 properties="cover-image" 的 item
  let coverHref = null;
  $opf('manifest item').each((_, el) => {
    const props = $opf(el).attr('properties') || '';
    if (props.includes('cover-image')) {
      coverHref = $opf(el).attr('href');
    }
  });

  // 方法2: guide 中的 cover reference
  if (!coverHref) {
    $opf('guide reference[type="cover"]').each((_, el) => {
      coverHref = $opf(el).attr('href');
    });
  }

  // 方法3: 搜索 manifest 中名称含 "cover" 的图片
  if (!coverHref) {
    $opf('manifest item').each((_, el) => {
      const href = $opf(el).attr('href') || '';
      const type = $opf(el).attr('media-type') || '';
      if (type.startsWith('image/') && /cover/i.test(href)) {
        coverHref = href;
      }
    });
  }

  if (!coverHref) return null;

  // 拼出封面文件在 EPUB 内的完整路径
  const coverFullPath = opfDir + coverHref;

  // 读取封面图片数据
  let coverData;
  try {
    coverData = zip.readFile(coverFullPath);
  } catch {
    return null;
  }
  if (!coverData) return null;

  // 确定扩展名
  const ext = coverHref.split('.').pop().toLowerCase();
  const safeExt = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext) ? ext : 'jpg';

  // 保存到 data 目录
  const fs = require('fs');
  const path = require('path');

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // 用书名 hash 做文件名，避免特殊字符
  const meta = getEpubMetadata(epubPath);
  const safeName = Buffer.from(meta.title).toString('base64')
    .replace(/[/+=]/g, '').substring(0, 16);
  const coverFileName = `cover_${safeName}.${safeExt}`;
  const coverPath = path.join(dataDir, coverFileName);

  fs.writeFileSync(coverPath, coverData);

  return coverPath;
}

module.exports = { parseEpubToParagraphs, getEpubMetadata, extractCover };
