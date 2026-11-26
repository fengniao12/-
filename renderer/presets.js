'use strict';

/* 音色预设：VoxCPM2 用「声音设计」自然语言描述，千问 CosyVoice 用instruction */
window.VOICE_PRESETS = [
  {
    id: 'p_wenrou',
    name: '温柔甜妹',
    desc: '年轻女性 · 轻柔甜美',
    control: '年轻女性，声音轻柔甜美，语气温柔亲近，语速偏慢，像在耳边轻声说话',
    gender: 'female',
    tags: ['温柔', '甜美', '耳语'],
    featured: true
  },
  {
    id: 'p_yuanqi',
    name: '元气少女',
    desc: '年轻女性 · 明亮活泼',
    control: '年轻女性，声音明亮有活力，语速稍快，语气轻快俏皮，带笑意',
    gender: 'female',
    tags: ['活泼', '少女']
  },
  {
    id: 'p_qingleng',
    name: '清冷御姐',
    desc: '成熟女性 · 清冷克制',
    control: '成熟女性，音色清冷偏低，语速偏慢，语气克制，带一点距离感',
    gender: 'female',
    tags: ['清冷', '御姐'],
    featured: true
  },
  {
    id: 'p_zhixing',
    name: '知性女声',
    desc: '成熟女性 · 温润沉稳',
    control: '三十岁左右的女性，声音温润沉稳，吐字清晰，语速平稳，适合讲解与旁白',
    gender: 'female',
    tags: ['知性', '讲解']
  },
  {
    id: 'p_xinwen',
    name: '新闻播报',
    desc: '播音腔 · 字正腔圆',
    control: '中年女性播音员，标准普通话，字正腔圆，语速均匀，语气严肃专业',
    gender: 'female',
    tags: ['播音', '专业']
  },
  {
    id: 'p_pangbai',
    name: '叙事旁白',
    desc: '女声 · 低沉有故事感',
    control: '成熟女性，声音低沉有质感，语速缓慢，语气平缓，带故事感与画面感',
    gender: 'female',
    tags: ['旁白', '叙事']
  },
  {
    id: 'p_cixing',
    name: '磁性男声',
    desc: '中年男性 · 浑厚低沉',
    control: '中年男性，声音低沉浑厚，胸腔共鸣饱满，语速平缓，适合纪录片旁白',
    gender: 'male',
    tags: ['低沉', '纪录片'],
    featured: true
  },
  {
    id: 'p_siwen',
    name: '斯文青年',
    desc: '青年男性 · 干净温和',
    control: '年轻男性，声音干净斯文，语调温和，语速适中，像一个有教养的青年在说话',
    gender: 'male',
    tags: ['青年', '温和']
  },
  {
    id: 'p_shaonian',
    name: '自信少年',
    desc: '少年 · 清亮朝气',
    control: '少年男性，声音清亮有朝气，语速略快，语气自信上扬',
    gender: 'male',
    tags: ['少年', '明亮']
  },
  {
    id: 'p_cangsang',
    name: '沧桑大叔',
    desc: '中年男性 · 沙哑阅历',
    control: '中年男性，声音沙哑沧桑，语速慢，语气沉稳，带明显的阅历感',
    gender: 'male',
    tags: ['沧桑', '大叔']
  },
  {
    id: 'p_shuoshu',
    name: '说书人',
    desc: '男声 · 抑扬顿挫',
    control: '中年男性，抑扬顿挫，情绪起伏明显，像在讲评书或章回小说',
    gender: 'male',
    tags: ['说书', '起伏']
  },
  {
    id: 'p_asmr',
    name: 'ASMR 耳语',
    desc: '轻声耳语 · 气息感',
    control: '轻声耳语，气息感强，语速极慢，嘴离麦克风很近，几乎听不到背景声',
    gender: 'female',
    tags: ['耳语', '助眠']
  },
  {
    id: 'p_jieshuo',
    name: '活力解说',
    desc: '男声 · 语速快情绪满',
    control: '年轻男性，语速快，情绪饱满有感染力，适合短视频与赛事解说',
    gender: 'male',
    tags: ['解说', '短视频']
  },
  {
    id: 'p_laoren',
    name: '沉稳老人',
    desc: '老年男性 · 低缓',
    control: '老年男性，声音低缓，略带沙哑，语速慢，语气平和慈祥',
    gender: 'male',
    tags: ['老年', '慈祥']
  }
];

window.AUDIO_FORMATS = [
  { id: 'wav-48000', label: 'WAV · 48 kHz', format: 'wav', sampleRate: 48000, kinds: ['voxcpm', 'dashscope'] },
  { id: 'mp3-48000', label: 'MP3 · 48 kHz', format: 'mp3', sampleRate: 48000, kinds: ['voxcpm', 'dashscope'] },
  { id: 'mp3-24000', label: 'MP3 · 24 kHz', format: 'mp3', sampleRate: 24000, kinds: ['dashscope'] },
  { id: 'wav-24000', label: 'WAV · 24 kHz', format: 'wav', sampleRate: 24000, kinds: ['dashscope'] }
];

window.TTS_LANGUAGES = [
  { id: 'zh', label: '中文' },
  { id: 'en', label: '英语' },
  { id: 'ja', label: '日语' },
  { id: 'ko', label: '韩语' },
  { id: 'yue', label: '粤语' },
  { id: 'es', label: '西班牙语' },
  { id: 'fr', label: '法语' },
  { id: 'de', label: '德语' },
  { id: 'ru', label: '俄语' },
  { id: 'pt', label: '葡萄牙语' },
  { id: 'it', label: '意大利语' },
  { id: 'th', label: '泰语' },
  { id: 'vi', label: '越南语' }
];

window.CONTROL_EXAMPLES = [
  '年轻女性，声音清冷、略带沙哑，语速偏慢，像在讲一个古老的故事',
  '中年男性，低沉有磁性，语速平稳，像纪录片旁白',
  '少女，声音甜美俏皮，语速快一点，句尾带笑意',
  '老人，声音缓慢沙哑，语气慈祥，像在讲故事给孩子听'
];
