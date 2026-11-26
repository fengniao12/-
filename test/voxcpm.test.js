/*
 * lib/voxcpm.js 的离线单元测试（vllm-omni 版）：全部用 mock fetch 模拟 vLLM 服务。
 * 运行：node test/voxcpm.test.js
 */
'use strict';

const assert = require('assert');
const vox = require('../lib/voxcpm');

let passed = 0;
const failures = [];

function makeRes({ status = 200, json, text, buffer, headers = {} } = {}) {
  const lower = {};
  Object.keys(headers).forEach((k) => {
    lower[String(k).toLowerCase()] = headers[k];
  });
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => lower[String(name).toLowerCase()] ?? null },
    async json() {
      if (json !== undefined) return json;
      throw new Error('no json');
    },
    async text() {
      if (text !== undefined) return text;
      if (json !== undefined) return JSON.stringify(json);
      return '';
    },
    async arrayBuffer() {
      if (buffer) return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
      return new ArrayBuffer(0);
    }
  };
}

function collect() {
  const calls = [];
  global.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return calls;
}

let handler = () => makeRes({});

async function run(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL ${name}`);
    console.log(`       ${err && err.stack ? err.stack.split('\n').slice(0, 2).join(' | ') : err}`);
  }
}

/** 拼一个最小合法 PCM WAV（单/多声道、16bit） */
function makeWav({ sampleRate = 8000, channels = 1, frames = 8000 } = {}) {
  const bytesPerSample = 2;
  const dataBytes = frames * channels * bytesPerSample;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buf.writeUInt16LE(channels * bytesPerSample, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  return buf;
}

(async () => {
  console.log('lib/voxcpm.js (vllm-omni)');

  await run('cleanBase 自动补协议并截掉 /v1、/api/v1', () => {
    assert.strictEqual(vox.cleanBase('tts.example.com:8000'), 'http://tts.example.com:8000');
    assert.strictEqual(vox.cleanBase('http://127.0.0.1:8000/v1/'), 'http://127.0.0.1:8000');
    assert.strictEqual(vox.cleanBase('https://a.example.com/api/v1'), 'https://a.example.com');
    assert.strictEqual(vox.cleanBase('http://h/v1/audio/speech'), 'http://h');
    assert.strictEqual(vox.cleanBase(''), vox.DEFAULT_BASE_URL);
  });

  await run('apiUrl 拼接路径', () => {
    assert.strictEqual(vox.apiUrl('http://h:8000/', '/v1/audio/speech'), 'http://h:8000/v1/audio/speech');
  });

  await run('renderInput：非 hifi 且有 control 包控制指令，hifi/无 control 发原文', () => {
    assert.strictEqual(vox.renderInput('design', '你好', '年轻女声'), '(年轻女声)你好');
    assert.strictEqual(vox.renderInput('tts', '你好'), '你好');
    assert.strictEqual(vox.renderInput('hifi', '你好', '被忽略'), '你好');
    assert.strictEqual(vox.renderInput('clone', '你好', ''), '你好');
  });

  await run('buildSpeechBody tts 默认形状', () => {
    const body = vox.buildSpeechBody({ text: '  你好世界  ' });
    assert.strictEqual(body.model, vox.DEFAULT_MODEL);
    assert.strictEqual(body.input, '你好世界');
    assert.strictEqual(body.voice, 'default');
    assert.strictEqual(body.response_format, 'wav');
    assert.strictEqual(body.stream, false);
    assert.strictEqual(body.ref_audio, undefined);
  });

  await run('buildSpeechBody design 渲染控制指令 + mp3', () => {
    const body = vox.buildSpeechBody({
      text: '你好世界',
      mode: 'design',
      control: '  年轻女性，声音轻柔  ',
      format: 'mp3'
    });
    assert.strictEqual(body.input, '(年轻女性，声音轻柔)你好世界');
    assert.strictEqual(body.response_format, 'mp3');
  });

  await run('buildSpeechBody 校验空文本 / 超长', () => {
    assert.throws(() => vox.buildSpeechBody({ text: '   ' }), /文本为空/);
    assert.throws(() => vox.buildSpeechBody({ text: 'a'.repeat(2001) }), /文本超长/);
  });

  await run('buildSpeechBody 克隆必须带参考音频，hifi 必须带原话', () => {
    assert.throws(() => vox.buildSpeechBody({ text: 'hi', mode: 'clone' }), /参考音频/);
    assert.throws(() => vox.buildSpeechBody({ text: 'hi', mode: 'hifi' }), /参考音频/);
    assert.throws(
      () => vox.buildSpeechBody({ text: 'hi', mode: 'hifi', referenceAudio: 'data:audio/wav;base64,AAA' }),
      /原话/
    );
    const body = vox.buildSpeechBody({
      text: 'hi',
      mode: 'hifi',
      referenceAudio: 'data:audio/wav;base64,AAA',
      promptText: '  这是原话  '
    });
    assert.strictEqual(body.ref_audio, 'data:audio/wav;base64,AAA');
    assert.strictEqual(body.ref_text, '这是原话');
  });

  await run('buildSpeechBody clone 内联 ref_audio 与 seed 透传', () => {
    const body = vox.buildSpeechBody({
      text: 'hi',
      mode: 'clone',
      referenceAudio: 'data:audio/wav;base64,QUJD',
      seed: '42'
    });
    assert.strictEqual(body.ref_audio, 'data:audio/wav;base64,QUJD');
    assert.strictEqual(body.seed, 42);
    const noSeed = vox.buildSpeechBody({ text: 'hi', seed: '' });
    assert.strictEqual(noSeed.seed, undefined);
  });

  await run('buildTtsBody 是 buildSpeechBody 的别名', () => {
    assert.strictEqual(vox.buildTtsBody, vox.buildSpeechBody);
  });

  await run('wavDurationSeconds 解析 WAV，非法缓冲返回 0', () => {
    const wav = makeWav({ sampleRate: 8000, channels: 1, frames: 8000 }); // 1.0s
    assert.strictEqual(vox.wavDurationSeconds(wav), 1.0);
    const stereo = makeWav({ sampleRate: 16000, channels: 2, frames: 16000 }); // 1.0s
    assert.strictEqual(vox.wavDurationSeconds(stereo), 1.0);
    assert.strictEqual(vox.wavDurationSeconds(Buffer.from('RIFFmockwav')), 0);
    assert.strictEqual(vox.wavDurationSeconds(Buffer.alloc(0)), 0);
  });

  await run('health 就绪：先 /health 再 /v1/models 读服务名', async () => {
    const calls = collect();
    handler = (url) => {
      if (url.endsWith('/health')) return makeRes({ status: 200 });
      if (url.endsWith('/v1/models')) return makeRes({ json: { data: [{ id: 'voxcpm2' }] } });
      return makeRes({ status: 404 });
    };
    const info = await vox.health({ baseUrl: 'http://127.0.0.1:8000', apiKey: 'k' });
    assert.strictEqual(calls[0].url, 'http://127.0.0.1:8000/health');
    assert.strictEqual(calls[1].url, 'http://127.0.0.1:8000/v1/models');
    assert.strictEqual(calls[0].init.headers.Authorization, 'Bearer k');
    assert.strictEqual(info.status, 'ok');
    assert.strictEqual(info.model, 'voxcpm2');
    assert.strictEqual(info.sampleRate, 48000);
    assert.strictEqual(info.busy, false);
    assert.strictEqual(info.apiKeyRequired, true);
    assert.deepStrictEqual(info.gpu, []);
  });

  await run('health 503 判定为加载中且不再请求 models', async () => {
    const calls = collect();
    handler = () => makeRes({ status: 503, text: 'loading' });
    const info = await vox.health({ baseUrl: 'http://127.0.0.1:8000' });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(info.status, 'loading');
    assert.strictEqual(info.busy, true);
  });

  await run('health 无 Key 遇 401 判定为 unauthorized', async () => {
    collect();
    handler = (url) => {
      if (url.endsWith('/health')) return makeRes({ status: 200 });
      return makeRes({ status: 401, text: JSON.stringify({ error: { message: 'missing key' } }) });
    };
    const info = await vox.health({ baseUrl: 'http://127.0.0.1:8000' });
    assert.strictEqual(info.status, 'unauthorized');
    assert.strictEqual(info.apiKeyRequired, true);
  });

  await run('generate POST /v1/audio/speech 并解析二进制音频与响应头', async () => {
    const calls = collect();
    const wav = makeWav({ sampleRate: 48000, frames: 48000 }); // 1.0s
    handler = () =>
      makeRes({
        buffer: wav,
        headers: {
          'content-type': 'audio/wav',
          'audio/sample-rate': '48000',
          'x-audio-duration-seconds': '2.5',
          'x-request-id': 'req-bin'
        }
      });
    const out = await vox.generate({ baseUrl: 'http://127.0.0.1:8000', apiKey: 'k', text: '你好', mode: 'tts' });
    const sent = JSON.parse(calls[0].init.body);
    assert.strictEqual(calls[0].url, 'http://127.0.0.1:8000/v1/audio/speech');
    assert.strictEqual(calls[0].init.headers.Authorization, 'Bearer k');
    assert.strictEqual(sent.input, '你好');
    assert.strictEqual(sent.voice, 'default');
    assert.strictEqual(sent.stream, false);
    assert.strictEqual(out.buffer.length, wav.length);
    assert.strictEqual(out.sampleRate, 48000);
    assert.strictEqual(out.duration, 1.0, 'WAV 自身时长优先于响应头');
    assert.strictEqual(out.requestId, 'req-bin');
    assert.strictEqual(out.format, 'wav');
  });

  await run('generate 非 WAV 缓冲回退到响应头时长', async () => {
    collect();
    handler = () =>
      makeRes({
        buffer: Buffer.from([0x49, 0x44, 0x33]), // 伪造 mp3 帧头
        headers: { 'content-type': 'audio/mpeg', 'x-audio-duration-seconds': '3.2' }
      });
    const out = await vox.generate({ baseUrl: 'http://127.0.0.1:8000', text: 'hi', format: 'mp3' });
    assert.strictEqual(out.format, 'mp3');
    assert.strictEqual(out.sampleRate, 48000, '缺采样率头时回退原生 48k');
    assert.strictEqual(out.duration, 3.2);
  });

  await run('generate clone 请求体内联 ref_audio，hifi 带 ref_text', async () => {
    const calls = collect();
    handler = () => makeRes({ buffer: makeWav({ frames: 8000 }), headers: { 'content-type': 'audio/wav' } });
    await vox.generate({
      baseUrl: 'http://127.0.0.1:8000',
      text: 'hi',
      mode: 'clone',
      referenceAudio: 'data:audio/wav;base64,QUJD'
    });
    let sent = JSON.parse(calls[0].init.body);
    assert.strictEqual(sent.ref_audio, 'data:audio/wav;base64,QUJD');
    assert.strictEqual(sent.ref_text, undefined);

    await vox.generate({
      baseUrl: 'http://127.0.0.1:8000',
      text: 'hi',
      mode: 'hifi',
      referenceAudio: 'data:audio/wav;base64,QUJD',
      promptText: '原话'
    });
    sent = JSON.parse(calls[1].init.body);
    assert.strictEqual(sent.ref_audio, 'data:audio/wav;base64,QUJD');
    assert.strictEqual(sent.ref_text, '原话');
  });

  await run('generate 收到 JSON 错误体或空音频时拒绝', async () => {
    collect();
    handler = () =>
      makeRes({ status: 200, json: { error: { message: 'boom' } }, headers: { 'content-type': 'application/json' } });
    await assert.rejects(() => vox.generate({ baseUrl: 'http://127.0.0.1:8000', text: 'hi' }));

    collect();
    handler = () => makeRes({ buffer: Buffer.alloc(0), headers: { 'content-type': 'audio/wav' } });
    await assert.rejects(() => vox.generate({ baseUrl: 'http://127.0.0.1:8000', text: 'hi' }), /空音频/);
  });

  await run('generate 401 / 5xx / 网络失败给出中文可操作提示', async () => {
    collect();
    handler = () =>
      makeRes({ status: 401, text: JSON.stringify({ error: { message: 'invalid api key' } }) });
    await assert.rejects(
      () => vox.generate({ baseUrl: 'http://127.0.0.1:8000', text: 'hi' }),
      (err) => {
        assert.strictEqual(err.code, 'AUTH');
        assert.match(err.message, /API Key/);
        assert.match(err.message, /invalid api key/);
        return true;
      }
    );

    collect();
    handler = () => makeRes({ status: 503, text: 'busy' });
    await assert.rejects(
      () => vox.generate({ baseUrl: 'http://127.0.0.1:8000', text: 'hi' }),
      (err) => {
        assert.strictEqual(err.code, 'SERVER');
        assert.match(err.message, /稍后再试/);
        return true;
      }
    );

    collect();
    handler = () => {
      throw new Error('fetch failed');
    };
    await assert.rejects(
      () => vox.generate({ baseUrl: 'http://127.0.0.1:8000', text: 'hi' }),
      (err) => {
        assert.strictEqual(err.code, 'NETWORK');
        assert.match(err.message, /启动VoxCPM隧道/);
        return true;
      }
    );
  });

  await run('testConnection 复用 health', async () => {
    collect();
    handler = (url) => {
      if (url.endsWith('/health')) return makeRes({ status: 200 });
      return makeRes({ json: { data: [{ id: 'voxcpm2' }] } });
    };
    const info = await vox.testConnection({ baseUrl: 'http://127.0.0.1:8000', apiKey: 'k' });
    assert.strictEqual(info.status, 'ok');
    assert.strictEqual(info.model, 'voxcpm2');
  });

  console.log('');
  if (failures.length) {
    console.log(`${passed} passed, ${failures.length} failed`);
    process.exit(1);
  }
  console.log(`${passed} passed`);
})();
