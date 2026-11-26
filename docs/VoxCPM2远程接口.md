# VoxCPM2 远程接口调用文档

VoxCPM2（OpenBMB）2B 语音大模型，部署在 `127.0.0.1` 的 FastAPI 服务中，输出 **48 kHz** 音频。
支持：文本转语音（tts）、声音设计（design）、可控声音克隆（clone）、极致克隆（hifi）、流式生成（stream）。

- **Base URL（外网，路由器 8015 → 服务器 8000）**：`http://127.0.0.1:8000`
- **服务器本机**：`http://127.0.0.1:8000`
- **SSH 隧道兜底**：`ssh -p 33 -L 8000:127.0.0.1:8000 deploy@127.0.0.1 -N`，之后客户端可用 `http://127.0.0.1:8000`
- **Swagger**：`http://127.0.0.1:8000/docs`
- **本文档在线版**：`http://127.0.0.1:8000/api.md`
- **鉴权**：若服务设置了 `VOXCPM_API_KEY`，所有 `/v1/*` 请求需带
  `Authorization: Bearer <你的 Key>`；`/health`、`/docs`、`/api.md` 不需要。

> 端口说明：服务在服务器上监听 **8000**（沿用原 vLLM 端口），路由器把外网 **8015** 转发到内网 8000；因此外网调用一律写 `:8015`，在服务器本机调试写 `:8000`。

> 本机代理提示：如果客户端所在机器使用 Clash / fake-IP DNS（`127.0.0.1` 被解析成 `198.18.x.x`），请改用 SSH 隧道 `http://127.0.0.1:8000`，或在代理里给该域名加 DIRECT。

> 生成任务在服务端**串行执行**（单卡、单模型实例）。并发请求会排队，不会报错，但耗时叠加。

---

## 1. 能力与模式

| mode | 用途 | 必填 | 说明 |
|---|---|---|---|
| `tts` | 普通文本转语音 | `text` | 由模型根据文本自动把握语气 |
| `design` | 声音设计 | `text` + `control` | 用自然语言描述想要的音色/风格，如「年轻女性，温柔甜美，语速稍快」 |
| `clone` | 可控声音克隆 | `text` + 参考音频 | 复刻音色，`control` 可继续控制情绪/风格 |
| `hifi` | 极致克隆 | `text` + 参考音频 + `prompt_text` | 同时提供参考音频的**逐字文本**，相似度和细节最高 |

参考音频既可以**每次内联 base64**，也可以先上传得到 `reference_id` 后反复使用。

---

## 2. 公共请求字段（`POST /v1/tts`）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `text` | string | — | 要合成的文本，1–2000 字符 |
| `mode` | string | `tts` | `tts` / `design` / `clone` / `hifi` |
| `control` | string | null | 声音/风格描述；design、clone 生效 |
| `reference_audio` | string | null | 参考音频 base64，或 `data:audio/wav;base64,...` |
| `reference_id` | string | null | 先用 `/v1/references` 上传得到的 ID，优先级高于 `reference_audio` |
| `prompt_text` | string | null | 参考音频的逐字文本；`mode=hifi` 必填 |
| `cfg_value` | float | 2.0 | 1.0–3.0，越高越贴指令，过高可能不稳定 |
| `inference_timesteps` | int | 10 | 4–30，越高音质/细节越好、越慢 |
| `normalize` | bool | false | 文本正则化（数字、符号等） |
| `denoise` | bool | false | 参考音频降噪；服务需以 `VOXCPM_DENOISER=1` 启动 |
| `max_len` | int | 4096 | 生成 token 上限，长文本可调高（≤8192） |
| `seed` | int | null | 固定种子可复现 |
| `response_format` | string | `wav` | `wav` / `mp3` / `json`（json 返回 base64 与时长） |
| `stream` | bool | false | true 时流式返回 |
| `stream_format` | string | `pcm` | `pcm`：裸 PCM s16le；`sse`：Server-Sent Events + base64 |

参考音频要求：服务端用 ffmpeg 统一转为 **16 kHz 单声道 WAV**；时长 1–60 秒，推荐 5–30 秒；单文件 ≤25 MB；优先干净人声，避免 BGM、噪声、多人说话。

---

## 3. 健康检查

```bash
curl http://127.0.0.1:8000/health
```

返回示例（节选）：

```json
{
  "status": "ok",
  "model": "VoxCPM2",
  "device": "cuda:1",
  "sample_rate": 48000,
  "optimize": false,
  "denoiser": false,
  "loaded_at": 1760000000.0,
  "load_seconds": 23.5,
  "busy": false,
  "gpu": [{"index": 1, "name": "NVIDIA GeForce RTX 4090", "memory_free_mb": 4600}],
  "api_key_required": true
}
```

`status` 取值：`idle`（未加载）、`loading`（加载中）、`ready`、`error`。
首次请求会触发加载，可能等待 1–2 分钟；服务以 `VOXCPM_PRELOAD=1` 启动时会在后台预加载。

---

## 4. 文本转语音

```bash
curl -X POST http://127.0.0.1:8000/v1/tts \
  -H "Authorization: Bearer $VOXCPM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "夜色像一层薄薄的墨，慢慢铺在城市的屋顶上。",
    "mode": "tts",
    "response_format": "wav",
    "cfg_value": 2.0,
    "inference_timesteps": 10
  }' --output out.wav
```

响应头含 `X-Sample-Rate: 48000`、`X-Duration`、`X-Mode`、`X-Request-Id`。
`response_format=json` 时返回：

```json
{
  "mode": "tts",
  "sample_rate": 48000,
  "duration": 4.213,
  "format": "wav",
  "audio_base64": "UklGR...",
  "request_id": "…"
}
```

---

## 5. 声音设计

```bash
curl -X POST http://127.0.0.1:8000/v1/tts \
  -H "Authorization: Bearer $VOXCPM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "欢迎来到天幻纪元，旅人。",
    "mode": "design",
    "control": "年轻女性，清冷、略带沙哑，语速偏慢，像在讲一个古老的故事",
    "response_format": "mp3"
  }' --output design.mp3
```

服务端实际提交给模型的形式是：`(control)text`，例如
`(年轻女性，清冷、略带沙哑…)欢迎来到天幻纪元，旅人。`
如果 `text` 本身已以 `(指令)` 开头，则不会重复添加。

---

## 6. 可控声音克隆

### 6.1 方式 A：每次内联 base64

```bash
base64 -w0 my_voice.wav > my_voice.b64

curl -X POST http://127.0.0.1:8000/v1/tts \
  -H "Authorization: Bearer $VOXCPM_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"text\": \"这句话用你的声音读出来。\",
    \"mode\": \"clone\",
    \"control\": \"温柔、亲近，像在耳边说话\",
    \"reference_audio\": \"$(cat my_voice.b64)\",
    \"response_format\": \"wav\"
  }" --output clone.wav
```

### 6.2 方式 B：先上传，复用 reference_id（推荐）

```bash
curl -X POST http://127.0.0.1:8000/v1/references \
  -H "Authorization: Bearer $VOXCPM_API_KEY" \
  -F "file=@my_voice.wav"

# {"id":"ref_1a2b3c4d5e6f7a8b","duration":12.34,"sample_rate":16000}
```

之后：

```bash
curl -X POST http://127.0.0.1:8000/v1/tts \
  -H "Authorization: Bearer $VOXCPM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "这是复用同一个克隆音色生成的第二句话。",
    "mode": "clone",
    "reference_id": "ref_1a2b3c4d5e6f7a8b"
  }' --output clone2.wav
```

参考音频管理：

```bash
curl -H "Authorization: Bearer $VOXCPM_API_KEY" http://127.0.0.1:8000/v1/references
curl -X DELETE -H "Authorization: Bearer $VOXCPM_API_KEY" \
  http://127.0.0.1:8000/v1/references/ref_1a2b3c4d5e6f7a8b
```

### 6.3 multipart 便捷接口

```bash
curl -X POST http://127.0.0.1:8000/v1/audio/clone \
  -H "Authorization: Bearer $VOXCPM_API_KEY" \
  -F "text=这是用上传文件直接克隆的一段话。" \
  -F "control=沉稳、克制" \
  -F "file=@my_voice.wav" \
  -F "response_format=wav" --output clone3.wav
```

---

## 7. 极致克隆（hifi）

需要参考音频的**逐字文本**，相似度最高；适合角色固定音色、旁白长篇。

```bash
curl -X POST http://127.0.0.1:8000/v1/audio/clone/hifi \
  -H "Authorization: Bearer $VOXCPM_API_KEY" \
  -F "text=地底的火焰仍在燃烧，而我们已经没有退路。" \
  -F "prompt_text=这是参考音频里说的原话，必须逐字一致。" \
  -F "file=@my_voice.wav" \
  -F "response_format=wav" --output hifi.wav
```

> `prompt_text` 与参考音频不一致会明显降低相似度。若没有逐字稿，请用 `mode=clone`。

---

## 8. 流式生成

### 8.1 裸 PCM（推荐给播放器/桌面端）

```bash
curl -N -X POST http://127.0.0.1:8000/v1/tts \
  -H "Authorization: Bearer $VOXCPM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "这是一段流式合成的长文本，前端可以边收边播。",
    "mode": "tts",
    "stream": true,
    "stream_format": "pcm"
  }' --output stream.pcm

# 裸 PCM 封装成 WAV（48 kHz、单声道、s16le）
ffmpeg -f s16le -ar 48000 -ac 1 -i stream.pcm stream.wav
```

响应头：`X-Sample-Rate: 48000`、`X-Channels: 1`、`X-Encoding: pcm_s16le`，
`Content-Type: application/octet-stream`。

### 8.2 SSE（事件流 + base64 分片）

```bash
curl -N -X POST http://127.0.0.1:8000/v1/tts \
  -H "Authorization: Bearer $VOXCPM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"text":"流式 SSE 测试。","mode":"tts","stream":true,"stream_format":"sse"}'
```

事件格式：

```
event: start
data: {"sample_rate":48000,"format":"pcm_s16le"}

event: audio
data: {"audio":"…base64 的 PCM s16le 片段…"}

event: done
data: {}
```

每个片的字节可直接解码为 s16le，按顺序拼接即为完整 PCM。

### 8.3 Python 流式读取

```python
import requests

url = "http://127.0.0.1:8000/v1/tts"
headers = {"Authorization": "Bearer " + KEY, "Content-Type": "application/json"}
payload = {"text": "流式生成示例。", "mode": "tts", "stream": True, "stream_format": "pcm"}

with requests.post(url, headers=headers, json=payload, stream=True, timeout=600) as r:
    r.raise_for_status()
    with open("stream.pcm", "wb") as f:
        for chunk in r.iter_content(chunk_size=4096):
            if chunk:
                f.write(chunk)
```

---

## 9. OpenAI 兼容 shim（可选）

```bash
curl -X POST http://127.0.0.1:8000/v1/audio/speech \
  -H "Authorization: Bearer $VOXCPM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "voxcpm2",
    "input": "兼容 OpenAI audio/speech 的调用方式。",
    "voice": "温柔的女性声音",
    "response_format": "mp3"
  }' --output speech.mp3
```

`voice` 会当作 `control` 使用；不带参考音频时走 `design`，带 `reference_audio`/`reference_id` 时走 `clone`。

---

## 10. 错误码

统一返回：

```json
{"error": {"code": 400, "message": "具体原因"}}
```

| HTTP | 含义 |
|---|---|
| 400 | 参数错误：文本为空/超长、参考音频过短/过长、hifi 缺 `prompt_text`、base64 非法 |
| 401 | 缺少或错误的 Bearer Key |
| 404 | `reference_id` 不存在 |
| 413 | 上传音频超过 25 MB |
| 500 | 模型生成或编码失败（可重试；服务端会记录日志） |

---

## 11. 使用建议

1. **参考音频**：5–30 秒、单一说话人、无 BGM、16 kHz 以上；先做降噪/切静音可明显提升克隆相似度。
2. **长文本**：建议按 200–500 字切段，逐段合成后再拼接；单次 `text` 上限 2000 字符，`max_len` 可到 8192。
3. **情绪/风格**：优先用 `control` 自然语言描述；设计/克隆模式都支持，hifi 模式忽略风格指令、更依赖参考音频本身。
4. **速度**：`inference_timesteps` 从 10 起调；追求质量可到 16–20，实时场景可降到 6–8。
5. **流式首包**：首次请求包含模型加载与预热，首包可能较慢；之后同一进程内会明显加快。
6. **并发**：服务端串行生成；批量任务请客户端串行或自行排队。
7. **计费/版权**：遵守 VoxCPM2 模型许可与火山/阿里云相关条款；不要克隆未经授权的声音。

---

## 12. Python 完整客户端

见同目录 `client_example.py`，包含：

- `tts(text, mode="tts", ...)` → 保存 wav
- `design(text, control)` → 保存 wav
- `clone(text, audio_path)` → 保存 wav
- `hifi(text, audio_path, prompt_text)` → 保存 wav
- `stream(text, out_pcm)` → 流式保存 PCM
- `upload_reference(path)` → reference_id

设置环境变量后直接运行：

```bash
export VOXCPM_BASE_URL=http://127.0.0.1:8000
export VOXCPM_API_KEY=你的Key
python client_example.py
```
