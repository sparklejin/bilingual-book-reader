/**
 * AI 翻译模块 —— 通用 OpenAI 兼容接口
 *
 * 支持所有兼容 OpenAI Chat Completions API 的厂商：
 * OpenAI / Claude / DeepSeek / 通义千问 / 智谱 / Moonshot / Ollama / OpenRouter ...
 *
 * 用户只需配置三个参数即可切换：
 *   API_BASE_URL  →  端点地址
 *   API_KEY       →  API 密钥
 *   MODEL_NAME    →  模型名称
 */

// ============================================================
// 翻译配置
// ============================================================

const SYSTEM_PROMPT = `你是一位精通英汉翻译的文学翻译家。请将用户输入的英文 JSON 数组翻译为中文。

规则：
1. 保持 JSON 结构完全一致，只翻译 "zh" 字段
2. 不要解释，不要输出任何 JSON 以外的内容
3. 翻译要求符合中文阅读习惯，保留文学色彩
4. 对于英文人名、地名、品牌名，保留原文并在首次出现时用括号标注中文译名
5. 段落中的上标数字（脚注编号）保持原样`;

// ============================================================
// 翻译函数
// ============================================================

/**
 * 批量翻译段落
 * @param {Array<{id: string, en: string}>} paragraphs - 待翻译段落
 * @param {object} apiConfig - { apiBaseUrl, apiKey, modelName }
 * @returns {Promise<Array<{id: string, zh: string}>>} 翻译结果
 */
async function translateBatch(paragraphs, apiConfig) {
  const { apiBaseUrl, apiKey, modelName } = apiConfig;

  if (!apiKey) {
    throw new Error('API Key 未配置，请在设置中填写');
  }

  // ★ URL 占位符替换：把 URL 替换为短占位符，节省 token
  //   例如 "See https://youtube.com/xxx" → "See [🔗1]"
  let counter = 0;
  const urlMap = {};  // paragraph_id → { placeholder → original_url }

  const userInput = paragraphs.map(p => {
    const urls = [];
    let cleaned = p.en.replace(
      /https?:\/\/[^\s<>"']+/gi,
      (match) => {
        counter++;
        const placeholder = `[🔗${counter}]`;
        urls.push({ placeholder, url: match });
        return placeholder;
      }
    );

    if (urls.length > 0) {
      urlMap[p.id] = urls;
    }

    return { id: p.id, en: cleaned, zh: '' };
  });

  const url = `${apiBaseUrl.replace(/\/$/, '')}/v1/chat/completions`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelName,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(userInput) },
      ],
      temperature: 0.3,        // 低温度保证翻译一致性
      response_format: modelName.includes('gpt') || modelName.includes('o1') || modelName.includes('o3')
        ? { type: 'json_object' }
        : undefined,           // 非 OpenAI 模型可能不支持，用 prompt 约束即可
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(
      `API 请求失败 (${response.status}): ${errorBody.substring(0, 200)}`
    );
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  const usage = data.usage || null;  // ★ 捕获 token 用量

  if (!content) {
    throw new Error('API 返回内容为空');
  }

  // 尝试解析 JSON（AI 有时会在 JSON 外包裹 markdown 代码块）
  let parsed;
  try {
    // 先尝试直接解析
    parsed = JSON.parse(content);
  } catch {
    // 尝试提取 markdown 代码块中的 JSON
    const jsonMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[1]);
    } else {
      throw new Error(`无法解析 AI 返回的 JSON: ${content.substring(0, 200)}`);
    }
  }

  // 验证返回格式并提取翻译
  if (!Array.isArray(parsed)) {
    // 某些兼容模式下 AI 可能返回 { "translations": [...] } 之类的包装
    const candidate = parsed.translations || parsed.data || parsed.result;
    if (Array.isArray(candidate)) {
      parsed = candidate;
    } else {
      throw new Error('AI 返回格式不正确，期望 JSON 数组');
    }
  }

  // ★ 将占位符替换回原始 URL
  const translations = parsed
    .filter(item => item.id && item.zh)
    .map(item => {
      let zhText = item.zh;
      const replacements = urlMap[item.id];
      if (replacements) {
        for (const { placeholder, url } of replacements) {
          zhText = zhText.replace(placeholder, url);
        }
      }
      return { id: item.id, zh: zhText };
    });

  return { translations, usage };
}

/**
 * 测试 API 连接
 * @param {object} apiConfig
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function testConnection(apiConfig) {
  try {
    const { translations } = await translateBatch(
      [{ id: 'test', en: 'Hello, world!' }],
      apiConfig
    );
    if (translations.length > 0 && translations[0].zh) {
      return {
        success: true,
        message: `连接成功！测试翻译: "${translations[0].zh}"`,
      };
    }
    return { success: false, message: 'API 返回了空翻译结果' };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

module.exports = { translateBatch, testConnection };
