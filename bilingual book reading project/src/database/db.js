/**
 * 本地数据库模块
 *
 * 使用 sql.js（WebAssembly 编译的 SQLite），无需原生编译，纯 JS 运行。
 * 存储翻译缓存和用户配置，支持离线阅读。
 */

const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

let db = null;

// ============================================================
// 数据库初始化
// ============================================================

/**
 * 打开/创建数据库文件
 * @param {string} dataDir - 数据目录路径
 * @returns {Promise<Database>}
 */
async function openDatabase(dataDir) {
  if (db) return db;

  // 确保数据目录存在
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const dbPath = path.join(dataDir, 'data.db');

  // 初始化 sql.js
  const SQL = await initSqlJs();

  // 如果数据库文件已存在，读取它；否则创建新的
  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  // 创建表结构
  db.run(`
    CREATE TABLE IF NOT EXISTS bilingual_book (
      paragraph_id TEXT PRIMARY KEY,
      book_id      TEXT,
      chapter_num  INTEGER,
      para_index   INTEGER,
      en_text      TEXT,
      zh_text      TEXT,
      status       INTEGER DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS books (
      id              TEXT PRIMARY KEY,
      title           TEXT,
      author          TEXT,
      file_path       TEXT,
      cover_path      TEXT,
      total_chapters  INTEGER DEFAULT 0,
      total_paragraphs INTEGER DEFAULT 0,
      imported_at     TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS annotations (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id         TEXT,
      paragraph_id    TEXT,
      start_offset    INTEGER,
      end_offset      INTEGER,
      type            TEXT,        -- 'highlight' | 'underline' | 'bold' | 'comment'
      comment_text    TEXT DEFAULT '',
      color           TEXT DEFAULT '#ffeb3b',
      created_at      TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS api_usage (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      api_key_prefix  TEXT,       -- API Key 前 8 位（区分不同 Key）
      model           TEXT,       -- 模型名称
      prompt_tokens   INTEGER,
      completion_tokens INTEGER,
      total_tokens    INTEGER,
      created_at      TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `);

  return db;
}

// ============================================================
// 数据持久化到磁盘
// ============================================================

function saveToDisk(dataDir) {
  if (!db) return;
  const dbPath = path.join(dataDir, 'data.db');
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(dbPath, buffer);
}

// ============================================================
// 段落翻译缓存操作
// ============================================================

/**
 * 批量插入段落（首次导入书籍时调用）
 * @param {Array} paragraphs - 段落数据数组
 * @param {string} bookId - 书籍标识
 */
function insertParagraphs(paragraphs, bookId) {
  if (!db) throw new Error('数据库未初始化');

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO bilingual_book
      (paragraph_id, book_id, chapter_num, para_index, en_text, zh_text, status)
    VALUES (?, ?, ?, ?, ?, ?, 0)
  `);

  for (const p of paragraphs) {
    stmt.run([p.id, bookId, p.chapter, p.paragraph_index, p.en, '']);
  }
  stmt.free();
}

/**
 * 获取某章节所有段落（含翻译状态）
 * @param {string} bookId
 * @param {number} chapterNum
 * @returns {Array}
 */
function getChapterParagraphs(bookId, chapterNum) {
  if (!db) return [];

  const stmt = db.prepare(
    'SELECT * FROM bilingual_book WHERE book_id = ? AND chapter_num = ? ORDER BY para_index'
  );
  const rows = [];
  stmt.bind([bookId, chapterNum]);
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

/**
 * 更新段落的中文译文
 * @param {string} paragraphId
 * @param {string} zhText
 */
function updateTranslation(paragraphId, zhText) {
  if (!db) return;
  db.run(
    'UPDATE bilingual_book SET zh_text = ?, status = 2 WHERE paragraph_id = ?',
    [zhText, paragraphId]
  );
}

/**
 * 获取待翻译的段落（status = 0）
 * @param {string} bookId
 * @param {number} limit - 每次取的数量
 * @returns {Array}
 */
function getUntranslatedParagraphs(bookId, limit = 10) {
  if (!db) return [];

  const stmt = db.prepare(
    `SELECT * FROM bilingual_book
     WHERE book_id = ? AND status = 0 AND zh_text = ''
     ORDER BY chapter_num, para_index
     LIMIT ?`
  );
  stmt.bind([bookId, limit]);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

/**
 * 获取翻译进度统计
 * @param {string} bookId
 * @returns {{total: number, translated: number}}
 */
function getTranslationProgress(bookId) {
  if (!db) return { total: 0, translated: 0 };

  const total = db.exec(
    'SELECT COUNT(*) as count FROM bilingual_book WHERE book_id = ?',
    [bookId]
  );
  const translated = db.exec(
    'SELECT COUNT(*) as count FROM bilingual_book WHERE book_id = ? AND status = 2',
    [bookId]
  );

  return {
    total: total[0]?.values[0]?.[0] || 0,
    translated: translated[0]?.values[0]?.[0] || 0,
  };
}

// ============================================================
// 用户配置操作
// ============================================================

/**
 * 保存配置项
 * @param {string} key
 * @param {string} value
 */
function setSetting(key, value) {
  if (!db) return;
  db.run(
    'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
    [key, value]
  );
}

/**
 * 读取配置项
 * @param {string} key
 * @param {string} defaultValue
 * @returns {string}
 */
function getSetting(key, defaultValue = '') {
  if (!db) return defaultValue;
  const result = db.exec('SELECT value FROM settings WHERE key = ?', [key]);
  if (result.length > 0 && result[0].values.length > 0) {
    return result[0].values[0][0];
  }
  return defaultValue;
}

/**
 * 获取所有 API 配置
 * @returns {{apiBaseUrl: string, apiKey: string, modelName: string}}
 */
function getApiConfig() {
  return {
    apiBaseUrl: getSetting('apiBaseUrl', 'https://api.openai.com'),
    apiKey: getSetting('apiKey', ''),
    modelName: getSetting('modelName', 'gpt-4o-mini'),
  };
}

/**
 * 关闭数据库
 */
function closeDatabase(dataDir) {
  if (db) {
    saveToDisk(dataDir);
    db.close();
    db = null;
  }
}

// ============================================================
// API 用量统计
// ============================================================

/**
 * 记录一次 API 调用用量
 * @param {string} apiKey - 完整 API Key
 * @param {string} model - 模型名称
 * @param {object} usage - { prompt_tokens, completion_tokens, total_tokens }
 */
function logApiUsage(apiKey, model, usage) {
  if (!db || !usage) return;
  // 只存 Key 前 8 位做区分，不存完整 Key（安全）
  const prefix = (apiKey || '').substring(0, 8);
  db.run(
    `INSERT INTO api_usage (api_key_prefix, model, prompt_tokens, completion_tokens, total_tokens)
     VALUES (?, ?, ?, ?, ?)`,
    [prefix, model, usage.prompt_tokens || 0, usage.completion_tokens || 0, usage.total_tokens || 0]
  );
}

/**
 * 获取按 API Key 分组的用量统计
 * @returns {Array<{keyPrefix: string, model: string, calls: number, totalTokens: number}>}
 */
function getUsageStats() {
  if (!db) return [];
  const result = db.exec(`
    SELECT api_key_prefix, model,
           COUNT(*) as calls,
           SUM(total_tokens) as total_tokens,
           SUM(prompt_tokens) as prompt_tokens,
           SUM(completion_tokens) as completion_tokens
    FROM api_usage
    GROUP BY api_key_prefix, model
    ORDER BY total_tokens DESC
  `);
  if (!result.length) return [];
  return result[0].values.map(row => ({
    keyPrefix: row[0],
    model: row[1],
    calls: row[2],
    totalTokens: row[3],
    promptTokens: row[4],
    completionTokens: row[5],
  }));
}

// ============================================================
// 书籍管理（书架）
// ============================================================

function insertBook(book) {
  if (!db) return;
  db.run(
    `INSERT OR REPLACE INTO books (id, title, author, file_path, cover_path, total_chapters, total_paragraphs)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [book.id, book.title, book.author, book.filePath, book.coverPath, book.totalChapters, book.totalParagraphs]
  );
}

function getAllBooks() {
  if (!db) return [];
  const result = db.exec('SELECT * FROM books ORDER BY imported_at DESC');
  if (!result.length) return [];
  return result[0].values.map(row => ({
    id: row[0],
    title: row[1],
    author: row[2],
    filePath: row[3],
    coverPath: row[4],
    totalChapters: row[5],
    totalParagraphs: row[6],
    importedAt: row[7],
  }));
}

function deleteBook(bookId) {
  if (!db) return;
  db.run('DELETE FROM books WHERE id = ?', [bookId]);
  db.run('DELETE FROM bilingual_book WHERE book_id = ?', [bookId]);
}

// ============================================================
// 笔记 / 标注
// ============================================================

function saveAnnotation(ann) {
  if (!db) return;
  db.run(
    `INSERT INTO annotations (book_id, paragraph_id, start_offset, end_offset, type, comment_text, color)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [ann.bookId, ann.paragraphId, ann.startOffset, ann.endOffset, ann.type, ann.comment || '', ann.color || '#ffeb3b']
  );
}

function getAnnotations(bookId) {
  if (!db) return [];
  const result = db.exec(
    'SELECT * FROM annotations WHERE book_id = ? ORDER BY paragraph_id, start_offset',
    [bookId]
  );
  if (!result.length) return [];
  return result[0].values.map(row => ({
    id: row[0],
    bookId: row[1],
    paragraphId: row[2],
    startOffset: row[3],
    endOffset: row[4],
    type: row[5],
    comment: row[6] || '',
    color: row[7] || '#ffeb3b',
    createdAt: row[8],
  }));
}

function deleteAnnotation(id) {
  if (!db) return;
  db.run('DELETE FROM annotations WHERE id = ?', [id]);
}

module.exports = {
  openDatabase,
  saveToDisk,
  closeDatabase,
  insertParagraphs,
  getChapterParagraphs,
  updateTranslation,
  getUntranslatedParagraphs,
  getTranslationProgress,
  setSetting,
  getSetting,
  getApiConfig,
  logApiUsage,
  getUsageStats,
  insertBook,
  getAllBooks,
  deleteBook,
  saveAnnotation,
  getAnnotations,
  deleteAnnotation,
};
