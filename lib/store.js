'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { safeStorage } = require('electron');

const PROVIDER_TYPES = ['voxcpm', 'dashscope'];

// 首次启动写入的示例服务商：不含任何密钥，Key 由用户在「设置 → API 接入」中自行填写
const DEFAULT_BASE_BY_TYPE = {
  voxcpm: 'http://127.0.0.1:8000',
  dashscope: 'https://dashscope.aliyuncs.com/api/v1'
};

const SEED_PROVIDERS = [
  {
    id: 'voxcpm2-local',
    name: 'VoxCPM2 · 本机服务',
    type: 'voxcpm',
    baseUrl: 'http://127.0.0.1:8000',
    model: 'VoxCPM2',
    apiKey: ''
  },
  {
    id: 'cosyvoice',
    name: '千问 CosyVoice · 百炼',
    type: 'dashscope',
    baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    model: 'cosyvoice-v3.5-plus',
    apiKey: ''
  }
];

const DEFAULT_SETTINGS = {
  providers: [],
  activeProviderId: 'voxcpm2-local',
  format: 'wav',
  sampleRate: 48000,
  historyLimit: 500
};

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
}

function hintOf(secret) {
  if (!secret) return '';
  if (secret.length <= 8) return `${secret.slice(0, 2)}••••`;
  return `${secret.slice(0, 4)}••••${secret.slice(-4)}`;
}

class Store {
  constructor(dir) {
    this.dir = dir;
    this.audioDir = path.join(dir, 'audio');
    this.refsDir = path.join(dir, 'refs');
    fs.mkdirSync(this.audioDir, { recursive: true });
    fs.mkdirSync(this.refsDir, { recursive: true });

    this.settingsFile = path.join(dir, 'settings.json');
    this.historyFile = path.join(dir, 'history.json');
    this.voicesFile = path.join(dir, 'voices.json');

    const fresh = !fs.existsSync(this.settingsFile);
    this.settings = Object.assign({}, DEFAULT_SETTINGS, readJson(this.settingsFile, {}));
    if (!Array.isArray(this.settings.providers)) this.settings.providers = [];
    if (fresh || !this.settings.providers.length) {
      this.settings.providers = SEED_PROVIDERS.map((p) => this.encryptProvider(Object.assign({}, p, { createdAt: Date.now() })));
    }
    this.normalizeProviders();
    this.ensureSeedProviders();
    if (fresh) writeJsonAtomic(this.settingsFile, this.settings);

    const history = readJson(this.historyFile, []);
    this.history = Array.isArray(history) ? history : [];
    this.history = this.history.filter((h) => h && h.id && fs.existsSync(path.join(this.audioDir, h.file || '')));

    const voices = readJson(this.voicesFile, []);
    this.voices = Array.isArray(voices) ? voices.filter((v) => v && v.id) : [];
    this.voices = this.voices.filter((v) => !v.file || fs.existsSync(path.join(this.refsDir, v.file)));
  }

  /* ---------------------------- 加密工具 ---------------------------- */

  encryptSecret(plain) {
    const secret = String(plain || '').trim();
    if (!secret) return { enc: '', plain: '' };
    if (safeStorage.isEncryptionAvailable()) {
      try {
        return { enc: safeStorage.encryptString(secret).toString('base64'), plain: '' };
      } catch (_) {}
    }
    return { enc: '', plain: secret };
  }

  decryptSecret(enc) {
    if (!enc) return '';
    try {
      if (safeStorage.isEncryptionAvailable()) {
        return safeStorage.decryptString(Buffer.from(enc, 'base64'));
      }
    } catch (_) {}
    return '';
  }

  encryptProvider(p) {
    if (typeof p.apiKey === 'string' && p.apiKey.trim()) {
      const { enc, plain } = this.encryptSecret(p.apiKey);
      p.apiKeyEnc = enc;
      p.apiKey = plain;
    }
    return p;
  }

  keyOfProvider(p) {
    if (!p) return '';
    return this.decryptSecret(p.apiKeyEnc) || p.apiKey || '';
  }

  /** 把明文密钥迁移成加密存储 */
  normalizeProviders() {
    let changed = false;
    for (const p of this.settings.providers) {
      if (!p.id) {
        p.id = newId('prov');
        changed = true;
      }
      if (!PROVIDER_TYPES.includes(p.type)) {
        p.type = 'voxcpm';
        changed = true;
      }
      if (!p.name) {
        p.name = p.type === 'dashscope' ? '千问 CosyVoice' : 'VoxCPM2';
        changed = true;
      }
      if (!p.baseUrl) {
        p.baseUrl = DEFAULT_BASE_BY_TYPE[p.type] || DEFAULT_BASE_BY_TYPE.voxcpm;
        changed = true;
      }
      if (!p.model) {
        p.model = p.type === 'dashscope' ? 'cosyvoice-v3.5-plus' : 'VoxCPM2';
        changed = true;
      }
      if (typeof p.apiKey === 'string' && p.apiKey.trim() && safeStorage.isEncryptionAvailable()) {
        const { enc } = this.encryptSecret(p.apiKey);
        if (enc) {
          p.apiKeyEnc = enc;
          p.apiKey = '';
          changed = true;
        }
      }
    }
    const ids = this.settings.providers.map((p) => p.id);
    if (!ids.includes(this.settings.activeProviderId)) {
      this.settings.activeProviderId = ids[0] || '';
      changed = true;
    }
    if (changed) writeJsonAtomic(this.settingsFile, this.settings);
  }

  /** 老版本升级：补齐新增的预设服务商（只补一次） */
  ensureSeedProviders() {
    const version = Number(this.settings.seedVersion) || 0;
    if (version >= 2) return;
    const ids = new Set(this.settings.providers.map((p) => p.id));
    let added = false;
    for (const seed of SEED_PROVIDERS) {
      if (ids.has(seed.id)) continue;
      this.settings.providers.push(this.encryptProvider(Object.assign({}, seed, { createdAt: Date.now() })));
      added = true;
    }
    this.settings.seedVersion = 2;
    if (added) {
      const first = this.settings.providers[0];
      if (!this.settings.activeProviderId && first) this.settings.activeProviderId = first.id;
    }
    writeJsonAtomic(this.settingsFile, this.settings);
  }

  /* ---------------------------- 服务商 ---------------------------- */

  publicProvider(p) {
    const key = this.keyOfProvider(p);
    return {
      id: p.id,
      name: p.name,
      type: p.type,
      baseUrl: p.baseUrl,
      model: p.model,
      keySet: Boolean(key),
      keyHint: hintOf(key),
      createdAt: p.createdAt || 0
    };
  }

  listProviders() {
    return this.settings.providers.map((p) => this.publicProvider(p));
  }

  getProvider(id) {
    return this.settings.providers.find((p) => p.id === id) || null;
  }

  getProviderKey(id) {
    return this.keyOfProvider(this.getProvider(id));
  }

  activeProvider() {
    return this.getProvider(this.settings.activeProviderId) || this.settings.providers[0] || null;
  }

  saveProvider(input = {}) {
    const now = Date.now();
    const id = String(input.id || '').trim();
    const existing = id ? this.getProvider(id) : null;
    const type = PROVIDER_TYPES.includes(input.type) ? input.type : (existing && existing.type) || 'voxcpm';
    const provider = {
      id: existing ? existing.id : newId('prov'),
      name: String(input.name || (existing && existing.name) || (type === 'dashscope' ? '千问 CosyVoice' : 'VoxCPM2')).trim().slice(0, 40),
      type,
      baseUrl: String(input.baseUrl || (existing && existing.baseUrl) || '').trim().slice(0, 300),
      model: String(input.model || (existing && existing.model) || '').trim().slice(0, 80),
      createdAt: (existing && existing.createdAt) || now,
      updatedAt: now
    };
    if (!provider.baseUrl) {
      provider.baseUrl = DEFAULT_BASE_BY_TYPE[type] || DEFAULT_BASE_BY_TYPE.voxcpm;
    }
    if (!provider.model) {
      provider.model = type === 'dashscope' ? 'cosyvoice-v3.5-plus' : 'VoxCPM2';
    }

    if (input.clearApiKey) {
      provider.apiKeyEnc = '';
      provider.apiKey = '';
    } else if (typeof input.apiKey === 'string' && input.apiKey.trim()) {
      const { enc, plain } = this.encryptSecret(input.apiKey.trim());
      provider.apiKeyEnc = enc;
      provider.apiKey = plain;
    } else if (existing) {
      provider.apiKeyEnc = existing.apiKeyEnc || '';
      provider.apiKey = existing.apiKey || '';
    }

    if (existing) {
      const idx = this.settings.providers.indexOf(existing);
      this.settings.providers[idx] = provider;
    } else {
      this.settings.providers.push(provider);
      if (!this.settings.activeProviderId) this.settings.activeProviderId = provider.id;
    }
    writeJsonAtomic(this.settingsFile, this.settings);
    return this.publicProvider(provider);
  }

  removeProvider(id) {
    const idx = this.settings.providers.findIndex((p) => p.id === id);
    if (idx === -1) return false;
    this.settings.providers.splice(idx, 1);
    if (this.settings.activeProviderId === id) {
      this.settings.activeProviderId = this.settings.providers[0] ? this.settings.providers[0].id : '';
    }
    writeJsonAtomic(this.settingsFile, this.settings);
    return true;
  }

  setActiveProvider(id) {
    if (!this.getProvider(id)) return false;
    this.settings.activeProviderId = id;
    writeJsonAtomic(this.settingsFile, this.settings);
    return true;
  }

  /* ---------------------------- 设置 ---------------------------- */

  publicSettings() {
    return {
      providers: this.listProviders(),
      activeProviderId: this.settings.activeProviderId,
      format: this.settings.format,
      sampleRate: this.settings.sampleRate,
      historyLimit: this.settings.historyLimit,
      dataDir: this.dir,
      encryption: safeStorage.isEncryptionAvailable()
    };
  }

  saveSettings(patch = {}) {
    const next = Object.assign({}, this.settings);
    for (const key of ['format', 'sampleRate', 'historyLimit']) {
      if (patch[key] !== undefined && patch[key] !== null) next[key] = patch[key];
    }
    if (patch.activeProviderId && this.getProvider(patch.activeProviderId)) {
      next.activeProviderId = patch.activeProviderId;
    }
    this.settings = next;
    writeJsonAtomic(this.settingsFile, next);
    return this.publicSettings();
  }

  /* ---------------------------- 音色库 ---------------------------- */

  listVoices() {
    return this.voices
      .slice()
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .map((v) => ({ ...v }));
  }

  saveVoice(voice = {}) {
    if (!voice || !voice.id) throw new Error('缺少音色 ID');
    const idx = this.voices.findIndex((v) => v.id === voice.id);
    const prev = idx >= 0 ? this.voices[idx] : null;
    const normalized = {
      id: voice.id,
      providerId: voice.providerId || (prev && prev.providerId) || '',
      type: voice.type || (prev && prev.type) || 'voxcpm',
      name: String(voice.name || (prev && prev.name) || '参考音色').slice(0, 60),
      refId: voice.refId || (prev && prev.refId) || '',
      voiceId: voice.voiceId || (prev && prev.voiceId) || '',
      model: voice.model || (prev && prev.model) || '',
      sourceName: voice.sourceName || (prev && prev.sourceName) || '',
      file: voice.file || (prev && prev.file) || '',
      duration: voice.duration || (prev && prev.duration) || 0,
      bytes: voice.bytes || (prev && prev.bytes) || 0,
      createdAt: voice.createdAt || (prev && prev.createdAt) || Date.now()
    };
    if (idx === -1) this.voices.unshift(normalized);
    else this.voices[idx] = normalized;
    writeJsonAtomic(this.voicesFile, this.voices);
    return { ...normalized };
  }

  deleteVoice(id) {
    const idx = this.voices.findIndex((v) => v.id === id);
    if (idx === -1) return null;
    const [item] = this.voices.splice(idx, 1);
    if (item.file) {
      try {
        fs.unlinkSync(path.join(this.refsDir, item.file));
      } catch (_) {}
    }
    writeJsonAtomic(this.voicesFile, this.voices);
    return item;
  }

  getVoice(id) {
    return this.voices.find((v) => v.id === id) || null;
  }

  /* ---------------------------- 音频文件 ---------------------------- */

  saveRefAudio(fileName, buffer) {
    const file = path.join(this.refsDir, fileName);
    fs.writeFileSync(file, buffer);
    return file;
  }

  refPath(file) {
    return path.join(this.refsDir, file);
  }

  /* ---------------------------- 记录 ---------------------------- */

  listHistory() {
    return this.history.slice(0, 500).map((h) => ({ ...h }));
  }

  addHistory(entry) {
    this.history.unshift(entry);
    const limit = Math.min(500, Math.max(20, Number(this.settings.historyLimit) || 500));
    const kept = this.history.slice(0, limit);
    const dropped = this.history.slice(limit);
    for (const item of dropped) {
      try {
        fs.unlinkSync(path.join(this.audioDir, item.file));
      } catch (_) {}
    }
    this.history = kept;
    writeJsonAtomic(this.historyFile, this.history);
    return entry;
  }

  deleteHistory(id) {
    const idx = this.history.findIndex((h) => h.id === id);
    if (idx === -1) return false;
    const item = this.history[idx];
    this.history.splice(idx, 1);
    try {
      fs.unlinkSync(path.join(this.audioDir, item.file));
    } catch (_) {}
    writeJsonAtomic(this.historyFile, this.history);
    return true;
  }

  clearHistory() {
    for (const item of this.history) {
      try {
        fs.unlinkSync(path.join(this.audioDir, item.file));
      } catch (_) {}
    }
    this.history = [];
    writeJsonAtomic(this.historyFile, this.history);
    return true;
  }

  audioPath(file) {
    return path.join(this.audioDir, file);
  }

  saveAudio(fileName, buffer) {
    const file = path.join(this.audioDir, fileName);
    fs.writeFileSync(file, buffer);
    return file;
  }
}

module.exports = { Store, DEFAULT_SETTINGS, SEED_PROVIDERS, PROVIDER_TYPES };
