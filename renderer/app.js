'use strict';

/* 语音工坊 · 渲染进程 */

(() => {
  const PRESETS = window.VOICE_PRESETS || [];
  const FORMATS = window.AUDIO_FORMATS || [];
  const LANGS = window.TTS_LANGUAGES || [];
  const CONTROL_EXAMPLES = window.CONTROL_EXAMPLES || [];

  const PREFS_KEY = 'yuyin.studio.prefs.v1';
  const MAX_TEXT = 2000;
  const TYPE_LABEL = { voxcpm: 'VoxCPM2', dashscope: '千问 CosyVoice' };
  const providerMetaText = (p) => {
    const label = TYPE_LABEL[p.type] || p.type || '';
    const model = String(p.model || '');
    const dup = model && (model.toLowerCase() === String(label).toLowerCase() || String(label).includes(model));
    return [label, dup ? '' : model, p.baseUrl || ''].filter(Boolean).join(' · ');
  };
  const MODE_LABEL = {
    tts: '文本转语音',
    design: '声音设计',
    clone: '声音克隆',
    hifi: '极致克隆',
    cosy: '千问合成',
    voice: '音色合成',
    reference: '参考复刻'
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /* ------------------------------ 小工具 ------------------------------ */

  function escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n <= 0) return '—';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  const pad2 = (n) => String(n).padStart(2, '0');

  function clock(ts) {
    const d = new Date(Number(ts) || Date.now());
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  function timeLabel(ts) {
    const d = new Date(Number(ts) || Date.now());
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return `今天 ${clock(ts)}`;
    const yesterday = new Date(now.getTime() - 86400000);
    if (d.toDateString() === yesterday.toDateString()) return `昨天 ${clock(ts)}`;
    return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${clock(ts)}`;
  }

  function textSnippet(text, max = 90) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    return clean.length > max ? `${clean.slice(0, max)}…` : clean;
  }

  function b64ToBlobUrl(base64, mime) {
    const binary = atob(String(base64 || ''));
    const chunks = [];
    const step = 8192;
    for (let i = 0; i < binary.length; i += step) {
      const slice = binary.slice(i, i + step);
      const bytes = new Uint8Array(slice.length);
      for (let j = 0; j < slice.length; j++) bytes[j] = slice.charCodeAt(j);
      chunks.push(bytes);
    }
    return URL.createObjectURL(new Blob(chunks, { type: mime || 'audio/wav' }));
  }

  function toast(message, tone = 'ok', ms) {
    const wrap = $('#toasts');
    if (!wrap) return;
    const el = document.createElement('div');
    el.className = `toast ${tone === 'error' ? 'error' : 'ok'}`;
    el.textContent = message;
    wrap.appendChild(el);
    const timeout = ms || (tone === 'error' ? 5600 : 2600);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 220);
    }, timeout);
  }

  function setRangeFill(input) {
    if (!input) return;
    const min = Number(input.min) || 0;
    const max = Number(input.max) || 100;
    const val = Number(input.value) || 0;
    const pct = max === min ? 0 : ((val - min) / (max - min)) * 100;
    input.style.setProperty('--p', `${Math.max(0, Math.min(100, pct))}%`);
  }

  function basename(name) {
    return String(name || '').split(/[\\/]/).pop();
  }

  function withoutExt(name) {
    return basename(name).replace(/\.[^.]+$/, '');
  }

  /* ------------------------------ 状态 ------------------------------ */

  const DEFAULT_PREFS = {
    presetId: 'p_wenrou',
    voiceKind: 'preset',
    voiceId: '',
    control: '',
    controlTouched: false,
    speed: 1,
    language: 'zh',
    formatId: 'wav-48000',
    hifi: false,
    promptText: ''
  };

  function loadPrefs() {
    try {
      const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
      return Object.assign({}, DEFAULT_PREFS, raw && typeof raw === 'object' ? raw : {});
    } catch (_) {
      return Object.assign({}, DEFAULT_PREFS);
    }
  }

  let prefs = loadPrefs();

  function savePrefs() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch (_) {}
  }

  const state = {
    view: 'compose',
    settings: { providers: [], activeProviderId: '', format: 'wav', sampleRate: 48000, dataDir: '' },
    voices: [],
    history: [],
    reference: null,
    busy: false,
    last: null,
    query: '',
    editingId: null
  };

  let popType = null;
  let popAnchor = null;
  let popState = {};

  let audioEl = null;
  let audioUrl = null;
  let playingEntry = null;

  /* ------------------------------ 派生数据 ------------------------------ */

  function activeProvider() {
    const list = state.settings.providers || [];
    return list.find((p) => p.id === state.settings.activeProviderId) || list[0] || null;
  }

  function providerType() {
    const p = activeProvider();
    return p ? p.type : 'voxcpm';
  }

  function presetById(id) {
    return PRESETS.find((p) => p.id === id) || PRESETS[0] || null;
  }

  function voiceById(id) {
    return state.voices.find((v) => v.id === id) || null;
  }

  function formatsForKind(kind) {
    const list = FORMATS.filter((f) => !f.kinds || f.kinds.includes(kind));
    return list.length ? list : FORMATS;
  }

  function currentFormat() {
    const kind = providerType();
    const list = formatsForKind(kind);
    return list.find((f) => f.id === prefs.formatId) || list[0] || FORMATS[0];
  }

  function ensureFormat() {
    const kind = providerType();
    const ok = formatsForKind(kind).some((f) => f.id === prefs.formatId);
    if (!ok) {
      const fallback = currentFormat();
      if (fallback) prefs.formatId = fallback.id;
    }
  }

  function controlText() {
    if (prefs.controlTouched) return String(prefs.control || '').trim();
    if (prefs.voiceKind === 'preset') {
      const preset = presetById(prefs.presetId);
      return preset ? preset.control : '';
    }
    return '';
  }

  function voiceDescriptor() {
    if (prefs.voiceKind === 'saved') {
      const voice = voiceById(prefs.voiceId);
      if (voice) {
        return {
          name: voice.name,
          sub: `${voice.model || TYPE_LABEL[voice.type] || ''} · 参考音频 ${voice.sourceName || '已保存'}`,
          avatar: '✦'
        };
      }
    }
    if (prefs.voiceKind === 'ref' && state.reference) {
      return {
        name: withoutExt(state.reference.name),
        sub: '待注册 · 生成时自动上传并注册为克隆音色',
        avatar: '↑'
      };
    }
    const preset = presetById(prefs.presetId);
    if (preset) {
      return { name: preset.name, sub: `预设音色 · ${preset.desc}`, avatar: preset.gender === 'male' ? '♂' : '♀' };
    }
    return { name: '未选择音色', sub: '点击「更换音色」挑一个', avatar: '◉' };
  }

  function sanitizeVoiceForProvider() {
    const provider = activeProvider();
    if (!provider) return;
    if (prefs.voiceKind === 'saved') {
      const voice = voiceById(prefs.voiceId);
      if (!voice || voice.providerId !== provider.id) {
        prefs.voiceKind = state.reference ? 'ref' : 'preset';
        prefs.voiceId = '';
      }
    }
    if (prefs.voiceKind === 'ref' && !state.reference) {
      prefs.voiceKind = 'preset';
      prefs.voiceId = '';
    }
    if (provider.type === 'dashscope' && prefs.voiceKind === 'preset' && !state.reference) {
      const usable = state.voices.some((v) => v.providerId === provider.id);
      if (usable) {
        const first = state.voices.find((v) => v.providerId === provider.id);
        prefs.voiceKind = 'saved';
        prefs.voiceId = first.id;
      }
    }
  }

  /* ------------------------------ 渲染 · 合成页 ------------------------------ */

  function renderHero() {
    const wrap = $('#heroBars');
    if (!wrap || wrap.childElementCount) return;
    const heights = [
      10, 16, 24, 34, 46, 58, 70, 60, 78, 92, 74, 62, 84, 96, 70, 54, 66, 82, 94, 72, 58, 46, 56, 68,
      80, 64, 50, 40, 30, 22, 16, 12
    ];
    const frag = document.createDocumentFragment();
    heights.forEach((h, i) => {
      const bar = document.createElement('span');
      bar.className = 'bar';
      bar.style.height = `${h}px`;
      bar.style.animationDelay = `${(i % 9) * 0.12}s`;
      frag.appendChild(bar);
    });
    wrap.appendChild(frag);
  }

  function renderVoiceBox() {
    const desc = voiceDescriptor();
    $('#voiceTitle').textContent = desc.name;
    $('#voiceSub').textContent = desc.sub;
    $('#voiceAvatar').textContent = desc.avatar;
    $('#voiceAvatar').classList.toggle('saved', prefs.voiceKind === 'saved');
    $('#voiceAvatar').classList.toggle('ref', prefs.voiceKind === 'ref');

    const hasRef = Boolean(state.reference);
    $('#refPanel').hidden = false;
    $('#refChip').hidden = !hasRef;
    $('#dropzone').hidden = hasRef;
    $('#refExtra').hidden = !hasRef || providerType() !== 'voxcpm';
    if (hasRef) {
      const ref = state.reference;
      $('#refName').textContent = ref.name;
      const extra = prefs.hifi && providerType() === 'voxcpm' ? ' · 极致克隆' : '';
      const dur = Number(ref.duration) || 0;
      $('#refMeta').textContent = dur > 0 ? `${fmtClock(dur)} · ${formatBytes(ref.size)}${extra}` : `${formatBytes(ref.size)}${extra}`;
      $('#chkHifi').checked = Boolean(prefs.hifi);
      if ($('#promptText').value !== prefs.promptText) $('#promptText').value = prefs.promptText || '';
    }
    const hint = providerType() === 'dashscope'
      ? '千问 CosyVoice 会用这段参考音频注册一个音色（约 10–60 秒），之后可反复使用。'
      : '参考音频只保存在本机，合成时随请求发给 vllm-omni；服务端要求 1–30 秒干净人声。';
    $('#refHint').textContent = hint;
  }

  function renderChips() {
    const provider = activeProvider();
    $('#providerLabel').textContent = provider ? provider.name : '未配置 API';
    $('#voiceLabel').textContent = voiceDescriptor().name;

    const control = controlText();
    $('#controlLabel').textContent = control ? (control.length > 10 ? `${control.slice(0, 10)}…` : control) : '声音描述';

    $('#speedLabel').textContent = `语速 ${Number(prefs.speed).toFixed(2)}x`;
    const lang = LANGS.find((l) => l.id === prefs.language) || LANGS[0];
    $('#langLabel').textContent = lang ? lang.label : '中文';
    $('#formatLabel').textContent = currentFormat().label;

    const isDash = providerType() === 'dashscope';
    $('#chipSpeed').hidden = !isDash;
    $('#chipLang').hidden = !isDash;
  }

  function renderStats() {
    const text = $('#text').value || '';
    const chars = text.length;
    const billed = text.replace(/[^\p{L}\p{N}]/gu, '').length;
    const speed = providerType() === 'dashscope' ? Number(prefs.speed) || 1 : 1;
    const seconds = Math.max(0, Math.round(billed / 5.2 / speed));
    $('#statChars').textContent = `总字符 ${chars} / ${MAX_TEXT.toLocaleString('en-US')}`;
    $('#statSec').textContent = `约 ${seconds} 秒`;
    if (providerType() === 'dashscope') {
      $('#costValue').textContent = `按 ${billed} 字符计费`;
      $('#costHint').textContent = '千问按字符计费';
    } else {
      $('#costValue').textContent = `预计 ${seconds} 秒音频`;
      $('#costHint').textContent = '本地部署 · 不计费';
    }
  }

  function renderAll() {
    renderHero();
    renderVoiceBox();
    renderChips();
    renderStats();
    renderRecent();
    renderHistory();
  }

  /** 统一取音色显示名，兼容旧版记录（只有 speakerName） */
  function voiceNameOf(entry) {
    let name = String(entry.voiceName || entry.speakerName || entry.providerName || '语音').trim();
    name = name.replace(/^克隆音色\s*/, '');
    if (/^cosyvoice-/i.test(name)) return '千问克隆音色';
    if (/^cosyvoice/i.test(entry.providerId || '') || entry.provider === 'cosyvoice') {
      if (!name || name === '语音') return '千问克隆音色';
    }
    return name || '语音';
  }

  function renderRecent() {
    const grid = $('#recentGrid');
    const empty = $('#recentEmpty');
    const items = state.history.slice(0, 6);
    grid.innerHTML = items
      .map((h) => {
        const bars = [8, 14, 10].map((hgt) => `<i style="height:${hgt}px"></i>`).join('');
        return `
          <article class="recent-item" data-entry="${escapeHtml(h.id)}">
            <div class="ri-head">
              <div class="ri-icon">${bars}</div>
              <span class="ri-name">${escapeHtml(voiceNameOf(h))}</span>
              <span class="ri-time">${timeLabel(h.createdAt)}</span>
            </div>
            <p class="ri-text">${escapeHtml(textSnippet(h.text, 70))}</p>
            <div class="ri-foot">
              <button class="ri-play" data-play="${escapeHtml(h.id)}" title="播放">▶</button>
              <span class="ri-tag done">${escapeHtml(MODE_LABEL[h.mode] || '已完成')}</span>
              <span class="ri-tag">${formatBytes(h.bytes)}</span>
            </div>
          </article>`;
      })
      .join('');
    empty.hidden = items.length > 0;
    $('#recentTotal').textContent = state.history.length;
    $('#btnAllHistory').hidden = state.history.length === 0;
  }

  function renderHistory() {
    const query = state.query.trim().toLowerCase();
    const items = state.history.filter((h) => {
      if (!query) return true;
      return [h.text, h.voiceName, h.providerName, h.model, MODE_LABEL[h.mode]].join(' ').toLowerCase().includes(query);
    });
    const totalBytes = state.history.reduce((sum, h) => sum + (Number(h.bytes) || 0), 0);
    $('#historyStats').textContent = `共 ${state.history.length} 条 · ${formatBytes(totalBytes)}${query ? ` · 匹配 ${items.length} 条` : ''}`;

    const list = $('#historyList');
    list.innerHTML = items
      .map((h) => {
        const meta = [
          voiceNameOf(h),
          MODE_LABEL[h.mode] || h.mode || '',
          `${String(h.format || '').toUpperCase()} · ${Math.round((Number(h.sampleRate) || 48000) / 1000)} kHz`,
          h.providerName || '',
          timeLabel(h.createdAt)
        ]
          .filter(Boolean)
          .map((t) => `<span>${escapeHtml(t)}</span>`)
          .join('');
        return `
          <div class="history-row" data-entry="${escapeHtml(h.id)}" data-play="${escapeHtml(h.id)}">
            <button class="hr-play" data-play="${escapeHtml(h.id)}" title="播放">
              <svg viewBox="0 0 24 24"><path d="M8 5.5l10 6.5-10 6.5z" /></svg>
            </button>
            <div class="hr-body">
              <p class="hr-text">${escapeHtml(textSnippet(h.text, 120))}</p>
              <div class="hr-meta">${meta}</div>
            </div>
            <span class="hr-size">${formatBytes(h.bytes)}</span>
            <div class="hr-actions">
              <button class="hr-action" data-download="${escapeHtml(h.id)}" title="下载">
                <svg viewBox="0 0 24 24"><path d="M12 4v11m0 0l-4-4m4 4l4-4M5 19h14" /></svg>
              </button>
              <button class="hr-action" data-reveal="${escapeHtml(h.id)}" title="定位文件">
                <svg viewBox="0 0 24 24"><path d="M4 7.5A1.5 1.5 0 0 1 5.5 6h3l1.6 2H18a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 18 18H5.5A1.5 1.5 0 0 1 4 16.5z" /></svg>
              </button>
              <button class="hr-action danger" data-delete="${escapeHtml(h.id)}" title="删除">
                <svg viewBox="0 0 24 24"><path d="M5 7h14M9 7V5h6v2M7 7l1 12h8l1-12" /></svg>
              </button>
            </div>
          </div>`;
      })
      .join('');
    $('#historyEmpty').hidden = items.length > 0;
  }

  /* ------------------------------ 渲染 · 设置页 ------------------------------ */

  function renderProviderList() {
    const list = $('#providerList');
    const providers = state.settings.providers || [];
    if (!providers.length) {
      list.innerHTML = '<p class="provider-empty">还没有 API，点右上角「+ 添加 API」开始。</p>';
      return;
    }
    list.innerHTML = providers
      .map((p) => {
        const active = p.id === state.settings.activeProviderId;
        return `
          <div class="provider-row${active ? ' active' : ''}">
            <div class="pv-main">
              <strong>${escapeHtml(p.name)}${active ? '<span class="pill">当前</span>' : ''}</strong>
              <span class="pv-meta">${escapeHtml(providerMetaText(p))}</span>
              <span class="pv-key">${p.keySet ? `Key 已配置（${escapeHtml(p.keyHint || '')}）` : '未配置 Key'}</span>
            </div>
            <div class="pv-actions">
              ${active ? '' : `<button class="ghost small" data-provider-use="${escapeHtml(p.id)}">设为当前</button>`}
              <button class="ghost small" data-provider-edit="${escapeHtml(p.id)}">编辑</button>
            </div>
          </div>`;
      })
      .join('');
  }

  function renderFormatSelect() {
    const select = $('#defaultFormat');
    const kind = providerType();
    const list = formatsForKind(kind);
    select.innerHTML = list
      .map((f) => `<option value="${escapeHtml(f.id)}">${escapeHtml(f.label)}</option>`)
      .join('');
    const current = currentFormat();
    if (current) select.value = current.id;
  }

  function editProvider(id) {
    const provider = id ? (state.settings.providers || []).find((p) => p.id === id) : null;
    state.editingId = id || null;
    const editor = $('#providerEditor');
    editor.hidden = false;
    $('#peTitle').textContent = provider ? '编辑 API' : '添加 API';
    $('#peName').value = provider ? provider.name : '';
    $('#peType').value = provider ? provider.type : 'voxcpm';
    $('#peBaseUrl').value = provider ? provider.baseUrl : 'http://127.0.0.1:8000';
    $('#peModel').value = provider ? provider.model : 'VoxCPM2';
    const keyInput = $('#peApiKey');
    keyInput.value = '';
    keyInput.type = 'password';
    $('#btnTogglePeKey').textContent = '显示';
    keyInput.placeholder = provider && provider.keySet ? '已保存，输入新的 Key 可替换' : '粘贴 Key';
    $('#peKeyHint').textContent = provider && provider.keySet
      ? `已配置（${provider.keyHint}），留空则保持不变。`
      : 'VoxCPM2 Key 形如 vx-…；千问 Key 形如 sk-…。';
    $('#btnDeleteProvider').hidden = !provider;
    $('#providerTestResult').hidden = true;
    setTimeout(() => $('#peName').focus(), 30);
  }

  function closeProviderEditor() {
    state.editingId = null;
    $('#providerEditor').hidden = true;
    $('#providerTestResult').hidden = true;
  }

  async function refreshSettings() {
    state.settings = await window.dsh.settings.get();
    renderProviderList();
    renderFormatSelect();
    $('#dataDir').textContent = state.settings.dataDir || '—';
    ensureFormat();
  }

  /* ------------------------------ 弹层 ------------------------------ */

  function popHmtlHead(title, extra) {
    return `<div class="pop-head"><strong>${escapeHtml(title)}</strong>${extra || ''}</div>`;
  }

  function openPopover(anchor, type, html, opts) {
    popType = type;
    popAnchor = anchor;
    popState = opts || {};
    const layer = $('#popoverLayer');
    const pop = $('#popover');
    pop.className = `popover pop-${type}`;
    pop.innerHTML = html;
    layer.hidden = false;
    requestAnimationFrame(() => {
      positionPopover(anchor);
      layer.classList.add('show');
    });
    requestAnimationFrame(() => {
      if (document.activeElement) document.activeElement.blur();
      const input = $('.pop-search input', pop);
      if (input) input.focus();
    });
  }

  function closePopover() {
    popType = null;
    popAnchor = null;
    popState = {};
    const layer = $('#popoverLayer');
    layer.classList.remove('show');
    layer.hidden = true;
    $('#popover').innerHTML = '';
  }

  function isPopoverOpen() {
    return !$('#popoverLayer').hidden;
  }

  function positionPopover(anchor) {
    const pop = $('#popover');
    const layer = $('#popoverLayer');
    if (!pop || !anchor || !layer) return;
    pop.style.maxHeight = '';
    const body = $('.pop-body', pop);
    if (body) body.style.maxHeight = '';
    pop.style.left = '0px';
    pop.style.top = '0px';

    const a = anchor.getBoundingClientRect();
    const pad = 12;
    const w = pop.offsetWidth || pop.getBoundingClientRect().width;
    let left = a.left;
    if (left + w > window.innerWidth - pad) left = Math.max(pad, window.innerWidth - pad - w);
    pop.style.left = `${Math.round(left)}px`;

    const spaceBelow = window.innerHeight - a.bottom - 8 - pad;
    const spaceAbove = a.top - 8 - pad;
    const natural = pop.offsetHeight;
    // 下方能放下 260px 就优先向下；否则若上方更宽裕则向上展开
    const openUp = spaceBelow < 260 && spaceAbove > spaceBelow;
    const limit = Math.max(180, Math.floor(Math.min(openUp ? spaceAbove : spaceBelow, 540)));

    pop.style.maxHeight = `${limit}px`;
    const head = $('.pop-head', pop);
    const foot = $('.pop-foot', pop);
    const rest = (head ? head.offsetHeight : 0) + (foot ? foot.offsetHeight : 0) + 10;
    if (body) body.style.maxHeight = `${Math.max(90, Math.round(limit - rest))}px`;

    const h = Math.min(natural, limit);
    const top = openUp ? Math.max(pad, Math.round(a.top - 8 - h)) : Math.round(a.bottom + 8);
    pop.style.top = `${top}px`;
  }

  /* ------------------------------ 弹层 · API 切换 ------------------------------ */

  function openProviderPicker(anchor) {
    const providers = state.settings.providers || [];
    const rows = providers
      .map(
        (p) => `
        <button class="option-row${p.id === state.settings.activeProviderId ? ' active' : ''}" data-use-provider="${escapeHtml(p.id)}">
          <span class="dot"></span>
          <span class="opt-body">
            <strong>${escapeHtml(p.name)}</strong>
            <small>${escapeHtml(providerMetaText(p))}${p.keySet ? '' : ' · 未配置 Key'}</small>
          </span>
        </button>`
      )
      .join('');
    const html = `
      ${popHmtlHead('选择 API', '<span class="pop-sub">调用时可随时切换</span>')}
      <div class="pop-body">${
        rows || '<p class="pop-empty">还没有配置 API，先去设置里添加一个。</p>'
      }</div>
      <div class="pop-foot"><button class="ghost small" data-open-settings>管理 API →</button></div>`;
    openPopover(anchor, 'provider', html);
  }

  /* ------------------------------ 弹层 · 音色 ------------------------------ */

  function presetRowsHtml() {
    const isDash = providerType() === 'dashscope';
    const list = PRESETS.filter((p) => !popState.query || `${p.name}${p.desc}${(p.tags || []).join('')}`.toLowerCase().includes(popState.query));
    if (!list.length) return '<p class="pop-empty">没有匹配的预设音色。</p>';
    return list
      .map((p) => {
        const active = prefs.voiceKind === 'preset' && prefs.presetId === p.id;
        return `
          <button class="voice-item${active ? ' active' : ''}${isDash ? ' disabled' : ''}" data-preset="${escapeHtml(p.id)}" ${isDash ? 'data-disabled="1"' : ''}>
            <span class="vi-avatar ${p.gender === 'male' ? 'male' : ''}">${escapeHtml(p.name.slice(0, 1))}</span>
            <span class="vi-body">
              <span class="vi-name">${escapeHtml(p.name)}${p.featured ? '<span class="vi-tag">推荐</span>' : ''}</span>
              <span class="vi-desc">${escapeHtml(p.desc)}</span>
            </span>
            <span class="vi-check"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg></span>
          </button>`;
      })
      .join('');
  }

  function savedVoiceRowsHtml() {
    const provider = activeProvider();
    const list = state.voices.filter((v) => !provider || v.providerId === provider.id);
    if (!list.length) {
      return '<p class="pop-empty">还没有保存的音色。上传一段参考音频，生成一次后就会出现在这里。</p>';
    }
    return list
      .map((v) => {
        const active = prefs.voiceKind === 'saved' && prefs.voiceId === v.id;
        return `
          <div class="voice-item${active ? ' active' : ''}" data-voice="${escapeHtml(v.id)}" role="button" tabindex="0">
            <span class="vi-avatar">✦</span>
            <span class="vi-body">
              <span class="vi-name">${escapeHtml(v.name)}</span>
              <span class="vi-desc">${escapeHtml(v.model || TYPE_LABEL[v.type] || '')} · ${timeLabel(v.createdAt)}${v.duration ? ` · ${Number(v.duration).toFixed(1)}s` : ''}</span>
            </span>
            <button class="vi-del" data-voice-del="${escapeHtml(v.id)}" title="删除音色">✕</button>
            <span class="vi-check"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg></span>
          </div>`;
      })
      .join('');
  }

  function voicePopoverBody() {
    const isDash = providerType() === 'dashscope';
    const note = isDash
      ? '<p class="pop-note">千问渠道需要「已保存的音色」：先上传参考音频生成一次，或从下方我的音色中选一个。</p>'
      : '<p class="pop-note">预设音色用「声音描述」驱动，不需要参考音频；想要更像某个人的声音，就上传参考音频。</p>';
    return `
      ${popHmtlHead('选择音色', '<label class="pop-search"><input id="popVoiceSearch" placeholder="搜索音色" value="' + escapeHtml(popState.query || '') + '" spellcheck="false" /></label>')}
      <div class="pop-body">
        ${note}
        <div class="pop-group">预设音色</div>
        ${presetRowsHtml()}
        <div class="pop-group">我的音色</div>
        ${savedVoiceRowsHtml()}
      </div>
      <div class="pop-foot">
        <button class="ghost small" data-upload-ref>＋ 上传参考音频</button>
        <button class="ghost small" data-close-pop>关闭</button>
      </div>`;
  }

  function openVoicePicker(anchor) {
    popState = { query: '' };
    openPopover(anchor, 'voice', voicePopoverBody());
  }

  function repaintVoicePopover() {
    if (popType !== 'voice') return;
    $('#popover').innerHTML = voicePopoverBody();
    positionPopover(popAnchor);
    const input = $('#popVoiceSearch');
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }

  /* ------------------------------ 弹层 · 声音描述 ------------------------------ */

  function openControl(anchor) {
    const isDash = providerType() === 'dashscope';
    const value = controlText();
    const examples = CONTROL_EXAMPLES.map(
      (ex) => `<button class="preset" data-example="${escapeHtml(ex)}" title="${escapeHtml(ex)}">${escapeHtml(textSnippet(ex, 12))}</button>`
    ).join('');
    const note = isDash
      ? '千问会把这段描述当作 instruction 传给模型，可以写情绪、方言或角色。'
      : prefs.voiceKind === 'preset'
        ? 'VoxCPM2 会按这段描述「设计」音色与语气：写性别、年龄、音色质感、语速、情绪和场景，越具体越稳定。'
        : '当前已选参考音频或克隆音色，音色由它决定；这段描述只在「预设音色」模式下用来设计声音。';
    const html = `
      ${popHmtlHead('声音描述', '<span class="pop-sub">越具体越稳定</span>')}
      <div class="pop-body">
        <textarea id="controlText" class="instr-box" maxlength="300" spellcheck="false" placeholder="例如：年轻女性，声音清冷、略带沙哑，语速偏慢，像在讲一个古老的故事">${escapeHtml(value)}</textarea>
        <div class="pop-note">${note}</div>
        <div class="pop-group">快速示例</div>
        <div class="preset-row">${examples}</div>
      </div>
      <div class="pop-foot">
        <button class="ghost small" data-control-reset>用当前音色的描述</button>
        <button class="primary small" data-close-pop>完成</button>
      </div>`;
    openPopover(anchor, 'control', html);
    setTimeout(() => {
      const ta = $('#controlText');
      if (ta) {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }
    }, 40);
  }

  /* ------------------------------ 弹层 · 语速 / 语言 / 格式 ------------------------------ */

  function openSpeed(anchor) {
    const presets = [0.75, 0.9, 1, 1.1, 1.25, 1.5];
    const html = `
      <div class="speed-panel">
        <div class="panel-title"><span>语速</span><strong>${Number(prefs.speed).toFixed(2)}x</strong></div>
        <input type="range" class="range" id="speedRange" min="0.5" max="2" step="0.05" value="${Number(prefs.speed)}" />
        <div class="intensity-labels"><span>0.5x 慢</span><span>2.0x 快</span></div>
        <div class="preset-row">
          ${presets
            .map(
              (v) => `<button class="preset${Math.abs(v - prefs.speed) < 0.001 ? ' active' : ''}" data-speed="${v}">${v.toFixed(2)}x</button>`
            )
            .join('')}
        </div>
        <p class="pop-note">仅千问 CosyVoice 支持语速；VoxCPM2 通过声音描述控制节奏。</p>
      </div>`;
    openPopover(anchor, 'speed', html);
    const range = $('#speedRange');
    if (range) {
      setRangeFill(range);
      range.addEventListener('input', () => {
        const v = Number(range.value);
        prefs.speed = v;
        savePrefs();
        setRangeFill(range);
        const title = $('.panel-title strong', $('#popover'));
        if (title) title.textContent = `${v.toFixed(2)}x`;
        $$('.preset', $('#popover')).forEach((b) => b.classList.toggle('active', Math.abs(Number(b.dataset.speed) - v) < 0.001));
        renderChips();
        renderStats();
      });
    }
  }

  function openLanguage(anchor) {
    const html = `
      ${popHmtlHead('参考音频语种', '<span class="pop-sub">千问注册音色时使用</span>')}
      <div class="pop-body">
        ${LANGS.map(
          (l) => `<button class="option-row${l.id === prefs.language ? ' active' : ''}" data-lang="${escapeHtml(l.id)}">
            <span class="dot"></span><span class="opt-body"><strong>${escapeHtml(l.label)}</strong><small>${escapeHtml(l.id)}</small></span>
          </button>`
        ).join('')}
      </div>
      <div class="pop-foot"><button class="ghost small" data-close-pop>关闭</button></div>`;
    openPopover(anchor, 'language', html);
  }

  function openFormat(anchor) {
    const kind = providerType();
    const list = formatsForKind(kind);
    const html = `
      ${popHmtlHead('音频格式')}
      <div class="pop-body">
        ${list
          .map(
            (f) => `<button class="option-row${f.id === currentFormat().id ? ' active' : ''}" data-format="${escapeHtml(f.id)}">
              <span class="dot"></span>
              <span class="opt-body"><strong>${escapeHtml(f.label)}</strong><small>${escapeHtml(f.format.toUpperCase())} · ${f.sampleRate / 1000} kHz</small></span>
            </button>`
          )
          .join('')}
      </div>
      <div class="pop-foot"><button class="ghost small" data-close-pop>关闭</button></div>`;
    openPopover(anchor, 'format', html);
  }

  /* ------------------------------ 弹层 · 事件 ------------------------------ */

  function selectPreset(id) {
    prefs.voiceKind = 'preset';
    prefs.presetId = id;
    prefs.voiceId = '';
    if (!prefs.controlTouched) prefs.control = '';
    savePrefs();
    renderVoiceBox();
    renderChips();
    closePopover();
    toast(`已选择音色：${(presetById(id) || {}).name || ''}`, 'ok', 1600);
  }

  function selectVoice(id) {
    const voice = voiceById(id);
    if (!voice) return;
    prefs.voiceKind = 'saved';
    prefs.voiceId = id;
    savePrefs();
    renderVoiceBox();
    renderChips();
    closePopover();
    toast(`已选择音色：${voice.name}`, 'ok', 1600);
  }

  async function deleteVoice(id) {
    const voice = voiceById(id);
    if (!voice) return;
    if (!window.confirm(`删除音色「${voice.name}」？会同时尝试删除服务端音色。`)) return;
    const res = await window.dsh.voices.remove(id);
    if (!res.ok) {
      toast(res.error || '删除失败', 'error');
      return;
    }
    state.voices = (await window.dsh.voices.list()).voices;
    if (prefs.voiceKind === 'saved' && prefs.voiceId === id) {
      prefs.voiceKind = 'preset';
      prefs.voiceId = '';
      savePrefs();
    }
    renderVoiceBox();
    renderChips();
    repaintVoicePopover();
    toast(res.remoteError ? `本地已删除，服务端删除失败：${res.remoteError}` : '音色已删除', res.remoteError ? 'error' : 'ok');
  }

  async function useProvider(id) {
    if (id === state.settings.activeProviderId) {
      closePopover();
      return;
    }
    const res = await window.dsh.providers.activate(id);
    if (!res || !res.ok) {
      toast('切换失败', 'error');
      return;
    }
    state.settings = res.settings;
    ensureFormat();
    sanitizeVoiceForProvider();
    savePrefs();
    closePopover();
    renderVoiceBox();
    renderChips();
    renderStats();
    renderFormatSelect();
    renderProviderList();
    const p = activeProvider();
    toast(`已切换到：${p ? p.name : ''}`, 'ok', 1800);
  }

  function onPopoverClick(event) {
    const target = event.target.closest('button, [data-voice], [data-voice-del], [data-preset]');
    if (!target) return;

    if (target.dataset.closePop !== undefined) {
      closePopover();
      return;
    }
    if (target.dataset.uploadRef !== undefined) {
      closePopover();
      pickReference();
      return;
    }
    if (target.dataset.openSettings !== undefined) {
      closePopover();
      switchView('settings');
      return;
    }
    if (target.dataset.preset) {
      if (target.dataset.disabled) {
        toast('千问渠道需要用「已保存的音色」，请先上传参考音频。', 'error');
        return;
      }
      selectPreset(target.dataset.preset);
      return;
    }
    if (target.dataset.voiceDel) {
      event.stopPropagation();
      deleteVoice(target.dataset.voiceDel);
      return;
    }
    if (target.dataset.voice) {
      selectVoice(target.dataset.voice);
      return;
    }
    if (target.dataset.useProvider) {
      useProvider(target.dataset.useProvider);
      return;
    }
    if (target.dataset.speed) {
      prefs.speed = Number(target.dataset.speed);
      savePrefs();
      renderChips();
      renderStats();
      const range = $('#speedRange');
      if (range) {
        range.value = String(prefs.speed);
        setRangeFill(range);
      }
      const title = $('.panel-title strong', $('#popover'));
      if (title) title.textContent = `${prefs.speed.toFixed(2)}x`;
      $$('.preset', $('#popover')).forEach((b) => b.classList.toggle('active', Math.abs(Number(b.dataset.speed) - prefs.speed) < 0.001));
      return;
    }
    if (target.dataset.lang) {
      prefs.language = target.dataset.lang;
      savePrefs();
      renderChips();
      closePopover();
      return;
    }
    if (target.dataset.format) {
      prefs.formatId = target.dataset.format;
      savePrefs();
      renderChips();
      closePopover();
      return;
    }
    if (target.dataset.example) {
      const ta = $('#controlText');
      if (ta) {
        ta.value = target.dataset.example;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.focus();
      }
      return;
    }
    if (target.dataset.controlReset !== undefined) {
      prefs.controlTouched = false;
      prefs.control = '';
      savePrefs();
      const ta = $('#controlText');
      const preset = presetById(prefs.presetId);
      if (ta) ta.value = preset ? preset.control : '';
      renderChips();
      return;
    }
  }

  function onPopoverInput(event) {
    const target = event.target;
    if (target.id === 'controlText') {
      prefs.control = target.value.slice(0, 300);
      prefs.controlTouched = true;
      savePrefs();
      renderChips();
      return;
    }
    if (target.id === 'popVoiceSearch') {
      popState.query = target.value.trim().toLowerCase();
      const body = $('.pop-body', $('#popover'));
      if (body) {
        const scroll = body.scrollTop;
        repaintVoicePopover();
        const nextBody = $('.pop-body', $('#popover'));
        if (nextBody) nextBody.scrollTop = scroll;
      }
    }
  }

  /* ------------------------------ 参考音频 ------------------------------ */

  function applyReference(file) {
    if (!file || !file.ok) {
      if (file && file.error) toast(file.error, 'error');
      return;
    }
    state.reference = {
      name: file.name,
      size: Number(file.size) || 0,
      mime: file.mime || 'audio/wav',
      base64: file.base64,
      ext: file.ext || 'wav',
      duration: Number(file.duration) || 0,
      previewUrl: null
    };
    prefs.voiceKind = 'ref';
    prefs.voiceId = '';
    prefs.hifi = false;
    prefs.promptText = '';
    prefs.controlTouched = false;
    savePrefs();
    renderVoiceBox();
    renderChips();
    $('#refPanel').hidden = false;
    if (!state.reference.duration) probeReferenceDuration();
    toast('参考音频已就绪，写点文字就能生成', 'ok', 2400);
  }

  /** 读取参考音频时长，让芯片上能显示 0:06 这样的信息 */
  function probeReferenceDuration() {
    const ref = state.reference;
    if (!ref || !ref.base64 || ref.duration) return;
    try {
      const url = b64ToBlobUrl(ref.base64, ref.mime);
      const probe = new Audio();
      probe.preload = 'metadata';
      probe.src = url;
      probe.addEventListener('loadedmetadata', () => {
        const d = Number(probe.duration);
        if (Number.isFinite(d) && d > 0 && state.reference && state.reference.name === ref.name) {
          state.reference.duration = d;
          renderVoiceBox();
        }
        URL.revokeObjectURL(url);
      });
      probe.addEventListener('error', () => URL.revokeObjectURL(url));
    } catch (_) {}
  }

  async function pickReference() {
    try {
      const file = await window.dsh.audio.pick();
      if (!file || file.canceled) return;
      applyReference(file);
    } catch (err) {
      toast(`选择音频失败：${err.message}`, 'error');
    }
  }

  function clearReference() {
    state.reference = null;
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
      audioUrl = null;
    }
    if (prefs.voiceKind === 'ref') {
      prefs.voiceKind = 'preset';
      prefs.voiceId = '';
    }
    prefs.hifi = false;
    prefs.promptText = '';
    savePrefs();
    renderVoiceBox();
    renderChips();
    toast('已移除参考音频', 'ok', 1600);
  }

  function previewReference() {
    if (!state.reference) return;
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
      audioUrl = null;
    }
    audioUrl = b64ToBlobUrl(state.reference.base64, state.reference.mime);
    ensureAudio();
    audioEl.src = audioUrl;
    audioEl.play().catch(() => {});
  }

  function handleDroppedFile(file) {
    if (!file) return;
    const okExt = ['wav', 'mp3', 'm4a', 'flac', 'ogg', 'opus', 'aac', 'pcm'];
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (!okExt.includes(ext)) {
      toast('不支持的音频格式，请选择 wav / mp3 / m4a / flac / ogg。', 'error');
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      toast(`参考音频不能超过 25 MB，当前 ${formatBytes(file.size)}。`, 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      applyReference({
        ok: true,
        name: file.name,
        size: file.size,
        ext,
        mime: file.type || 'audio/wav',
        base64
      });
    };
    reader.readAsDataURL(file);
  }

  /* ------------------------------ 生成 ------------------------------ */

  function setBusy(busy) {
    state.busy = busy;
    $('#progressRow').hidden = !busy;
    $('#btnGenerate').disabled = busy;
    $('#btnGenerate').classList.toggle('busy', busy);
    $('#btnGenerateLabel').textContent = busy ? '生成中…' : '生成语音';
    if (!busy) $('#progressText').textContent = '';
  }

  function progress(text) {
    const el = $('#progressText');
    if (el) el.textContent = text;
  }

  async function generate() {
    if (state.busy) return;
    const text = $('#text').value.trim();
    if (!text) {
      toast('先写点要合成的文字吧', 'error');
      $('#text').focus();
      return;
    }
    const provider = activeProvider();
    if (!provider) {
      toast('还没有配置 API，请先到「设置 → API 接入」添加一个。', 'error');
      switchView('settings');
      editProvider(null);
      return;
    }
    if (!provider.keySet) {
      toast(`「${provider.name}」还没有填写 API Key。`, 'error');
      switchView('settings');
      editProvider(provider.id);
      return;
    }
    if (provider.type === 'dashscope' && prefs.voiceKind !== 'saved' && prefs.voiceKind !== 'ref') {
      toast('千问渠道需要先上传参考音频注册音色，或用「我的音色」里已有的音色。', 'error', 4200);
      openVoicePicker($('#chipVoice'));
      return;
    }
    if (prefs.hifi && !prefs.promptText.trim()) {
      toast('极致克隆需要填写参考音频里说的原话（逐字文本）。', 'error', 4200);
      if ($('#promptText').hidden === false) $('#promptText').focus();
      return;
    }

    const format = currentFormat();
    setBusy(true);
    try {
      let voiceId = prefs.voiceKind === 'saved' ? prefs.voiceId : '';
      if (prefs.voiceKind === 'ref' && state.reference) {
        progress('正在保存参考音频到本地音色库…');
        const up = await window.dsh.voices.upload({
          providerId: provider.id,
          audioBase64: state.reference.base64,
          name: state.reference.name,
          mime: state.reference.mime,
          duration: 0,
          voiceName: withoutExt(state.reference.name).slice(0, 40),
          prefix: 'myvoice',
          language: prefs.language
        });
        if (!up || !up.ok) {
          const err = new Error((up && up.error) || '音色注册失败');
          err.code = up && up.code;
          throw err;
        }
        state.voices = (await window.dsh.voices.list()).voices;
        voiceId = up.voice.id;
        prefs.voiceKind = 'saved';
        prefs.voiceId = voiceId;
        savePrefs();
        renderVoiceBox();
        renderChips();
        progress('音色已就绪，正在合成…');
      }

      const payload = {
        providerId: provider.id,
        text,
        format: format.format,
        sampleRate: format.sampleRate,
        speed: prefs.speed,
        language: prefs.language,
        voiceId,
        control: controlText(),
        promptText: prefs.promptText,
        mode: prefs.hifi ? 'hifi' : ''
      };
      const res = await window.dsh.tts.generate(payload);
      if (!res || !res.ok) {
        const err = new Error((res && res.error) || '生成失败');
        err.code = res && res.code;
        throw err;
      }

      state.last = { entry: res.entry, base64: res.audio, mime: res.mime, elapsed: res.elapsed };
      showResult(res.entry, res.elapsed, res.usage);
      state.history = (await window.dsh.history.list()).items;
      renderRecent();
      renderHistory();
      toast('语音生成完成，可以试听或下载', 'ok', 2600);
      playEntry(res.entry, res.audio, res.mime);
    } catch (err) {
      if (err && (err.code === 'ABORTED' || err.name === 'AbortError')) {
        toast('已取消生成', 'ok', 1600);
      } else if (err && err.code === 'NO_KEY') {
        toast(err.message, 'error');
        switchView('settings');
      } else {
        toast(err.message || '生成失败', 'error', 6000);
      }
    } finally {
      setBusy(false);
      renderStats();
    }
  }

  function showResult(entry, elapsed, usage) {
    const card = $('#resultCard');
    card.hidden = false;
    const titleMap = {
      tts: '生成完成',
      design: '声音设计完成',
      clone: '克隆音色合成完成',
      hifi: '极致克隆完成',
      cosy: '千问合成完成'
    };
    $('#resultTitle').textContent = titleMap[entry.mode] || '生成完成';
    const bits = [
      entry.voiceName || '语音',
      `${String(entry.format || '').toUpperCase()} · ${Math.round((Number(entry.sampleRate) || 48000) / 1000)} kHz`,
      formatBytes(entry.bytes),
      `耗时 ${((Number(elapsed) || 0) / 1000).toFixed(1)} 秒`
    ];
    if (entry.duration) bits.push(`${Number(entry.duration).toFixed(1)} 秒音频`);
    if (usage && usage.characters) bits.push(`${usage.characters} 字符`);
    $('#resultMeta').textContent = bits.join(' · ');
  }

  async function cancelGeneration() {
    if (!state.busy) return;
    $('#btnCancel').disabled = true;
    progress('正在取消…');
    await window.dsh.tts.cancel();
    setTimeout(() => {
      $('#btnCancel').disabled = false;
    }, 1200);
  }

  /* ------------------------------ 播放器 ------------------------------ */

  function ensureAudio() {
    if (audioEl) return audioEl;
    audioEl = new Audio();
    audioEl.addEventListener('timeupdate', () => {
      const dur = Number(audioEl.duration) || 0;
      const cur = Number(audioEl.currentTime) || 0;
      $('#playerCur').textContent = fmtClock(cur);
      if (dur) {
        $('#playerDur').textContent = fmtClock(dur);
        const seek = $('#playerSeek');
        seek.value = String(Math.round((cur / dur) * 1000));
        setRangeFill(seek);
      }
    });
    audioEl.addEventListener('play', () => $('#playerToggle').classList.add('playing'));
    audioEl.addEventListener('pause', () => $('#playerToggle').classList.remove('playing'));
    audioEl.addEventListener('ended', () => {
      $('#playerToggle').classList.remove('playing');
      $$('.history-row.playing').forEach((el) => el.classList.remove('playing'));
    });
    audioEl.addEventListener('loadedmetadata', () => {
      $('#playerDur').textContent = fmtClock(Number(audioEl.duration) || 0);
    });
    audioEl.addEventListener('error', () => toast('音频无法播放，文件可能已被删除。', 'error'));
    return audioEl;
  }

  function fmtClock(sec) {
    const total = Math.max(0, Math.floor(Number(sec) || 0));
    return `${Math.floor(total / 60)}:${pad2(total % 60)}`;
  }

  function resetAudioUrl() {
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
      audioUrl = null;
    }
  }

  async function playEntry(entry, base64, mime) {
    if (!entry) return;
    try {
      let data = base64;
      let type = mime;
      if (!data) {
        const res = await window.dsh.history.audio(entry.id);
        if (!res || !res.ok) {
          toast((res && res.error) || '读取音频失败', 'error');
          return;
        }
        data = res.base64;
        type = res.mime;
      }
      resetAudioUrl();
      audioUrl = b64ToBlobUrl(data, type);
      ensureAudio();
      audioEl.src = audioUrl;
      await audioEl.play().catch(() => {});
      playingEntry = entry;
      $('#playerBar').hidden = false;
      $('#playerTitle').textContent = textSnippet(entry.text, 26) || '语音';
      $('#playerSub').textContent = `${entry.voiceName || ''} · ${MODE_LABEL[entry.mode] || ''} · ${timeLabel(entry.createdAt)}`;
      $('#playerCur').textContent = '0:00';
      $('#playerDur').textContent = '0:00';
      $('#playerSeek').value = '0';
      setRangeFill($('#playerSeek'));
      $$('.history-row').forEach((row) => row.classList.toggle('playing', row.dataset.entry === entry.id));
    } catch (err) {
      toast(`播放失败：${err.message}`, 'error');
    }
  }

  function togglePlayer() {
    if (!audioEl || !audioEl.src) return;
    if (audioEl.paused) audioEl.play().catch(() => {});
    else audioEl.pause();
  }

  function closePlayer() {
    if (audioEl) {
      audioEl.pause();
      audioEl.removeAttribute('src');
      audioEl.load();
    }
    resetAudioUrl();
    playingEntry = null;
    $('#playerBar').hidden = true;
    $$('.history-row.playing').forEach((el) => el.classList.remove('playing'));
  }

  function suggestName(entry) {
    const who = String(entry.voiceName || '语音').replace(/[\\/:*?"<>|]/g, '').slice(0, 20);
    const stamp = new Date(Number(entry.createdAt) || Date.now());
    return `${who}-${stamp.getFullYear()}${pad2(stamp.getMonth() + 1)}${pad2(stamp.getDate())}-${pad2(stamp.getHours())}${pad2(stamp.getMinutes())}.${entry.format || 'wav'}`;
  }

  async function saveEntry(id) {
    const entry = state.history.find((h) => h.id === id);
    if (!entry) return;
    const res = await window.dsh.file.saveAs({ id, suggestedName: suggestName(entry) });
    if (res && res.ok) toast('已保存到 ' + res.path, 'ok', 3200);
    else if (res && res.error) toast(res.error, 'error');
  }

  async function revealEntry(id) {
    await window.dsh.history.reveal(id);
  }

  async function deleteEntry(id) {
    const entry = state.history.find((h) => h.id === id);
    if (!entry) return;
    if (!window.confirm('删除这条记录及其音频文件？')) return;
    await window.dsh.history.remove(id);
    state.history = state.history.filter((h) => h.id !== id);
    if (state.last && state.last.entry && state.last.entry.id === id) {
      state.last = null;
      $('#resultCard').hidden = true;
    }
    if (playingEntry && playingEntry.id === id) closePlayer();
    renderRecent();
    renderHistory();
    toast('记录已删除', 'ok', 1600);
  }

  /* ------------------------------ 视图 / 窗口 ------------------------------ */

  function switchView(view) {
    state.view = view;
    $$('#viewTabs .tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.view === view));
    ['compose', 'history', 'settings'].forEach((name) => {
      const el = $(`#view-${name}`);
      if (el) el.hidden = name !== view;
    });
    $('#main').scrollTop = 0;
    if (view === 'settings') {
      refreshSettings().catch(() => {});
    }
    closePopover();
  }

  function bindWindowChrome() {
    $('#btnMin').addEventListener('click', () => window.dsh.win.minimize());
    $('#btnMax').addEventListener('click', () => window.dsh.win.toggleMaximize());
    $('#btnClose').addEventListener('click', () => window.dsh.win.close());
    $('#titlebar').addEventListener('dblclick', (event) => {
      if (event.target.closest('button, .tab, .tabs, input, a')) return;
      window.dsh.win.toggleMaximize();
    });
    if (window.dsh.win.onState) {
      window.dsh.win.onState((data) => {
        document.body.classList.toggle('maximized', Boolean(data && data.maximized));
      });
    }
    $$('#viewTabs .tab').forEach((tab) => {
      tab.addEventListener('click', () => switchView(tab.dataset.view));
    });
  }

  /* ------------------------------ 设置页交互 ------------------------------ */

  function providerDraft(extraKey) {
    const id = state.editingId;
    const draft = {
      name: $('#peName').value.trim(),
      type: $('#peType').value,
      baseUrl: $('#peBaseUrl').value.trim(),
      model: $('#peModel').value.trim()
    };
    if (id) draft.id = id;
    if (extraKey) draft.apiKey = $('#peApiKey').value.trim();
    return draft;
  }

  async function saveProviderForm() {
    const draft = providerDraft(!!$('#peApiKey').value.trim());
    if (!draft.name) {
      toast('给这个 API 起个名字吧', 'error');
      $('#peName').focus();
      return;
    }
    if (!draft.baseUrl) {
      toast('接口地址不能为空', 'error');
      $('#peBaseUrl').focus();
      return;
    }
    const res = await window.dsh.providers.save(draft);
    if (!res || !res.ok) {
      toast((res && res.error) || '保存失败', 'error');
      return;
    }
    state.settings = res.settings;
    ensureFormat();
    sanitizeVoiceForProvider();
    savePrefs();
    renderProviderList();
    renderFormatSelect();
    renderChips();
    renderVoiceBox();
    closeProviderEditor();
    toast('API 已保存', 'ok', 2000);
  }

  async function testProviderForm() {
    const result = $('#providerTestResult');
    result.hidden = false;
    result.classList.remove('error');
    result.textContent = '正在连接…';
    const payload = providerDraft(true);
    const res = await window.dsh.providers.test(payload);
    if (res && res.ok) {
      result.textContent = res.detail || '连接成功';
      toast('连接成功', 'ok', 2400);
    } else {
      result.classList.add('error');
      result.textContent = (res && res.error) || '连接失败';
      toast((res && res.error) || '连接失败', 'error', 5200);
    }
  }

  async function deleteProviderForm() {
    const id = state.editingId;
    if (!id) return;
    const provider = (state.settings.providers || []).find((p) => p.id === id);
    if (!window.confirm(`删除 API「${provider ? provider.name : id}」？使用它的音色会保留在本地。`)) return;
    const res = await window.dsh.providers.remove(id);
    if (!res || !res.ok) {
      toast('删除失败', 'error');
      return;
    }
    state.settings = res.settings;
    ensureFormat();
    sanitizeVoiceForProvider();
    savePrefs();
    renderProviderList();
    renderFormatSelect();
    renderChips();
    renderVoiceBox();
    closeProviderEditor();
    toast('API 已删除', 'ok', 1800);
  }

  async function saveDefaults() {
    const fmt = currentFormat();
    const res = await window.dsh.settings.save({ format: fmt.format, sampleRate: fmt.sampleRate, activeProviderId: state.settings.activeProviderId });
    if (res && res.ok) {
      state.settings = res.settings;
      toast('默认参数已保存', 'ok', 1800);
    }
  }

  function bindSettings() {
    $('#btnAddProvider').addEventListener('click', () => editProvider(null));
    $('#btnCancelProvider').addEventListener('click', closeProviderEditor);
    $('#btnSaveProvider').addEventListener('click', saveProviderForm);
    $('#btnTestProvider').addEventListener('click', testProviderForm);
    $('#btnDeleteProvider').addEventListener('click', deleteProviderForm);
    $('#btnTogglePeKey').addEventListener('click', () => {
      const input = $('#peApiKey');
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      $('#btnTogglePeKey').textContent = show ? '隐藏' : '显示';
    });
    $('#peType').addEventListener('change', () => {
      const type = $('#peType').value;
      if (!$('#peBaseUrl').value.trim() || /dashscope|127\.0\.0\.1/.test($('#peBaseUrl').value)) {
        $('#peBaseUrl').value = type === 'dashscope' ? 'https://dashscope.aliyuncs.com/api/v1' : 'http://127.0.0.1:8000';
      }
      if (!$('#peModel').value.trim() || /^cosyvoice|^VoxCPM2$/.test($('#peModel').value.trim())) {
        $('#peModel').value = type === 'dashscope' ? 'cosyvoice-v3.5-plus' : 'VoxCPM2';
      }
      const name = $('#peName');
      if (!name.value.trim()) name.value = type === 'dashscope' ? '千问 CosyVoice' : 'VoxCPM2 · 自有服务器';
    });
    $('#defaultFormat').addEventListener('change', () => {
      prefs.formatId = $('#defaultFormat').value;
      savePrefs();
      renderChips();
    });
    $('#btnSaveDefaults').addEventListener('click', saveDefaults);
    $('#btnOpenDataDir').addEventListener('click', () => window.dsh.shell.openPath(state.settings.dataDir));
    $('#btnClearAllHistory').addEventListener('click', async () => {
      if (!window.confirm('清空全部生成记录及音频文件？此操作不可撤销。')) return;
      await window.dsh.history.clear();
      state.history = [];
      renderRecent();
      renderHistory();
      toast('已清空全部记录', 'ok', 2000);
    });
    $('#providerList').addEventListener('click', (event) => {
      const useBtn = event.target.closest('[data-provider-use]');
      if (useBtn) {
        useProvider(useBtn.dataset.providerUse);
        return;
      }
      const editBtn = event.target.closest('[data-provider-edit]');
      if (editBtn) editProvider(editBtn.dataset.providerEdit);
    });
  }

  /* ------------------------------ 合成页交互 ------------------------------ */

  function bindComposer() {
    const text = $('#text');
    text.addEventListener('input', () => {
      if (text.value.length > MAX_TEXT) text.value = text.value.slice(0, MAX_TEXT);
      renderStats();
    });
    text.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        generate();
      }
    });

    $('#btnGenerate').addEventListener('click', generate);
    $('#btnCancel').addEventListener('click', cancelGeneration);

    $('#chipProvider').addEventListener('click', (event) => {
      if (popType === 'provider') closePopover();
      else openProviderPicker(event.currentTarget);
    });
    $('#chipVoice').addEventListener('click', (event) => {
      if (popType === 'voice') closePopover();
      else openVoicePicker(event.currentTarget);
    });
    $('#chipControl').addEventListener('click', (event) => {
      if (popType === 'control') closePopover();
      else openControl(event.currentTarget);
    });
    $('#chipSpeed').addEventListener('click', (event) => {
      if (popType === 'speed') closePopover();
      else openSpeed(event.currentTarget);
    });
    $('#chipLang').addEventListener('click', (event) => {
      if (popType === 'language') closePopover();
      else openLanguage(event.currentTarget);
    });
    $('#chipFormat').addEventListener('click', (event) => {
      if (popType === 'format') closePopover();
      else openFormat(event.currentTarget);
    });

    $('#btnVoicePicker').addEventListener('click', (event) => openVoicePicker(event.currentTarget));
    $('#btnUploadRef').addEventListener('click', pickReference);
    $('#dropzone').addEventListener('click', pickReference);
    $('#dropzone').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        pickReference();
      }
    });
    $('#dropzone').addEventListener('dragover', (event) => {
      event.preventDefault();
      $('#dropzone').classList.add('drag');
    });
    $('#dropzone').addEventListener('dragleave', () => $('#dropzone').classList.remove('drag'));
    $('#dropzone').addEventListener('drop', (event) => {
      event.preventDefault();
      $('#dropzone').classList.remove('drag');
      const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (file) handleDroppedFile(file);
    });

    $('#refPreview').addEventListener('click', previewReference);
    $('#refRemove').addEventListener('click', clearReference);
    $('#chkHifi').addEventListener('change', () => {
      prefs.hifi = $('#chkHifi').checked;
      savePrefs();
      renderVoiceBox();
    });
    $('#promptText').addEventListener('input', () => {
      prefs.promptText = $('#promptText').value.slice(0, 600);
      savePrefs();
    });

    $('#btnPlayResult').addEventListener('click', () => {
      if (state.last) playEntry(state.last.entry, state.last.base64, state.last.mime);
    });
    $('#btnSaveResult').addEventListener('click', () => {
      if (state.last) saveEntry(state.last.entry.id);
    });
    $('#btnRevealResult').addEventListener('click', () => {
      if (state.last) revealEntry(state.last.entry.id);
    });

    $('#btnAllHistory').addEventListener('click', () => switchView('history'));

    $('#recentGrid').addEventListener('click', (event) => {
      const playBtn = event.target.closest('[data-play]');
      if (playBtn) {
        event.stopPropagation();
        const entry = state.history.find((h) => h.id === playBtn.dataset.play);
        if (entry) playEntry(entry);
        return;
      }
      const item = event.target.closest('[data-entry]');
      if (item) {
        const entry = state.history.find((h) => h.id === item.dataset.entry);
        if (entry) playEntry(entry);
      }
    });
  }

  function bindHistoryPage() {
    $('#historySearch').addEventListener('input', () => {
      state.query = $('#historySearch').value;
      renderHistory();
    });
    $('#btnOpenDir').addEventListener('click', () => window.dsh.shell.openPath(state.settings.dataDir));
    $('#btnClearHistory').addEventListener('click', async () => {
      if (!window.confirm('清空全部生成记录及音频文件？此操作不可撤销。')) return;
      await window.dsh.history.clear();
      state.history = [];
      state.last = null;
      $('#resultCard').hidden = true;
      closePlayer();
      renderRecent();
      renderHistory();
      toast('已清空记录', 'ok', 2000);
    });
    $('#historyList').addEventListener('click', (event) => {
      const del = event.target.closest('[data-delete]');
      if (del) {
        event.stopPropagation();
        deleteEntry(del.dataset.delete);
        return;
      }
      const dl = event.target.closest('[data-download]');
      if (dl) {
        event.stopPropagation();
        saveEntry(dl.dataset.download);
        return;
      }
      const reveal = event.target.closest('[data-reveal]');
      if (reveal) {
        event.stopPropagation();
        revealEntry(reveal.dataset.reveal);
        return;
      }
      const playBtn = event.target.closest('[data-play]');
      if (playBtn) {
        event.stopPropagation();
        const entry = state.history.find((h) => h.id === playBtn.dataset.play);
        if (entry) playEntry(entry);
      }
    });
  }

  function bindPlayer() {
    $('#playerToggle').addEventListener('click', togglePlayer);
    $('#playerClose').addEventListener('click', closePlayer);
    $('#playerDownload').addEventListener('click', () => {
      if (playingEntry) saveEntry(playingEntry.id);
    });
    const seek = $('#playerSeek');
    seek.addEventListener('input', () => {
      setRangeFill(seek);
      if (!audioEl) return;
      const dur = Number(audioEl.duration) || 0;
      if (!dur) return;
      audioEl.currentTime = (Number(seek.value) / 1000) * dur;
      $('#playerCur').textContent = fmtClock(audioEl.currentTime);
    });
  }

  function bindGlobal() {
    const layer = $('#popoverLayer');
    layer.addEventListener('mousedown', (event) => {
      if (event.target === layer) closePopover();
    });
    const pop = $('#popover');
    pop.addEventListener('click', onPopoverClick);
    pop.addEventListener('input', onPopoverInput);

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (isPopoverOpen()) closePopover();
        else if (!state.busy && !$('#providerEditor').hidden) closeProviderEditor();
      }
    });

    window.addEventListener('resize', () => {
      if (isPopoverOpen() && popAnchor) positionPopover(popAnchor);
    });

    window.dsh.tts.onProgress((data) => {
      if (!state.busy) return;
      const note = data && data.note ? data.note : '';
      if (note) progress(note);
    });
    window.dsh.voices.onProgress((data) => {
      if (!state.busy) return;
      if (data && data.note) progress(data.note);
    });
  }

  /* ------------------------------ 启动 ------------------------------ */

  async function init() {
    if (!window.dsh || !window.dsh.app) {
      document.body.innerHTML =
        '<div class="fatal"><h2>启动失败</h2><p>未能加载应用脚本（window.dsh 不存在）。请用 启动.bat 或重新打包后的程序运行。</p></div>';
      return;
    }

    try {
      const info = await window.dsh.app.info();
      $('#appVersion').textContent = `v${info.version || '1.0.0'}`;
    } catch (_) {
      $('#appVersion').textContent = 'v1.0.0';
    }

    state.settings = await window.dsh.settings.get();
    state.voices = (await window.dsh.voices.list()).voices || [];
    state.history = (await window.dsh.history.list()).items || [];

    ensureFormat();
    sanitizeVoiceForProvider();
    savePrefs();

    bindWindowChrome();
    bindComposer();
    bindHistoryPage();
    bindPlayer();
    bindSettings();
    bindGlobal();

    await refreshSettings();
    renderAll();
    $('#refPanel').hidden = false;
    if (state.reference) renderVoiceBox();

    const shotMode = location.search.includes('shot=1');
    if (!shotMode) {
      const providers = state.settings.providers || [];
      const noKey = providers.length === 0 || providers.every((p) => !p.keySet);
      if (noKey) {
        setTimeout(() => {
          toast('还没有可用的 API Key，请到「设置 → API 接入」里配置。', 'error', 6000);
        }, 900);
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
