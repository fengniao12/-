'use strict';

/**
 * DashScope / CosyVoice 声音克隆与同步语音合成。
 * 文档：https://help.aliyun.com/zh/model-studio/voice-clone-design-http-api
 *       https://help.aliyun.com/zh/model-studio/cosyvoice-tts-http-api
 */

const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/api/v1';
const DEFAULT_MODEL = 'cosyvoice-v3.5-plus';
const ENROLL_MODEL = 'voice-enrollment';

const MIME_BY_EXT = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  pcm: 'audio/pcm'
};

const ALLOWED_FORMATS = ['mp3', 'wav', 'pcm', 'opus'];
const SAMPLE_RATES = [8000, 12000, 16000, 22050, 24000, 44100, 48000];

function cleanBase(baseUrl) {
  let base = String(baseUrl || DEFAULT_BASE_URL).trim();
  if (base.includes('{WorkspaceId}')) {
    throw new Error('接口地址里的 {WorkspaceId} 需要替换成你的业务空间 ID（在百炼控制台可以查看）。');
  }
  const marker = base.indexOf('/services/');
  if (marker >= 0) base = base.slice(0, marker);
  base = base.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) {
    throw new Error('接口地址必须以 http:// 或 https:// 开头。');
  }
  return base;
}

function apiUrl(baseUrl, path) {
  return `${cleanBase(baseUrl)}${path}`;
}

function dataUri(mime, base64) {
  return `data:${mime || 'audio/mpeg'};base64,${base64}`;
}

function sanitizePrefix(prefix) {
  const value = String(prefix || 'myvoice')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  return value.slice(0, 10) || 'myvoice';
}

function clamp(num, min, max, fallback) {
  const n = Number(num);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function bodyMessage(body) {
  if (!body) return '';
  return String(body.message || body.msg || body.error || body.code || '').trim();
}

function explainHttpFailure(status, body, rawText) {
  if (status === 401 || status === 403) {
    return 'DashScope API Key 无效，或当前 Key 未开通「声音复刻 / CosyVoice」服务。请到阿里云百炼控制台确认 Key 与模型权限。';
  }
  if (status === 429) {
    return '请求过于频繁或额度不足（HTTP 429），请稍后重试并检查百炼额度。';
  }
  if (status === 404) {
    return '接口地址或业务空间 ID 不正确（HTTP 404），请检查设置里的接口地址。';
  }
  const msg = bodyMessage(body);
  if (msg) return `语音服务返回错误：${msg}`;
  if (rawText) return `语音服务返回错误（HTTP ${status}）：${String(rawText).slice(0, 200)}`;
  return `语音服务返回错误（HTTP ${status}）。`;
}

async function postJson(url, apiKey, payload, signal) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload),
    signal
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch (_) {}
  if (!res.ok) {
    const err = new Error(explainHttpFailure(res.status, body, text));
    err.status = res.status;
    err.body = body;
    throw err;
  }
  if (body && body.code && String(body.code) !== '200') {
    const err = new Error(`语音服务返回错误：${body.message || body.code}`);
    err.code = String(body.code);
    err.body = body;
    throw err;
  }
  return body || {};
}

function enrollmentPayload(input) {
  return { model: ENROLL_MODEL, input };
}

/** 创建克隆音色，返回 voice_id（此时通常为 DEPLOYING） */
async function createVoice({ baseUrl, apiKey, audioBase64, mime, model, prefix, language, preprocess }, { signal } = {}) {
  if (!audioBase64) throw new Error('请先上传参考音频。');
  const voiceModel = String(model || DEFAULT_MODEL).trim();
  const payload = enrollmentPayload({
    action: 'create_voice',
    target_model: voiceModel,
    prefix: sanitizePrefix(prefix),
    audio: dataUri(mime, audioBase64),
    language_hints: [String(language || 'zh')],
    enable_preprocess: Boolean(preprocess)
  });
  const body = await postJson(apiUrl(baseUrl, '/services/audio/tts/customization'), apiKey, payload, signal);
  const out = body.output || {};
  const voiceId = out.voice_id || out.voiceId;
  if (!voiceId) {
    throw new Error(`创建音色成功但返回里没有 voice_id：${JSON.stringify(body).slice(0, 200)}`);
  }
  return {
    voiceId,
    status: out.status || 'DEPLOYING',
    targetModel: out.target_model || voiceModel,
    requestId: body.request_id || ''
  };
}

async function queryVoice({ baseUrl, apiKey, voiceId }, { signal } = {}) {
  const body = await postJson(
    apiUrl(baseUrl, '/services/audio/tts/customization'),
    apiKey,
    enrollmentPayload({ action: 'query_voice', voice_id: voiceId }),
    signal
  );
  const out = body.output || {};
  return {
    voiceId,
    status: out.status || '',
    targetModel: out.target_model || '',
    resourceLink: out.resource_link || '',
    requestId: body.request_id || ''
  };
}

async function listVoices({ baseUrl, apiKey, prefix = '', pageSize = 50, pageIndex = 0 }, { signal } = {}) {
  const input = { action: 'list_voice', page_size: pageSize, page_index: pageIndex };
  if (prefix) input.prefix = sanitizePrefix(prefix);
  const body = await postJson(apiUrl(baseUrl, '/services/audio/tts/customization'), apiKey, enrollmentPayload(input), signal);
  const out = body.output || {};
  const list = Array.isArray(out.voice_list) ? out.voice_list : Array.isArray(out.voices) ? out.voices : [];
  return {
    voices: list.map((v) => ({
      voiceId: v.voice_id || v.voiceId || '',
      targetModel: v.target_model || '',
      status: v.status || '',
      createdAt: v.gmt_create || '',
      modifiedAt: v.gmt_modified || ''
    })),
    total: out.total_count || list.length,
    requestId: body.request_id || ''
  };
}

async function deleteVoice({ baseUrl, apiKey, voiceId }, { signal } = {}) {
  const body = await postJson(
    apiUrl(baseUrl, '/services/audio/tts/customization'),
    apiKey,
    enrollmentPayload({ action: 'delete_voice', voice_id: voiceId }),
    signal
  );
  return { ok: true, requestId: body.request_id || '' };
}

/** 创建后轮询到 OK；DEPLOYING 继续，UNDEPLOYED 失败 */
async function enrollVoice(opts, { signal, onProgress, intervalMs = 1800, maxAttempts = 40 } = {}) {
  const created = await createVoice(opts, { signal });
  if (created.status === 'OK') return { ...created, attempts: 0 };
  if (created.status === 'UNDEPLOYED') {
    throw new Error('音色注册失败（状态 UNDEPLOYED），请换一段更清晰的 10–20 秒人声重试。');
  }
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    if (signal && signal.aborted) throw new Error('已取消生成。');
    const q = await queryVoice({ baseUrl: opts.baseUrl, apiKey: opts.apiKey, voiceId: created.voiceId }, { signal });
    if (typeof onProgress === 'function') {
      onProgress({ attempt: i + 1, status: q.status, voiceId: created.voiceId });
    }
    if (q.status === 'OK') {
      return { ...created, status: 'OK', resourceLink: q.resourceLink, attempts: i + 1, requestId: q.requestId || created.requestId };
    }
    if (q.status === 'UNDEPLOYED') {
      throw new Error('音色注册失败（状态 UNDEPLOYED），请换一段更清晰的 10–20 秒人声重试。');
    }
  }
  throw new Error('音色仍在部署中，请稍后到「声音克隆」列表里点「同步」查看状态。');
}

function normalizeFormat(format) {
  const f = String(format || 'mp3').toLowerCase();
  if (f === 'ogg_opus' || f === 'ogg') return 'opus';
  return ALLOWED_FORMATS.includes(f) ? f : 'mp3';
}

/** 非实时合成：返回 24 小时有效的音频 URL */
async function synthesize({ baseUrl, apiKey, model, voice, text, format, sampleRate, speed, instruction }, { signal } = {}) {
  if (!voice) throw new Error('请先选择一个克隆音色。');
  if (!String(text || '').trim()) throw new Error('文本为空。');
  const fmt = normalizeFormat(format);
  let rate = clamp(sampleRate, 8000, 48000, 22050);
  if (!SAMPLE_RATES.includes(rate)) rate = 22050;
  const input = {
    text: String(text),
    voice,
    format: fmt,
    sample_rate: rate,
    rate: clamp(speed, 0.5, 2, 1)
  };
  if (instruction && String(instruction).trim()) input.instruction = String(instruction).trim().slice(0, 500);
  const body = await postJson(
    apiUrl(baseUrl, '/services/audio/tts/SpeechSynthesizer'),
    apiKey,
    { model: String(model || DEFAULT_MODEL).trim(), input },
    signal
  );
  const out = body.output || {};
  const audio = out.audio || {};
  if (!audio.url) {
    throw new Error('合成成功但返回里没有音频地址，请检查模型 ID 是否支持非实时合成。');
  }
  return {
    url: audio.url,
    requestId: body.request_id || '',
    characters: (body.usage && body.usage.characters) || 0,
    format: fmt,
    sampleRate: rate
  };
}

async function downloadAudio(url, { signal } = {}) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`下载合成音频失败（HTTP ${res.status}）。`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) throw new Error('合成服务返回了空音频，请稍后重试。');
  return buffer;
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  ENROLL_MODEL,
  MIME_BY_EXT,
  sanitizePrefix,
  cleanBase,
  dataUri,
  createVoice,
  queryVoice,
  listVoices,
  deleteVoice,
  enrollVoice,
  synthesize,
  downloadAudio,
  normalizeFormat
};
