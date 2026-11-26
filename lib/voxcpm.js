'use strict';

/**
 * VoxCPM2 客户端（vllm-omni 版）
 * 服务端：vLLM + vllm-omni（OpenAI 兼容 Speech API），默认本机 http://127.0.0.1:8000
 * 接口：GET /health、GET /v1/models、POST /v1/audio/speech
 * 音色：vllm-omni 没有旧版参考音频注册表，克隆音色以 data URI 形式随请求内联（ref_audio）
 */

const DEFAULT_BASE_URL = 'http://127.0.0.1:8000';
const DEFAULT_MODEL = 'voxcpm2'; // 服务端 --served-model-name
const NATIVE_SAMPLE_RATE = 48000; // VoxCPM2 原生采样率
const MODES = ['tts', 'design', 'clone', 'hifi'];
const SAMPLE_RATES = [8000, 12000, 16000, 22050, 24000, 44100, 48000];
const REF_MIN_SECONDS = 1; // vllm-omni 服务端硬限制
const REF_MAX_SECONDS = 30;
const MAX_TEXT = 2000;

function cleanBase(baseUrl) {
  let s = String(baseUrl || '').trim();
  if (!s) return DEFAULT_BASE_URL;
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  s = s.replace(/\/+$/, '');
  s = s.replace(/\/api\/v1$/i, '').replace(/\/v1$/i, '');
  const cut = s.indexOf('/v1/');
  if (cut >= 0) s = s.slice(0, cut);
  return s.replace(/\/+$/, '') || DEFAULT_BASE_URL;
}

function apiUrl(baseUrl, path) {
  return cleanBase(baseUrl) + path;
}

function clamp(num, min, max, fallback) {
  const n = Number(num);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function authHeaders(apiKey, extra) {
  const headers = Object.assign({}, extra || {});
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

function readErrorBody(body) {
  if (!body) return '';
  if (typeof body === 'string') return body.slice(0, 300);
  const err = body.error || body;
  return String(err.message || err.msg || err.detail || body.message || '').slice(0, 300);
}

function httpError(status, message, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code || String(status);
  return err;
}

function explainHttpFailure(status, bodyText, rawUrl) {
  let detail = '';
  if (bodyText) {
    try {
      detail = readErrorBody(JSON.parse(bodyText));
    } catch (_) {
      detail = String(bodyText).slice(0, 200);
    }
  }
  if (status === 401 || status === 403) {
    return httpError(
      status,
      'vLLM 服务拒绝了当前 API Key（HTTP ' + status + '）。请到「设置 → API 接入」检查 Key 是否正确。' +
        (detail ? `（${detail}）` : ''),
      'AUTH'
    );
  }
  if (status === 404) {
    return httpError(
      404,
      '接口或模型不存在（HTTP 404）。请确认服务端已用 vllm-omni 启动 VoxCPM2，且服务名与配置一致。' +
        (detail ? `（${detail}）` : ''),
      'NOT_FOUND'
    );
  }
  if (status === 413) {
    return httpError(413, '请求体超过服务端限制，请缩短文本或换用更小的参考音频。', 'TOO_LARGE');
  }
  if (status === 400) {
    return httpError(
      400,
      detail || `请求参数有误：请检查文本长度与参考音频时长（${REF_MIN_SECONDS}–${REF_MAX_SECONDS} 秒）。`,
      'BAD_REQUEST'
    );
  }
  if (status >= 500) {
    return httpError(
      status,
      'vLLM 生成失败（HTTP ' + status + '）。可能是模型忙或显存不足，稍后再试。' + (detail ? `（${detail}）` : ''),
      'SERVER'
    );
  }
  return httpError(status, detail || `请求失败（HTTP ${status}）${rawUrl ? '：' + rawUrl : ''}`, String(status));
}

function networkError(err, baseUrl) {
  const msg = String((err && err.message) || err || '');
  if (/TIMEOUT|timeout|aborted/i.test(msg)) {
    return httpError(
      0,
      '请求超时。vllm-omni 首次调用会触发编译预热（可能数分钟），长文本也可能较慢；若反复超时请检查服务状态。',
      'TIMEOUT'
    );
  }
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket|network/i.test(msg)) {
    return httpError(
      0,
      `连接不上 vLLM 服务（${cleanBase(baseUrl)}）。请确认服务器上 vllm-omni 服务在运行；本机若被代理劫持域名，可双击「启动VoxCPM隧道.bat」并把地址改成 http://127.0.0.1:8000。`,
      'NETWORK'
    );
  }
  const e = new Error(msg || '请求失败');
  e.code = (err && err.code) || 'ERROR';
  return e;
}

function promiseWithTimeout(promise, ms, onAbort) {
  if (!ms) return promise;
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(httpError(0, 'TIMEOUT', 'TIMEOUT')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
    if (onAbort) onAbort();
  });
}

async function getJson(url, { apiKey, signal, timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const forward = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', forward, { once: true });
  }
  try {
    const res = await promiseWithTimeout(
      fetch(url, { method: 'GET', headers: authHeaders(apiKey), signal: ctrl.signal }),
      timeoutMs,
      () => signal && signal.removeEventListener('abort', forward)
    );
    if (!res.ok) throw explainHttpFailure(res.status, await res.text(), url);
    return await res.json();
  } catch (err) {
    if (err && err.status !== undefined) throw err;
    throw networkError(err, url);
  }
}

/**
 * 健康检查：
 * - GET /health 是 vLLM 标准探针（无需 Key，200 空体=就绪，503=加载中）
 * - GET /v1/models 需要 Key，用来验证密钥与读取服务名
 */
async function health({ baseUrl = DEFAULT_BASE_URL, apiKey = '', signal, timeoutMs = 20000 } = {}) {
  const healthUrl = apiUrl(baseUrl, '/health');
  const ctrl = new AbortController();
  const forward = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', forward, { once: true });
  }
  let status = 'ok';
  try {
    const res = await promiseWithTimeout(
      fetch(healthUrl, { method: 'GET', headers: authHeaders(apiKey), signal: ctrl.signal }),
      timeoutMs,
      () => signal && signal.removeEventListener('abort', forward)
    );
    if (res.status === 503) status = 'loading';
    else if (!res.ok) throw explainHttpFailure(res.status, await res.text(), healthUrl);
  } catch (err) {
    if (err && err.status !== undefined) throw err;
    throw networkError(err, baseUrl);
  }

  let model = DEFAULT_MODEL;
  let apiKeyRequired = Boolean(apiKey);
  if (status === 'ok') {
    try {
      const body = await getJson(apiUrl(baseUrl, '/v1/models'), { apiKey, signal, timeoutMs });
      const id = body && Array.isArray(body.data) && body.data[0] && body.data[0].id;
      if (id) model = id;
    } catch (err) {
      // 未带 Key 且服务开启了 --api-key：/v1/models 返回 401，判定为需要密钥而非硬失败
      if (err && (err.status === 401 || err.status === 403) && !apiKey) {
        status = 'unauthorized';
        apiKeyRequired = true;
      } else {
        throw err;
      }
    }
  }

  return {
    status, // ok | loading | unauthorized
    model,
    sampleRate: NATIVE_SAMPLE_RATE,
    optimize: false, // vllm-omni 无旧版 optimize/denoiser 开关，保留字段以兼容 UI
    denoiser: false,
    loadSeconds: 0,
    busy: status === 'loading',
    apiKeyRequired,
    gpu: [], // vLLM 标准接口不返回 GPU 明细
    error: null
  };
}

/**
 * 渲染输入文本：
 * - hifi（极致克隆）：control 被服务端忽略，只发原文（同官方 Gradio demo 规则）
 * - design / 可控克隆：控制指令拼成 "(control)text"
 * - tts：原文
 */
function renderInput(mode, text, control) {
  const t = String(text || '').trim();
  const c = String(control || '').trim();
  if (mode === 'hifi' || !c) return t;
  return `(${c.slice(0, 400)})${t}`;
}

/** 构造 POST /v1/audio/speech 请求体 */
function buildSpeechBody(opts = {}) {
  const text = String(opts.text || '').trim();
  if (!text) throw httpError(0, '文本为空，先写点内容吧。', 'EMPTY_TEXT');
  if (text.length > MAX_TEXT) {
    throw httpError(0, `文本超长：${text.length} 字，VoxCPM2 单次最多 ${MAX_TEXT} 字，请分段生成。`, 'TOO_LONG');
  }

  let mode = String(opts.mode || 'tts').toLowerCase();
  if (!MODES.includes(mode)) mode = 'tts';

  const body = {
    model: opts.model || DEFAULT_MODEL,
    input: renderInput(mode, text, opts.control),
    voice: 'default', // VoxCPM2 无预置音色，该字段仅满足 OpenAI schema
    response_format: opts.format === 'mp3' ? 'mp3' : 'wav',
    stream: false
  };

  const refAudio = String(opts.referenceAudio || '').trim();
  if (mode === 'clone' || mode === 'hifi') {
    if (!refAudio) throw httpError(0, '克隆模式需要参考音频，请先上传或在「我的音色」里选择一个。', 'NO_REF');
    body.ref_audio = refAudio;
  }

  if (mode === 'hifi') {
    const prompt = String(opts.promptText || '').trim();
    if (!prompt) throw httpError(0, '极致克隆需要填写参考音频里说的原话（逐字文本）。', 'NO_PROMPT');
    body.ref_text = prompt.slice(0, 2000);
  }

  if (opts.seed !== undefined && opts.seed !== null && opts.seed !== '') {
    body.seed = Math.round(Number(opts.seed));
  }
  return body;
}

// 旧名字保留为别名，便于测试与外部调用平滑过渡
const buildTtsBody = buildSpeechBody;

/** 解析 WAV 头部得到时长（秒）；非 WAV 或解析失败返回 0 */
function wavDurationSeconds(buffer) {
  try {
    if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
      return 0;
    }
    let offset = 12;
    let channels = 1;
    let sampleRate = NATIVE_SAMPLE_RATE;
    let bitsPerSample = 16;
    let dataBytes = 0;
    while (offset + 8 <= buffer.length) {
      const id = buffer.toString('ascii', offset, offset + 4);
      const size = buffer.readUInt32LE(offset + 4);
      if (id === 'fmt ' && size >= 16) {
        channels = buffer.readUInt16LE(offset + 10);
        sampleRate = buffer.readUInt32LE(offset + 12);
        bitsPerSample = buffer.readUInt16LE(offset + 22);
      } else if (id === 'data') {
        dataBytes = size;
        break;
      }
      offset += 8 + size + (size % 2);
    }
    const frameBytes = channels * (bitsPerSample / 8);
    if (!dataBytes || !frameBytes || !sampleRate) return 0;
    return dataBytes / frameBytes / sampleRate;
  } catch (_) {
    return 0;
  }
}

/** 生成语音：vllm-omni 非流式成功直接返回音频二进制（wav / mp3），错误才是 JSON */
async function generate(opts = {}, { signal, timeoutMs = 600000 } = {}) {
  const body = buildSpeechBody(opts);
  const url = apiUrl(opts.baseUrl, '/v1/audio/speech');
  const ctrl = new AbortController();
  const forward = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', forward, { once: true });
  }
  let res;
  try {
    res = await promiseWithTimeout(
      fetch(url, {
        method: 'POST',
        headers: authHeaders(opts.apiKey, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
        signal: ctrl.signal
      }),
      timeoutMs,
      () => signal && signal.removeEventListener('abort', forward)
    );
  } catch (err) {
    throw networkError(err, opts.baseUrl);
  }
  if (!res.ok) throw explainHttpFailure(res.status, await res.text(), url);

  const ct = String(res.headers.get('content-type') || '');
  if (ct.includes('application/json')) {
    // 正常响应必为音频二进制；收到 JSON 说明服务端行为异常
    const json = await res.json().catch(() => ({}));
    if (json && json.error) throw explainHttpFailure(res.status, JSON.stringify(json), url);
    throw httpError(0, '服务端返回了 JSON 而非音频二进制，响应格式异常。', 'BAD_RESPONSE');
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer || !buffer.length) throw httpError(0, '服务端返回了空音频，请稍后重试。', 'EMPTY_AUDIO');

  const format = body.response_format;
  const headerRate = Number(res.headers.get('audio/sample-rate') || res.headers.get('x-audio-sample-rate')) || 0;
  const sampleRate = headerRate || NATIVE_SAMPLE_RATE;
  const headerDuration = Number(res.headers.get('x-audio-duration-seconds')) || 0;
  const duration = wavDurationSeconds(buffer) || headerDuration;
  const requestId = res.headers.get('x-request-id') || '';
  return { buffer, format, sampleRate, duration, requestId, mode: opts.mode || 'tts' };
}

/** 测试连接：健康检查 + 模型信息 */
async function testConnection({ baseUrl, apiKey, signal } = {}) {
  return health({ baseUrl, apiKey, signal });
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  NATIVE_SAMPLE_RATE,
  MODES,
  SAMPLE_RATES,
  REF_MIN_SECONDS,
  REF_MAX_SECONDS,
  cleanBase,
  apiUrl,
  clamp,
  renderInput,
  buildSpeechBody,
  buildTtsBody,
  wavDurationSeconds,
  health,
  generate,
  testConnection,
  explainHttpFailure
};
