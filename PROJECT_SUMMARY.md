# 📖 Bilingual Book Reader — 项目总结

基于 Electron 的英文电子书双语辅助阅读桌面应用。

---

## 一、技术栈

| 层 | 技术 | 职责 |
|---|---|---|
| 桌面框架 | Electron | 窗口管理、IPC 通信、系统对话框 |
| 前端 | HTML + CSS + Vanilla JS | 书架、阅读器、设置面板、笔记面板 |
| EPUB 解析 | adm-zip + cheerio | ZIP 解压、XML/XHTML 解析、封面提取 |
| 本地数据库 | sql.js (SQLite WASM) | 翻译缓存、用户配置、笔记、用量统计 |
| AI 翻译 | HTTP (OpenAI 兼容格式) | 批量翻译、单句查词 |
| 导出 | 字符串正则替换 | 双语 EPUB 生成（保持 XHTML 原样） |

---

## 二、架构图

```
┌────────────────────────────────────────────────────┐
│                   Electron App                      │
│                                                     │
│  ┌─ 渲染进程 ──────────────────────────────────┐   │
│  │  书架主页 │ 阅读器 │ 设置面板 │ 笔记面板     │   │
│  │  生词本   │ 搜索栏 │ 评论弹窗 │ 右键菜单    │   │
│  └──────────────┬────────────────────────────────┘   │
│                 │ contextBridge (IPC)                 │
│  ┌──────────────▼────────────────────────────────┐   │
│  │  主进程                                        │   │
│  │  ├─ EPUB 解析 (parser/epubParser.js)           │   │
│  │  ├─ AI 翻译 (translator/translator.js)         │   │
│  │  ├─ 数据库 (database/db.js)                    │   │
│  │  └─ EPUB 导出 (exporter/epubExporter.js)       │   │
│  └────────────────────────────────────────────────┘   │
│                                                     │
│  本地存储: %APPDATA%/bilingual-book-reader/data.db   │
└────────────────────────────────────────────────────┘
```

---

## 三、功能清单

### 📚 书架主页

- 封面卡片网格展示已导入书籍
- 导入新书（虚线 + 按钮）
- 右键菜单：开始阅读 / 查看笔记 / 导出双语 EPUB / 导出原版副本 / 删除图书
- 阅读进度记忆（书名 + 章节，下次打开自动恢复）
- 字号设置持久化

**实现要点**：
- 封面通过 `extractCover()` 从 EPUB manifest 中定位 `cover-image`，写入 `userData` 目录
- 自定义 `cover-file://` 协议直接读磁盘，避免 base64 传输（515KB → 即时加载）
- `books` 表持久化书籍元信息

### 📖 双语阅读器

- 左英右中双栏布局（CSS Grid row-based，天然等高对齐）
- 章节导航：下拉框 + 上一章/下一章按钮
- 字体缩放：A⁻ / A⁺ 五档可调，中英文独立
- 全文搜索：Ctrl+F 呼出，英中双语匹配，跨章节跳转，黄色高亮
- 阅读进度：每次切换章节自动保存

**实现要点**：
- CSS Grid `grid-template-columns: 1fr 1fr` 保证同行两列高度自动同步
- 搜索用 `TreeWalker` 遍历文本节点 + `Range.surroundContents(mark)` 高亮
- 进度存 `settings` 表的 `lastBookId` / `lastChapter` 字段

### 🌐 AI 翻译

- 通用 OpenAI 兼容接口（OpenAI / DeepSeek / 通义千问 / 智谱 / Ollama）
- 批量翻译：每批 8 段，批次间 800ms 延迟防限流
- 内置模型下拉选择（Flash / Pro 分级，💰 翻译推荐标注）
- 翻译缓存：SQLite 持久化，已翻译段落永不重复调用
- 全文翻译：逐章自动翻译，支持停止/继续
- API 用量统计：按 Key 前缀分组的 Token 消耗仪表
- URL 占位符优化：翻译前 `https://...` → `[🔗1]`，翻译后还原，省 ~30% Token

**实现要点**：
- `translateBatch()` 返回 `{ translations, usage }`，捕获每次调用的 token 数
- `api_usage` 表按 `api_key_prefix`（前 8 位）+ `model` 分组汇总
- 翻译完成立即写 DB + IPC 通知渲染进程 → 局部 DOM 更新

### 🔤 EPUB 解析

- NCX 目录过滤：解析 `toc.ncx` 构建正文白名单，过滤封面/版权页等非正文
- 脚注双向跳转：正文 `[4]` ⇄ 尾注章节精确锚点定位
- 链接保留：`en_html` 存储内联 HTML（`<a>` 标签 + 锚点 `<span>`）
- XHTML 自闭合标签预处理：正则 `<span id="x"/>` → `<span id="x"></span>`

**实现要点**：
- 非正文过滤从 NCX 提取 114 个内容文件，过滤掉 8 个（封面/版权/目录等）
- 脚注通过解析 `<aside epub:type="footnote">` 提取 1013 条尾注
- cheerio 解析 XHTML 前，正则修复自闭合 span 防止误包裹后续元素
- 章节按 `xhtml_file` 精确匹配，非 spine 序号

### 📝 笔记系统

- 四种标注：高亮（黄底）、波浪线（橙虚线）、加粗、评论（蓝虚线下划线）
- 选中文字 → 弹出工具栏 → 点击标注类型
- 评论弹窗：原文引用 + 自由填写
- 同一位置可叠加多种标注（事件点分段 + DOM `surroundContents`）
- 右键标注 → 删除单条
- 点击评论标记 → 白色浮层卡片展示评论内容
- 笔记面板：右侧滑出，按章节分组，点击跳转

**实现要点**：
- 偏移量基于 `p.en` 纯文本，用 DOM Range API 从容器开头精确计算
- 标注渲染使用事件点算法将重叠标注合并为无重叠分段，逐段 `surroundContents`
- 每段后重新 walk 文本节点（避免 `surroundContents` 劈开节点后引用失效）
- 评论偏移量在弹窗打开时预计算存入 `pendingCommentTarget`（因保存时选区已失效）

### 📄 EPUB 导出

- 原版副本：直接 `fs.copyFileSync`
- 双语版：原文 + 中文译文隔行穿插
  - 译文用 `<div class="zh-translation">` 包裹，CSS 注入中文字体 + 绿色左边框
  - 使用字符串正则替换（非 cheerio DOM），保持 XHTML 格式原样
  - 导出前从 DB 加载全书翻译填入段落 `zh` 字段

**实现要点**：
- 放弃 cheerio DOM（会损坏 XML 声明和自闭合标签），改用正则 `<p>...</p>` 匹配 + 字符串插入
- 按 `xhtml_file` 分组段落，`paragraph_index` 顺序匹配

---

## 四、数据库表结构

| 表 | 用途 | 关键字段 |
|---|---|---|
| `bilingual_book` | 翻译缓存 | `paragraph_id`, `zh_text`, `status` |
| `books` | 书架书籍 | `title`, `author`, `file_path`, `cover_path` |
| `annotations` | 笔记标注 | `paragraph_id`, `start_offset`, `end_offset`, `type`, `comment_text` |
| `api_usage` | Token 用量 | `api_key_prefix`, `model`, `total_tokens` |
| `settings` | 用户配置 | `key`, `value`（API 配置、字号、阅读进度） |

---

## 五、关键踩坑与解决

| 问题 | 根因 | 解决方案 |
|---|---|---|
| cheerio 把 `<span/>` 解析为包裹后续元素的容器 | cheerio HTML 解析器不认 XHTML 自闭合 | 解析前正则 `<span id="x"/>` → `<span id="x"></span>` |
| NCX 外的非正文被当作章节 | spine 包含所有页面 | 解析 NCX，只处理白名单文件 |
| 脚注链接点击空白页 | 内部 XHTML 引用在渲染器中不存在 | 拦截链接点击，按 `xhtml_file → chapter` 映射跳转 |
| 首次打开翻译不显示 | `loadCachedTranslations` 在确定章节前调用 | 先设 `currentChapterNum`，再加载翻译 |
| 标注后大段文字消失 | `surroundContents` 后 textNodes 引用失效 | 逐段重新 walk 文本节点 |
| 评论无法保存 | 弹窗打开后选区失效 + `lastSelectionRange` 被清空 | 偏移量预计算 + `pendingCommentTarget` 暂存 |
| 导出 EPUB 翻译全是空 | `parseEpub` 不加载 DB 翻译 | 导出前遍历段落从 DB 逐条查 `zh_text` |
| 导出 EPUB XHTML 损坏 | cheerio `$.html()` 序列化为 HTML5 | 改用字符串正则替换，保持 XHTML 原样 |
| 同段多种标注互相覆盖 | 逐条 surroundContents 未合并 | 事件点分段 → 每段一次 surroundContents + 合并 class |
| sql.js 替代 better-sqlite3 | 后者需 Python + MSVC 编译 | sql.js 是 WASM 编译的纯 JS SQLite，零依赖 |

---

## 六、项目结构

```
bilingual book reading/
├── start.bat                 ← 双击启动
├── main.js                   ← Electron 主进程（IPC + 协议注册）
├── preload.js                ← contextBridge 安全桥接
├── package.json
├── readme.md
├── book source/              ← EPUB 书源
│
└── bilingual book reading project/
    └── src/
        ├── parser/
        │   └── epubParser.js     ← EPUB 解析 + NCX 过滤 + 封面提取
        ├── database/
        │   └── db.js             ← SQLite 全部 CRUD（6 张表）
        ├── translator/
        │   └── translator.js     ← AI 翻译 + 批量 + URL 优化
        ├── exporter/
        │   └── epubExporter.js   ← 双语 EPUB 导出
        └── renderer/
            ├── index.html        ← 全部 UI（书架/阅读器/弹窗/面板）
            ├── styles/
            │   └── reader.css    ← 全局样式（~800 行）
            └── js/
                └── reader.js     ← 全部前端逻辑（~1800 行）
```
