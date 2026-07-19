/**
 * EPUB 导出模块
 *
 * 两种模式：
 * - 'original': 原样复制 EPUB
 * - 'bilingual': 原文 + 中文译文隔行穿插，生成双语 EPUB
 *
 * 双语导出使用字符串操作（非 cheerio DOM），保持 XHTML 格式原样不变，
 * 避免 cheerio.html() 序列化导致的 XHTML 损坏问题。
 */

const AdmZip = require('adm-zip');
const fs = require('fs');

const ZH_CSS = `\n<style>
/* === Bilingual Reader === */
.zh-translation {
  font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif;
  font-size: 0.95em; color: #555; line-height: 1.8;
  margin: 0.3em 0 0.8em 0; padding-left: 0.5em;
  border-left: 3px solid #4a7c59;
}
</style>\n`;

/**
 * 在原始 XHTML 字符串中插入译文
 * 遍历 <p>, <h1>-<h6>, <li>, <aside> 等文本标签，
 * 按顺序匹配 paragraph_index，在其闭合标签后插入译文
 */
function insertTranslations(xhtmlStr, chapterParas) {
  // 匹配文本标签及其内容（非贪婪）
  const tagPattern = /<(p|h[1-6]|li|aside)\b([^>]*?)>(.*?)<\/\1>/gis;
  const result = { html: xhtmlStr, count: 0 };
  const modified = xhtmlStr.replace(tagPattern, (match, tag, attrs, inner) => {
    const text = inner.replace(/<[^>]+>/g, '').trim();
    if (!text || text.length < 2 || /^\d{1,4}$/.test(text)) return match;

    result.count++;
    const para = chapterParas.find(p => p.paragraph_index === result.count);
    if (!para || !para.zh) return match;

    // 在闭合标签后插入译文 div
    const zhHtml = `<div class="zh-translation">${escapeXml(para.zh)}</div>`;
    return match + zhHtml;
  });

  return { html: modified, count: result.count };
}

function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * 导出双语 EPUB
 */
function exportBilingualEpub(epubPath, outputPath, paragraphs) {
  const zip = new AdmZip(epubPath);

  // 1. 找到 OPF 和 spine（解析 XML 只用 cheerio，不影响 XHTML 文件）
  const cheerio = require('cheerio');
  const containerXml = zip.readAsText('META-INF/container.xml');
  const opfPath = cheerio.load(containerXml, { xmlMode: true })('rootfile').attr('full-path');
  const opfDir = opfPath.substring(0, opfPath.lastIndexOf('/') + 1);

  const opfXml = zip.readAsText(opfPath);
  const $opf = cheerio.load(opfXml, { xmlMode: true });

  const manifest = {};
  $opf('manifest item').each((_, el) => { manifest[$opf(el).attr('id')] = $opf(el).attr('href'); });

  const spineOrder = [];
  $opf('spine itemref').each((_, el) => {
    const href = manifest[$opf(el).attr('idref')];
    if (href?.endsWith('.xhtml')) spineOrder.push(href);
  });

  // 2. 按 xhtml_file 分组段落
  const xhtmlParas = {};
  for (const p of paragraphs) {
    if (!p.xhtml_file) continue;
    if (!xhtmlParas[p.xhtml_file]) xhtmlParas[p.xhtml_file] = [];
    xhtmlParas[p.xhtml_file].push(p);
  }

  // 3. 遍历 spine，字符串操作插入译文
  for (const href of spineOrder) {
    const fullPath = opfDir + href;
    let htmlContent;
    try { htmlContent = zip.readAsText(fullPath); }
    catch { continue; }

    const chapterParas = xhtmlParas[href];
    if (!chapterParas?.length) continue;

    // 用字符串替换插入译文
    const { html: modified, count } = insertTranslations(htmlContent, chapterParas);
    if (count === 0) continue;

    // 注入 CSS（在 </head> 前）
    let outputHtml = modified.replace('</head>', ZH_CSS + '</head>');

    zip.updateFile(fullPath, Buffer.from(outputHtml));
  }

  // 4. 写文件
  zip.writeZip(outputPath);
}

function exportOriginalEpub(epubPath, outputPath) {
  fs.copyFileSync(epubPath, outputPath);
}

module.exports = { exportBilingualEpub, exportOriginalEpub };
