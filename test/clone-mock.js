'use strict';

/** 本地 DashScope 模拟服务，用于无真实 Key 时端到端联调（端口 7788）。 */

const http = require('node:http');

function wavBuffer(seconds = 1, rate = 24000) {
  const samples = Math.floor(seconds * rate);
  const dataSize = samples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000);
    buf.writeInt16LE(v, 44 + i * 2);
  }
  return buf;
}

const AUDIO = wavBuffer(1.2);
const VOICE_ID = 'cosyvoice-v3.5-plus-mockvoice-20261119';

function send(res, status, body) {
  const data = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': data.length });
  res.end(data);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/audio') {
    res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': AUDIO.length });
    res.end(AUDIO);
    return;
  }
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw); } catch (_) {}
    if (req.headers.authorization !== 'Bearer mock-clone-key') {
      send(res, 401, { code: 'InvalidApiKey', message: 'Invalid API-key provided.' });
      return;
    }
    if (url.pathname.endsWith('/services/audio/tts/customization')) {
      const input = body.input || {};
      if (input.action === 'create_voice') {
        send(res, 200, { request_id: 'mock-create', output: { voice_id: VOICE_ID, status: 'OK', target_model: input.target_model } });
        return;
      }
      if (input.action === 'query_voice') {
        send(res, 200, { request_id: 'mock-query', output: { voice_id: input.voice_id, status: 'OK', target_model: 'cosyvoice-v3.5-plus' } });
        return;
      }
      if (input.action === 'list_voice') {
        send(res, 200, {
          request_id: 'mock-list',
          output: { total_count: 1, voice_list: [{ voice_id: VOICE_ID, target_model: 'cosyvoice-v3.5-plus', status: 'OK', gmt_create: '2026-11-19 17:00:00' }] }
        });
        return;
      }
      send(res, 200, { request_id: 'mock-delete', output: {} });
      return;
    }
    if (url.pathname.endsWith('/services/audio/tts/SpeechSynthesizer')) {
      send(res, 200, {
        request_id: 'mock-tts',
        output: { finish_reason: 'stop', audio: { url: 'http://127.0.0.1:7788/audio', id: 'mock-audio', expires_at: '2026-11-20T17:00:00Z' } },
        usage: { characters: String(body.input?.text || '').length }
      });
      return;
    }
    send(res, 404, { message: 'not found' });
  });
});

server.listen(7788, '127.0.0.1', () => console.log('mock clone server on http://127.0.0.1:7788'));
