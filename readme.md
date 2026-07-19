## 技术架构

### 技术选型

| 层级 | 技术 | 说明 |
|---|---|---|
| **桌面框架** | Electron | 内嵌 Chromium + Node.js，用 Web 技术构建桌面应用 |
| **UI 渲染** | HTML + CSS + Vanilla JS | Row-based CSS Grid 双栏布局 |
| **EPUB 解析** | adm-zip + cheerio | 解压 ZIP + 解析 HTML/XML（类比 Python 的 zipfile + BeautifulSoup） |
| **本地数据库** | sql.js | WebAssembly 编译的 SQLite，纯 JS 无需原生编译 |
| **AI 翻译** | HTTP 调用 AI API | 批量打包翻译（5-10 段/次），严格 JSON 格式交互 |

### 选择 Electron 的理由

- **UI 复用**：README 中设计的 HTML/CSS 双栏布局可直接使用，无需学习原生 GUI 框架
- **语言统一**：前后端都用 JavaScript，降低学习成本
- **生态丰富**：`cheerio`（HTML 解析）、`sql.js`（SQLite）、`adm-zip`（解压）等成熟库
- **跨平台**：同一套代码可打包为 Windows / macOS / Linux 应用
- **社区庞大**：VS Code、Slack、Discord 均基于 Electron，遇到问题容易搜索

### Electron 进程模型

Electron 应用由两个独立进程组成，通过 IPC（进程间通信）安全交互：

```
┌─────────────────────────────────────────────────────────┐
│                     Electron App                         │
│                                                          │
│  ┌─ 渲染进程 (Renderer / UI) ──────────────────────┐   │
│  │                                                   │   │
│  │  HTML + CSS + JavaScript                          │   │
│  │  ├── 书籍导入界面                                  │   │
│  │  ├── 双语阅读界面 (Row-based Grid)                 │   │
│  │  └── 书架 / 进度管理                               │   │
│  │                                                   │   │
│  └──────────────┬────────────────────────────────────┘   │
│                 │ IPC (contextBridge)                     │
│  ┌──────────────▼────────────────────────────────────┐   │
│  │  主进程 (Main Process)                              │   │
│  │                                                   │   │
│  │  ├── EPUB 解析模块 (adm-zip + cheerio)             │   │
│  │  ├── AI 翻译模块 (HTTP API, 批量 + 限速)           │   │
│  │  ├── 数据库模块 (sql.js)                              │   │
│  │  └── 翻译队列管理器 (优先级调度)                   │   │
│  │                                                   │   │
│  └───────────────────────────────────────────────────┘   │
│                                                          │
│  本地存储:                                                │
│  ├── ~/bilingual-reader/books/   (导入的 EPUB)           │
│  └── ~/bilingual-reader/data.db  (SQLite 数据库)         │
└─────────────────────────────────────────────────────────┘
```

### 安全模型

- **渲染进程不直接访问 Node.js API**：出于安全考虑，Chromium 默认禁止网页调用系统资源
- **Preload 脚本（contextBridge）**：主进程通过 `preload.js` 暴露有限的、白名单内的 API 给渲染进程
- **IPC 通信**：渲染进程通过 `window.electronAPI.parseEpub(filePath)` 等限定接口，间接调用主进程能力

### 项目目录结构

```
bilingual-book-reading/
├── package.json              # npm 项目配置
├── readme.md                 # 本文档
├── main.js                   # Electron 主进程入口
├── preload.js                # 安全的 IPC 桥接脚本
├── src/
│   ├── parser/
│   │   └── epubParser.js     # EPUB 解析模块
│   ├── database/
│   │   └── db.js             # SQLite 数据库操作
│   └── translator/
│       └── translator.js     # AI 翻译模块（批量 + 缓存）
├── renderer/
│   ├── index.html            # 主阅读界面
│   ├── styles/
│   │   └── reader.css        # 阅读器样式（双栏布局）
│   └── js/
│       └── reader.js         # 渲染进程逻辑
└── data/                     # 本地数据存储目录（gitignore）
```

---

为了方便您着手开发，这里将整个系统的设计细化为四个具体的步骤，并提供基础的设计逻辑、技术实现路径以及代码/数据结构示例。

---

### 第一步：解析与分段（Parser）—— ✅ 已完成

`src/parser/epubParser.js`

#### 实现要点

| 功能 | 方案 | 细节 |
|---|---|---|
| **解压 EPUB** | `adm-zip` | EPUB 本质是 ZIP 包，直接读取 MIME 内容 |
| **定位章节** | `container.xml` → `content.opf` → `<spine>` | 两步跳转找到正确的阅读顺序 |
| **过滤非正文** | 解析 `toc.ncx` 构建白名单 | 只保留 NCX 目录中的 114 章，过滤掉封面/版权页等 8 项非正文 |
| **章节标题** | NCX `navLabel/text` | “Be Useful” / “Foreword” 等真实标题，而非无意义的文件名 |
| **段落提取** | `cheerio` 选择 `<p>`, `<h1>`-`<h6>`, `<li>`, `<aside>` | 含尾注共 2680 段 |
| **HTML 保留** | `en_html` 字段存储内联 HTML | 保留 `<a>` 链接和 `<span>` 锚点，清理多余 class/id |
| **脚注双向跳转** | 正文 `[4]` ⇄ 尾注锚点 | 预处理 XHTML 自闭合标签 + `<aside>` 尾注提取 + 锚点 id 保留 |
| **翻页导航** | 章节底部 ← → 按钮 | 支持上一章/下一章，首尾章自动禁用 |

#### 数据结构

```javascript
{
  id: “c6_p2”,              // 段落唯一 ID
  chapter: 6,               // 章节序号
  chapter_title: “Be Useful”,
  paragraph_index: 2,
  xhtml_file: “c9B.xhtml”,  // 来源文件，脚注跳转用
  is_heading: false,
  is_footnote: false,       // 尾注标记（灰色背景渲染）
  footnote_id: “”,          // 尾注锚点 ID（精确滚动定位）
  tag: “p”,
  en: “Don't aspire to glory; aspire to work.”,
  en_html: “Don't aspire to glory; aspire to work.<span id=\”a501\”></span><a href=\”cE8.xhtml#a6FK\”>4</a>”,
  zh: “”                    // 待翻译
}
```

#### 验证数据（The Book of Elon）

- 书名：The Book of Elon: A Guide to Purpose and Success
- 作者：Eric Jorgenson
- 总段落：**2680** 段（正文 1667 + 尾注 1013）
- 章节数：**114** 章（NCX 过滤后）
- 链接段落：**981** 段（脚注引用 71 段 + 外部链接 10 段）
- 锚点标记：**1117** 个

---

### 第二步：翻译与缓存（Translator）—— ✅ 已完成

`src/translator/translator.js` + `src/database/db.js`

#### 通用 API 方案

所有主流 AI 厂商均兼容 OpenAI Chat Completions 格式，只需配置三个参数：

| 参数 | 说明 | 示例 |
|---|---|---|
| `API_BASE_URL` | 厂商端点地址 | `https://api.openai.com` |
| `API_KEY` | 鉴权密钥 | `sk-...` |
| `MODEL_NAME` | 模型名称 | `gpt-4o-mini` |

内置预设：**OpenAI** / **DeepSeek** / **通义千问** / **智谱**（一键填充 URL 和模型名）

#### 翻译流程

```
点击「翻译本章」→ 分段打包（8段/批）→ 调用 AI API → JSON 解析 → 写 DB + 更新 DOM
                                   ↓
                          批次间延迟 800ms 防限流
                                   ↓
                          断点续传（已翻译的自动跳过）
```

#### 数据库（sql.js）

- `bilingual_book` 表：缓存翻译结果（`paragraph_id` 主键，`zh_text` 译文）
- `settings` 表：存储用户 API 配置（`key`-`value` 键值对）
- 应用退出时自动 `export` 到磁盘文件 `data.db`

#### 翻译结果持久化

- 翻译完成后立即写入数据库
- 下次打开同一本书时，自动从数据库加载已有译文
- 切换章节时自动查询该章的缓存翻译
- 支持离线阅读（已翻译的部分无需联网）

---

### 第三步：双栏渲染与对齐（UI Rendering）

在前端呈现“左英右中”时，最忌讳的是“左右两栏独立滚动”，因为一旦两边行高不同，翻了几页后中英文就会错位。

#### 1. 推荐的排版设计：**横向网格行（Row-based Grid）**
不要把左边做成一个大 Textbox，右边做成一个大 Textbox。而是**按段落渲染**。每一行都是一个双栏容器。

**HTML 结构设计**：
```html
<div class="reader-container">
  
  <!-- 每一个段落是一个 row -->
  <div class="bilingual-row" id="c1_p1">
    <div class="column-en">It was the best of times,</div>
    <div class="column-zh">那是最美好的时代，</div>
  </div>

  <div class="bilingual-row" id="c1_p2">
    <div class="column-en">it was the worst of times.</div>
    <div class="column-zh">那是最糟糕的时代。</div>
  </div>

</div>
```

**CSS 样式设计（核心）**：
使用 `CSS Grid`。这样，**不论左边的英文因为单词长被挤成几行，右边对应的那一段都会被自动拉伸到相同的高度**，两边永远完美对齐。

```css
.reader-container {
  display: flex;
  flex-direction: column;
  gap: 1.5rem; /* 段落间距 */
  max-width: 1000px;
  margin: 0 auto;
}

.bilingual-row {
  display: grid;
  grid-template-columns: 1fr 1fr; /* 左右等宽双栏 */
  gap: 2rem; /* 中英双栏间距 */
  padding: 0.5rem 0;
  border-bottom: 1px dashed #eee; /* 可选：段落分界线 */
}

.column-en {
  font-family: 'Georgia', serif;
  font-size: 1.1rem;
  line-height: 1.6;
  color: #333;
}

.column-zh {
  font-family: 'PingFang SC', sans-serif;
  font-size: 1.05rem;
  line-height: 1.6;
  color: #666; /* 译文颜色稍浅，突出原文 */
}
```

---

### 第四步：用户体验流程控制（混合/懒加载翻译策略）

因为整本书翻译可能需要消耗数分钟甚至数十分钟（取决于书本长度和 API 速度），不能让用户干等着。

#### 建议的工作流（Workflow）：

1. **导入书籍**：
   * 用户上传 EPUB。
   * 系统本地解析，在 1 秒内生成全书的英文段落，并写入本地数据库（此时 `zh_text` 全为空）。
2. **首次加载**：
   * 页面立刻显示第一章的内容（左侧有英文，右侧是空白或加载动画）。
   * 系统**优先启动**第一章的翻译队列。
3. **分批翻译与推送**：
   * 后台翻译完第一章的第 1-10 段，立刻更新数据库，并通过前端状态机（如 React 的 State 变更或 WebSocket/事件订阅）将中文渲染到右侧。
   * 用户几乎在开书 10 秒内就能看到前几段的译文。
4. **后台预读翻译（Pre-fetching）**：
   * 当用户在阅读第一章时，后台脚本在静默状态下，继续请求 API 翻译第二章、第三章。
   * 这样当用户往后翻页时，后面的中文其实已经在本地数据库里准备好了。
5. **译文未就绪时的妥协设计**：
   * 如果用户翻页速度过快，后台还没来得及翻译到这一页，右侧可以显示一个优雅的占位符（例如：微微闪烁的骨架屏，或一个浅灰色的“*译文正在生成中...*”字样）。