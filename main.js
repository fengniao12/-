'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } = require('electron');
const voxcpm = require('./lib/voxcpm');
const cosy = require('./lib/cosyvoice');
const { Store } = require('./lib/store');

const APP_NAME = '语音工坊';
const AUDIO_EXTS = ['wav', 'mp3', 'pcm', 'ogg', 'opus', 'm4a', 'flac', 'aac'];
const MIME = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  pcm: 'audio/wav',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  aac: 'audio/aac'
};

let mainWindow = null;
let store = null;
let activeAbort = null;
let shotPath = null;
let shotView = null;
let shotScene = null;
let shotScript = null;
let openDevtools = false;

function parseArgv() {
  const args = process.argv.slice(1);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--shot') shotPath = path.resolve(process.cwd(), args[i + 1] || 'shot.png');
    else if (args[i] === '--shot-view') shotView = args[i + 1] || null;
    else if (args[i] === '--shot-scene') shotScene = args[i + 1] || null;
    else if (args[i] === '--shot-script') shotScript = path.resolve(process.cwd(), args[i + 1] || '');
    else if (args[i] === '--devtools') openDevtools = true;
  }
}

function makeId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `tts_${stamp}_${Math.random().toString(36).slice(2, 6)}`;
}

function extForFormat(format) {
  if (format === 'ogg_opus' || format === 'ogg' || format === 'opus') return 'ogg';
  return format || 'wav';
}

function mimeOf(ext) {
  return MIME[ext] || 'audio/wav';
}

function providerById(id) {
  return (id && store.getProvider(id)) || store.activeProvider();
}

function providerFor(payload) {
  const p = providerById(payload && payload.providerId);
  if (!p) {
    const err = new Error('还没有配置任何 API，请到「设置 → API 接入」添加一个。');
    err.code = 'NO_PROVIDER';
    throw err;
  }
  return p;
}

function providerKey(p) {
  return p ? store.getProviderKey(p.id) : '';
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 920,
    minWidth: 1080,
    minHeight: 700,
    frame: false,
    show: false,
    backgroundColor: '#faf9ff',
    title: APP_NAME,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'), shotPath ? { query: { shot: '1' } } : undefined);

  mainWindow.webContents.on('console-message', (...args) => {
    const detail = args[1] && typeof args[1] === 'object' ? args[1] : null;
    const level = detail ? detail.level : args[1];
    const message = detail ? detail.message : args[2];
    const line = detail ? detail.lineNumber : args[3];
    console.log(`[renderer:${level}] ${message} (${line || 0})`);
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('DID_FAIL_LOAD', code, desc, url);
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (openDevtools) mainWindow.webContents.openDevTools({ mode: 'detach' });
    if (shotPath) {
      setTimeout(async () => {
        try {
          if (shotScript) {
            const code = fs.readFileSync(shotScript, 'utf8');
            await mainWindow.webContents.executeJavaScript(code);
            await new Promise((r) => setTimeout(r, 900));
          }
          if (shotView || shotScene) {
            const view = ['compose', 'history', 'settings'].includes(shotView) ? shotView : null;
            const sceneMap = {
              provider: '#chipProvider',
              voice: '#chipVoice',
              control: '#chipControl',
              speed: '#chipSpeed',
              format: '#chipFormat',
              generate: '#btnGenerate',
              play: '.hr-play'
            };
            const sceneSel = sceneMap[shotScene] || null;
            await mainWindow.webContents.executeJavaScript(`(async () => {
              const v = ${JSON.stringify(view)};
              if (v) document.querySelector('#viewTabs .tab[data-view="' + v + '"]')?.click();
              const s = ${JSON.stringify(sceneSel)};
              if (s) {
                if (${JSON.stringify(shotScene)} === 'generate') {
                  const ta = document.querySelector('#text');
                  if (ta) {
                    ta.value = '你好，这是语音工坊的合成测试。';
                    ta.dispatchEvent(new Event('input', { bubbles: true }));
                  }
                  await new Promise((r) => setTimeout(r, 200));
                  document.querySelector('#btnGenerate')?.click();
                  await new Promise((r) => setTimeout(r, 800));
                } else {
                  document.querySelector(s)?.click();
                }
              }
              return true;
            })()`);
            await new Promise((r) => setTimeout(r, 700));
          }
          const image = await mainWindow.webContents.capturePage();
          fs.writeFileSync(shotPath, image.toPNG());
          console.log('SHOT_SAVED', shotPath);
        } catch (err) {
          console.error('SHOT_ERROR', err && err.message);
        }
        app.quit();
      }, 2200);
    }
  });

  const sendState = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('window:state', { maximized: mainWindow.isMaximized() });
  };
  mainWindow.on('maximize', sendState);
  mainWindow.on('unmaximize', sendState);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/* ----------------------------- 服务商 ----------------------------- */

async function testProvider(payload = {}) {
  const existing = payload.id ? store.getProvider(payload.id) : null;
  const type = payload.type || (existing && existing.type) || 'voxcpm';
  const baseUrl = String(payload.baseUrl || (existing && existing.baseUrl) || '').trim();
  const model = String(payload.model || (existing && existing.model) || '').trim();
  const apiKey = String(payload.apiKey || '').trim() || (existing ? store.getProviderKey(existing.id) : '');

  if (type === 'dashscope') {
    if (!apiKey) {
      return { ok: false, code: 'NO_KEY', error: '请先填写 DashScope API Key（阿里云百炼）。' };
    }
    const r = await cosy.listVoices({ baseUrl, apiKey, pageSize: 5 });
    return { ok: true, kind: 'dashscope', detail: `连接成功：${r.voices.length} 个音色可读取（模型 ${model || cosy.DEFAULT_MODEL}）` };
  }

  const h = await voxcpm.health({ baseUrl, apiKey });
  if (h.apiKeyRequired && !apiKey) {
    return { ok: false, code: 'NO_KEY', error: '服务要求 API Key，请先填写。' };
  }
  const stateText = h.status === 'loading' ? '模型加载中' : '服务就绪';
  return {
    ok: true,
    kind: 'voxcpm',
    detail: `连接成功：${stateText} · vllm-omni · 模型 ${h.model} · 采样率 ${(h.sampleRate / 1000).toFixed(0)} kHz`,
    health: h
  };
}

/* ----------------------------- 音色 ----------------------------- */

function refFileName(id, ext) {
  return `${id}.${ext || 'wav'}`;
}

function guessExt(name) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  return AUDIO_EXTS.includes(ext) ? ext : 'wav';
}

async function uploadVoice(event, payload = {}) {
  const p = providerFor(payload);
  const apiKey = providerKey(p);
  if (!apiKey) {
    const err = new Error('这个 API 还没有填写 Key，请先到「设置 → API 接入」里补上。');
    err.code = 'NO_KEY';
    throw err;
  }
  if (!payload.audioBase64) {
    const err = new Error('请先上传一段参考音频。');
    err.code = 'NO_AUDIO';
    throw err;
  }
  const buffer = Buffer.from(String(payload.audioBase64).replace(/^data:[^,]*,/, ''), 'base64');
  if (!buffer.length) throw new Error('参考音频读取失败，请重新选择文件。');
  if (buffer.length > 25 * 1024 * 1024) throw new Error('参考音频不能超过 25 MB，请裁剪到 60 秒以内。');

  const id = `v_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const ext = guessExt(payload.name || 'reference.wav');
  const mime = payload.mime || mimeOf(ext);
  const fileName = refFileName(id, ext);
  store.saveRefAudio(fileName, buffer);

  const send = (note) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('voice:progress', { note });
  };

  try {
    if (p.type === 'dashscope') {
      send('正在向千问注册音色（约 10–60 秒）…');
      const result = await cosy.enrollVoice(
        {
          baseUrl: p.baseUrl,
          apiKey,
          audioBase64: buffer.toString('base64'),
          mime,
          model: p.model || cosy.DEFAULT_MODEL,
          prefix: payload.prefix || 'myvoice',
          language: payload.language || 'zh',
          preprocess: false
        },
        {
          signal: activeAbort ? activeAbort.signal : undefined,
          onProgress: (prog) => send(`音色部署中…（${prog.status || 'DEPLOYING'}，第 ${prog.attempt} 次查询）`)
        }
      );
      const voice = store.saveVoice({
        id,
        providerId: p.id,
        type: p.type,
        name: payload.voiceName || String(payload.name || '我的音色').replace(/\.[^.]+$/, '').slice(0, 40),
        voiceId: result.voiceId,
        model: result.targetModel || p.model,
        sourceName: payload.name || '',
        file: fileName,
        duration: payload.duration || 0,
        bytes: buffer.length
      });
      return { ok: true, voice };
    }

    // vllm-omni 没有旧版 /v1/references 注册表：参考音频只存本地，
    // 合成时以 data URI（ref_audio）随请求内联发给服务端。
    if (payload.duration) {
      const d = Number(payload.duration);
      if (Number.isFinite(d) && (d < voxcpm.REF_MIN_SECONDS || d > voxcpm.REF_MAX_SECONDS)) {
        throw new Error(`参考音频时长需在 ${voxcpm.REF_MIN_SECONDS}–${voxcpm.REF_MAX_SECONDS} 秒之间，当前 ${d.toFixed(1)} 秒，请裁剪后重试。`);
      }
    }
    send('正在保存参考音频到本地音色库…');
    const voice = store.saveVoice({
      id,
      providerId: p.id,
      type: p.type,
      name: payload.voiceName || String(payload.name || '参考音色').replace(/\.[^.]+$/, '').slice(0, 40),
      refId: '',
      model: p.model,
      sourceName: payload.name || '',
      file: fileName,
      duration: payload.duration || 0,
      bytes: buffer.length
    });
    return { ok: true, voice };
  } catch (err) {
    try {
      fs.unlinkSync(store.refPath(fileName));
    } catch (_) {}
    throw err;
  }
}

/* ----------------------------- 生成 ----------------------------- */

function voiceLabelFor(payload, provider) {
  if (payload.voiceName) return String(payload.voiceName).slice(0, 60);
  if (payload.control) return '自定义音色';
  return provider.type === 'dashscope' ? 'CosyVoice' : 'VoxCPM2';
}

async function generate(event, payload = {}) {
  const p = providerFor(payload);
  const apiKey = providerKey(p);
  if (!apiKey) {
    return {
      ok: false,
      code: 'NO_KEY',
      providerId: p.id,
      error: `「${p.name}」还没有配置 API Key，请先到「设置 → API 接入」里填写。`
    };
  }
  if (activeAbort) return { ok: false, error: '上一条语音还在生成中，请稍候。' };

  const text = String(payload.text || '').trim();
  if (!text) return { ok: false, error: '文本为空，先写点内容吧。' };
  if (text.length > 2000 && p.type === 'voxcpm') {
    return { ok: false, error: `VoxCPM2 单次最多 2000 字，当前 ${text.length} 字，请分段生成。` };
  }

  const fmt = String(payload.format || 'wav').toLowerCase() === 'mp3' ? 'mp3' : 'wav';
  const speed = Number(payload.speed) || 1;
  const voice = payload.voiceId ? store.getVoice(payload.voiceId) : null;
  if (payload.voiceId && !voice) {
    return { ok: false, code: 'NO_VOICE', error: '这个音色已经不存在了，请重新选择或上传参考音频。' };
  }

  activeAbort = new AbortController();
  const started = Date.now();
  const send = (note) => {
    if (event.sender && !event.sender.isDestroyed()) {
      event.sender.send('tts:progress', { note, elapsed: Date.now() - started });
    }
  };

  try {
    let buffer = null;
    let format = fmt;
    let sampleRate = 48000;
    let duration = 0;
    let mode = 'design';
    let requestId = '';
    let characters = 0;

    if (p.type === 'voxcpm') {
      if (voice) {
        mode = payload.mode === 'hifi' ? 'hifi' : 'clone';
        send(mode === 'hifi' ? '正在做极致克隆，相似度优先，可能需要几十秒…' : '正在克隆参考音色并合成…');
      } else {
        mode = payload.control && String(payload.control).trim() ? 'design' : 'tts';
        send(mode === 'design' ? '正在按音色描述合成语音…' : '正在合成语音…');
      }
      // 克隆/极致克隆：把本地参考音频读成 data URI 随请求内联（vllm-omni ref_audio）
      let referenceAudio = '';
      if (voice) {
        const refBuf = fs.readFileSync(store.refPath(voice.file));
        const refMime = mimeOf(guessExt(voice.file));
        referenceAudio = `data:${refMime};base64,${refBuf.toString('base64')}`;
      }
      const out = await voxcpm.generate(
        {
          baseUrl: p.baseUrl,
          apiKey,
          text,
          mode,
          control: payload.control,
          referenceAudio,
          promptText: payload.promptText,
          format: fmt
        },
        { signal: activeAbort.signal }
      );
      buffer = out.buffer;
      format = out.format;
      sampleRate = out.sampleRate;
      duration = out.duration;
      requestId = out.requestId;
    } else {
      if (!voice || !voice.voiceId) {
        return { ok: false, code: 'NO_VOICE', error: '千问 CosyVoice 需要先上传参考音频注册一个音色。' };
      }
      mode = 'cosy';
      send('正在请求 CosyVoice 合成…');
      const synth = await cosy.synthesize(
        {
          baseUrl: p.baseUrl,
          apiKey,
          model: p.model || cosy.DEFAULT_MODEL,
          voice: voice.voiceId,
          text,
          format: fmt,
          sampleRate: payload.sampleRate || 24000,
          speed,
          instruction: payload.instruction || payload.control || ''
        },
        { signal: activeAbort.signal }
      );
      send('合成完成，正在下载音频…');
      buffer = await cosy.downloadAudio(synth.url, { signal: activeAbort.signal });
      format = synth.format;
      sampleRate = synth.sampleRate;
      characters = synth.characters || 0;
      requestId = synth.requestId || '';
    }

    const ext = extForFormat(format);
    const id = makeId();
    const fileName = `${id}.${ext}`;
    store.saveAudio(fileName, buffer);

    const entry = {
      id,
      file: fileName,
      providerId: p.id,
      providerName: p.name,
      providerType: p.type,
      model: p.model,
      mode,
      text,
      voiceId: voice ? voice.id : '',
      voiceName: voice ? voice.name : voiceLabelFor(payload, p),
      control: String(payload.control || '').slice(0, 400),
      promptText: mode === 'hifi' ? String(payload.promptText || '') : '',
      format,
      sampleRate,
      bytes: buffer.length,
      duration,
      speed,
      createdAt: Date.now()
    };
    store.addHistory(entry);

    return {
      ok: true,
      entry,
      audio: buffer.toString('base64'),
      mime: mimeOf(ext),
      elapsed: Date.now() - started,
      usage: characters ? { characters } : null,
      logId: requestId
    };
  } catch (err) {
    if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) {
      return { ok: false, error: '已取消生成。', code: 'ABORTED' };
    }
    return { ok: false, error: err.message, code: err.code || '' };
  } finally {
    activeAbort = null;
  }
}

/* ----------------------------- IPC ----------------------------- */

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    name: APP_NAME,
    version: app.getVersion(),
    dataDir: store.dir,
    platform: process.platform,
    encryption: safeStorage.isEncryptionAvailable()
  }));

  ipcMain.handle('window:minimize', () => mainWindow && mainWindow.minimize());
  ipcMain.handle('window:toggleMaximize', () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });
  ipcMain.handle('window:close', () => mainWindow && mainWindow.close());

  ipcMain.handle('settings:get', () => store.publicSettings());
  ipcMain.handle('settings:save', (_e, patch) => ({ ok: true, settings: store.saveSettings(patch || {}) }));

  ipcMain.handle('providers:list', () => ({
    ok: true,
    providers: store.listProviders(),
    activeProviderId: store.settings.activeProviderId
  }));

  ipcMain.handle('providers:save', (_e, payload) => {
    try {
      const provider = store.saveProvider(payload || {});
      return { ok: true, provider, settings: store.publicSettings() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('providers:remove', (_e, id) => {
    const ok = store.removeProvider(id);
    return { ok, settings: store.publicSettings() };
  });

  ipcMain.handle('providers:activate', (_e, id) => ({ ok: store.setActiveProvider(id), settings: store.publicSettings() }));

  ipcMain.handle('providers:test', async (_e, payload) => {
    try {
      const r = await testProvider(payload || {});
      return r;
    } catch (err) {
      return { ok: false, error: err.message, code: err.code || '' };
    }
  });

  ipcMain.handle('voices:list', () => ({ ok: true, voices: store.listVoices() }));

  ipcMain.handle('voices:upload', async (event, payload) => {
    if (activeAbort) return { ok: false, error: '上一项任务还在进行中，请稍候。' };
    activeAbort = new AbortController();
    try {
      return await uploadVoice(event, payload || {});
    } catch (err) {
      if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) {
        return { ok: false, error: '已取消。', code: 'ABORTED' };
      }
      return { ok: false, error: err.message, code: err.code || '' };
    } finally {
      activeAbort = null;
    }
  });

  ipcMain.handle('voices:remove', async (_e, id) => {
    const voice = store.getVoice(id);
    if (!voice) return { ok: false, error: '这个音色已经不存在了。' };
    let remoteError = '';
    const p = store.getProvider(voice.providerId);
    const apiKey = p ? store.getProviderKey(p.id) : '';
    if (p && apiKey) {
      try {
        // vllm-omni 版 VoxCPM2 音色只存本地，无服务端注册表，无需远程删除
        if (voice.type === 'dashscope' && voice.voiceId) {
          await cosy.deleteVoice({ baseUrl: p.baseUrl, apiKey, voiceId: voice.voiceId });
        }
      } catch (err) {
        remoteError = err.message;
      }
    }
    store.deleteVoice(id);
    return { ok: true, remoteError };
  });

  ipcMain.handle('tts:generate', (event, payload) => generate(event, payload || {}));

  ipcMain.handle('tts:cancel', () => {
    if (activeAbort) activeAbort.abort();
    return { ok: true };
  });

  ipcMain.handle('history:list', () => ({ items: store.listHistory(), audioDir: store.audioDir }));

  ipcMain.handle('history:audio', (_e, id) => {
    const item = store.listHistory().find((h) => h.id === id);
    if (!item) return { ok: false, error: '记录不存在或音频已被删除。' };
    try {
      const buffer = fs.readFileSync(store.audioPath(item.file));
      return { ok: true, base64: buffer.toString('base64'), mime: mimeOf(extForFormat(item.format)), ext: extForFormat(item.format) };
    } catch (err) {
      return { ok: false, error: '读取音频失败：' + err.message };
    }
  });

  ipcMain.handle('voice:audio', (_e, id) => {
    const voice = store.getVoice(id);
    if (!voice || !voice.file) return { ok: false, error: '找不到这个音色的参考音频。' };
    try {
      const buffer = fs.readFileSync(store.refPath(voice.file));
      return { ok: true, base64: buffer.toString('base64'), mime: mimeOf(guessExt(voice.file)) };
    } catch (err) {
      return { ok: false, error: '读取参考音频失败：' + err.message };
    }
  });

  ipcMain.handle('history:delete', (_e, id) => ({ ok: store.deleteHistory(id) }));
  ipcMain.handle('history:clear', () => ({ ok: store.clearHistory() }));
  ipcMain.handle('history:reveal', (_e, id) => {
    const item = id ? store.listHistory().find((h) => h.id === id) : null;
    if (item) shell.showItemInFolder(store.audioPath(item.file));
    else shell.openPath(store.dir);
    return { ok: true };
  });

  ipcMain.handle('audio:pick', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择参考音频',
      properties: ['openFile'],
      filters: [
        { name: '音频文件', extensions: AUDIO_EXTS },
        { name: '所有文件', extensions: ['*'] }
      ]
    });
    if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
    const filePath = result.filePaths[0];
    const ext = path.extname(filePath).slice(1).toLowerCase();
    if (!AUDIO_EXTS.includes(ext)) {
      return { ok: false, error: '不支持的音频格式，请选择 wav / mp3 / m4a / flac / ogg 文件。' };
    }
    const size = fs.statSync(filePath).size;
    if (size > 25 * 1024 * 1024) {
      return { ok: false, error: `参考音频不能超过 25 MB，当前 ${(size / 1024 / 1024).toFixed(1)} MB。` };
    }
    try {
      const buffer = fs.readFileSync(filePath);
      return {
        ok: true,
        name: path.basename(filePath),
        size,
        ext,
        mime: mimeOf(ext),
        base64: buffer.toString('base64')
      };
    } catch (err) {
      return { ok: false, error: '读取文件失败：' + err.message };
    }
  });

  ipcMain.handle('file:saveAs', async (_e, { id, suggestedName } = {}) => {
    const item = store.listHistory().find((h) => h.id === id);
    if (!item) return { ok: false, error: '这条记录已经不存在了。' };
    const src = store.audioPath(item.file);
    const ext = extForFormat(item.format);
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '保存音频',
      defaultPath: suggestedName || `${item.id}.${ext}`,
      filters: [{ name: `${ext.toUpperCase()} 音频`, extensions: [ext] }]
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    try {
      fs.copyFileSync(src, result.filePath);
      return { ok: true, path: result.filePath };
    } catch (err) {
      return { ok: false, error: '保存失败：' + err.message };
    }
  });

  ipcMain.handle('shell:openPath', (_e, target) => shell.openPath(target || store.dir));
  ipcMain.handle('shell:showItem', (_e, target) => {
    if (target) shell.showItemInFolder(target);
    else shell.openPath(store.dir);
    return true;
  });
}

app.whenReady().then(() => {
  app.setName(APP_NAME);
  app.setAppUserModelId('com.voice.studio');
  // 固定数据目录为 %APPDATA%\语音工坊，避免受 package.json 名称或旧版本缓存影响
  app.setPath('userData', path.join(app.getPath('appData'), APP_NAME));
  store = new Store(app.getPath('userData'));
  parseArgv();
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT', err);
});
