/**
 * Preload 脚本 —— 渲染进程与主进程之间的安全桥接
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 文件操作
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
  parseEpub: (filePath) => ipcRenderer.invoke('parse-epub', filePath),

  // 外部链接
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // API 设置
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  loadSettings: () => ipcRenderer.invoke('load-settings'),
  testApiConnection: (apiConfig) => ipcRenderer.invoke('test-api-connection', apiConfig),

  // 翻译
  translateBatch: (paragraphs, apiConfig) =>
    ipcRenderer.invoke('translate-batch', paragraphs, apiConfig),
  loadTranslations: (bookId, chapterNum) =>
    ipcRenderer.invoke('load-translations', bookId, chapterNum),
  getTranslationProgress: (bookId) =>
    ipcRenderer.invoke('get-translation-progress', bookId),

  // API 用量统计
  getApiUsageStats: () => ipcRenderer.invoke('get-api-usage-stats'),

  // 书架
  listBooks: () => ipcRenderer.invoke('list-books'),
  getCoverUrl: (coverPath) => ipcRenderer.invoke('get-cover-url', coverPath),
  deleteBook: (bookId) => ipcRenderer.invoke('delete-book', bookId),

  // 笔记 / 标注
  saveAnnotation: (ann) => ipcRenderer.invoke('save-annotation', ann),
  getAnnotations: (bookId) => ipcRenderer.invoke('get-annotations', bookId),
  deleteAnnotation: (id) => ipcRenderer.invoke('delete-annotation', id),

  // 导出
  exportEpub: (epubPath, mode, paragraphs) =>
    ipcRenderer.invoke('export-epub', epubPath, mode, paragraphs),
});
