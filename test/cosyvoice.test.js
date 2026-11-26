'use strict';

/**
 * lib/cosyvoice.js 的离线自测：用 mock fetch 验证注册、轮询、合成与错误文案。
 * 运行：node test/cosyvoice.test.js
 */

const assert = require('node:assert');
const cosy = require('../lib/cosyvoice');

const originalFetch = global.fetch;
const BASE = 'https://example.test/api/v1';

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function withFetch(handler, fn) {
  global.fetch = handler;
  try {
    return await fn();
  } finally {
    global.fetch = originalFetch;
  }
}

function testCleanBase() {
  assert.equal(cosy.cleanBase('https://x/api/v1/'), 'https://x/api/v1');
  assert.equal(cosy.cleanBase('https://x/api/v1/services/audio/tts/customization'), 'https://x/api/v1');
  assert.throws(() => cosy.cleanBase('https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1'), /WorkspaceId/);
  assert.throws(() => cosy.cleanBase('ftp://x/api/v1'), /http/);
}

async function testCreateVoicePayload() {
  const calls = [];
  const voice = await withFetch(
    async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body), auth: opts.headers.Authorization });
      return json(200, {
        request_id: 'req-1',
        output: { voice_id: 'cosyvoice-v3.5-plus-myvoice-20261119', status: 'DEPLOYING', target_model: 'cosyvoice-v3.5-plus' }
      });
    },
    () =>
      cosy.createVoice({
        baseUrl: BASE,
        apiKey: 'sk-test',
        audioBase64: 'QUJD',
        mime: 'audio/mpeg',
        model: 'cosyvoice-v3.5-plus',
        prefix: 'My-Voice!',
        language: 'zh'
      })
  );
  assert.equal(voice.voiceId, 'cosyvoice-v3.5-plus-myvoice-20261119');
  assert.equal(voice.status, 'DEPLOYING');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/services\/audio\/tts\/customization$/);
  assert.equal(calls[0].auth, 'Bearer sk-test');
  assert.equal(calls[0].body.model, 'voice-enrollment');
  assert.equal(calls[0].body.input.action, 'create_voice');
  assert.equal(calls[0].body.input.target_model, 'cosyvoice-v3.5-plus');
  assert.equal(calls[0].body.input.prefix, 'myvoice');
  assert.equal(calls[0].body.input.audio, 'data:audio/mpeg;base64,QUJD');
  assert.deepEqual(calls[0].body.input.language_hints, ['zh']);
}

async function testEnrollPollsUntilOk() {
  let queryCount = 0;
  const progress = [];
  const voice = await withFetch(
    async (url, opts) => {
      const input = JSON.parse(opts.body).input;
      if (input.action === 'create_voice') {
        return json(200, { output: { voice_id: 'voice-1', status: 'DEPLOYING' } });
      }
      queryCount += 1;
      return json(200, { output: { voice_id: 'voice-1', status: queryCount >= 2 ? 'OK' : 'DEPLOYING' } });
    },
    () =>
      cosy.enrollVoice(
        { baseUrl: BASE, apiKey: 'sk-test', audioBase64: 'QUJD', mime: 'audio/wav', model: 'cosyvoice-v3.5-plus', prefix: 'myvoice' },
        { intervalMs: 5, maxAttempts: 4, onProgress: (p) => progress.push(p) }
      )
  );
  assert.equal(voice.status, 'OK');
  assert.equal(voice.attempts, 2);
  assert.equal(queryCount, 2);
  assert.equal(progress.length, 2);
  assert.equal(progress[0].status, 'DEPLOYING');
  assert.equal(progress[1].status, 'OK');
}

async function testEnrollUndeployedFails() {
  await withFetch(
    async (url, opts) => {
      const input = JSON.parse(opts.body).input;
      if (input.action === 'create_voice') return json(200, { output: { voice_id: 'v', status: 'DEPLOYING' } });
      return json(200, { output: { voice_id: 'v', status: 'UNDEPLOYED' } });
    },
    async () => {
      await assert.rejects(
        cosy.enrollVoice(
          { baseUrl: BASE, apiKey: 'k', audioBase64: 'QUJD', mime: 'audio/wav', model: 'm', prefix: 'p' },
          { intervalMs: 5, maxAttempts: 2 }
        ),
        /UNDEPLOYED/
      );
    }
  );
}

async function testSynthesizePayload() {
  const calls = [];
  const result = await withFetch(
    async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      return json(200, {
        request_id: 'req-2',
        output: { audio: { url: 'https://audio.example.test/voice.mp3' } },
        usage: { characters: 12 }
      });
    },
    () =>
      cosy.synthesize({
        baseUrl: BASE,
        apiKey: 'sk-test',
        model: 'cosyvoice-v3.5-plus',
        voice: 'voice-1',
        text: '你好呀',
        format: 'ogg_opus',
        sampleRate: 12345,
        speed: 3,
        instruction: '用兴奋的语气'
      })
  );
  assert.equal(result.url, 'https://audio.example.test/voice.mp3');
  assert.equal(result.characters, 12);
  assert.equal(result.format, 'opus');
  assert.equal(result.sampleRate, 22050);
  assert.match(calls[0].url, /\/services\/audio\/tts\/SpeechSynthesizer$/);
  assert.equal(calls[0].body.model, 'cosyvoice-v3.5-plus');
  assert.equal(calls[0].body.input.text, '你好呀');
  assert.equal(calls[0].body.input.voice, 'voice-1');
  assert.equal(calls[0].body.input.format, 'opus');
  assert.equal(calls[0].body.input.rate, 2);
  assert.equal(calls[0].body.input.instruction, '用兴奋的语气');
  assert.equal(calls[0].body.input.sample_rate, 22050);
}

async function testDownloadAudio() {
  await withFetch(
    async () => new Response(Buffer.from('RIFFfake'), { status: 200 }),
    async () => {
      const buf = await cosy.downloadAudio('https://audio.example.test/a.wav');
      assert.equal(buf.length, 8);
    }
  );
  await withFetch(
    async () => new Response('missing', { status: 404 }),
    async () => {
      await assert.rejects(cosy.downloadAudio('https://audio.example.test/a.wav'), /HTTP 404/);
    }
  );
}

async function testAuthError() {
  await withFetch(
    async () => json(401, { code: 'InvalidApiKey', message: 'Invalid API-key provided.' }),
    async () => {
      await assert.rejects(
        cosy.listVoices({ baseUrl: BASE, apiKey: 'bad', prefix: 'myvoice', pageSize: 5 }),
        (err) => {
          assert.match(err.message, /DashScope API Key 无效/);
          assert.equal(err.status, 401);
          return true;
        }
      );
    }
  );
}

async function testListAndDelete() {
  const calls = [];
  await withFetch(
    async (url, opts) => {
      const input = JSON.parse(opts.body).input;
      calls.push(input);
      if (input.action === 'list_voice') {
        return json(200, { output: { voice_list: [{ voice_id: 'a', target_model: 'm', status: 'OK' }], total_count: 1 } });
      }
      return json(200, { request_id: 'req-3' });
    },
    async () => {
      const r = await cosy.listVoices({ baseUrl: BASE, apiKey: 'k', prefix: 'myvoice' });
      assert.equal(r.voices[0].voiceId, 'a');
      assert.equal(r.voices[0].status, 'OK');
      assert.equal(calls[0].action, 'list_voice');
      assert.equal(calls[0].prefix, 'myvoice');

      await cosy.deleteVoice({ baseUrl: BASE, apiKey: 'k', voiceId: 'a' });
      assert.equal(calls[1].action, 'delete_voice');
      assert.equal(calls[1].voice_id, 'a');
    }
  );
}

async function main() {
  const tests = [
    ['cleanBase', testCleanBase],
    ['createVoice 请求体', testCreateVoicePayload],
    ['enrollVoice 轮询到 OK', testEnrollPollsUntilOk],
    ['enrollVoice UNDEPLOYED', testEnrollUndeployedFails],
    ['synthesize 请求体', testSynthesizePayload],
    ['downloadAudio', testDownloadAudio],
    ['401 错误文案', testAuthError],
    ['list / delete', testListAndDelete]
  ];
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`PASS  ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL  ${name}`);
      console.error('      ' + (err && err.message));
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
}

main();
