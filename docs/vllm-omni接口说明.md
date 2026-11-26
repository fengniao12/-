# VoxCPM2 vllm-omni 远程接口说明（127.0.0.1:8000）

> 适用版本：vLLM 0.34.0 + vllm-omni 0.34.0（2026-11-24 迁移后）。
> 旧 FastAPI 接口（/v1/tts、/v1/references 等）已停用，本文档描述新的 OpenAI 兼容接口。
> 外网入口 `http://127.0.0.1:8000` → 路由器转发 → 服务器内网 `0.0.0.0:8000`。
> 本机受 Clash fake-IP 影响直连可能失败，可靠方式：SSH 隧道后访问 `http://127.0.0.1:8000`（见 tools/ssh_tunnel.py）。

## 1. 通用约定

- 所有业务接口需要头：`Authorization: Bearer YOUR_VOXCPM_API_KEY`（vLLM 原生 `--api-key`）。
- 合成接口：`POST /v1/audio/speech`，`Content-Type: application/json`。
- 成功（非流式）直接返回**音频二进制**（`audio/wav`、`audio/mpeg` 等），没有 JSON 包裹；
  失败才返回 JSON：`{"error":{"message":...,"type":...,"param":...,"code":...}}`，HTTP 状态码为 4xx/5xx。
- 模型名固定 `voxcpm2`（服务端 `--served-model-name`）；`voice` 字段 schema 必填但 VoxCPM2 忽略，统一传 `"default"`。
- 原生采样率 48kHz 单声道。

## 2. 请求体字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `model` | string | 固定 `"voxcpm2"` |
| `input` | string | 必填，要合成的文本；control 控制指令由客户端渲染为 `(control)正文` 后放入本字段 |
| `voice` | string | 必填但被忽略，传 `"default"` |
| `response_format` | string | `wav`（默认）/`mp3`/`flac`/`pcm`/`opus` |
| `sample_rate` | int? | 省略则用原生 48000 |
| `stream` | bool | 是否流式，默认 false |
| `stream_format` | string | `sse`（默认，OpenAI 事件）或 `audio`（裸 PCM 字节流，配合 response_format=pcm） |
| `ref_audio` | string | 克隆参考音频：`data:audio/wav;base64,...` 或 http(s) URL；时长 **1–30 秒**，多声道服务端自动转单声道 |
| `ref_text` | string | 极致克隆（hifi）时参考音频的转写文本，提升克隆质量 |
| `seed` | int? | 显式 seed 可复现但会独占引擎等排空，降低吞吐 |
| `speed` | float | 0.25–4.0 |
| `language` | string | 默认 Auto 自动检测 |

未声明字段（如旧版 `cfg_value`、`inference_timesteps`、`mode`、`reference_id`）会被静默丢弃。
`cfg_value=2.0`、`inference_timesteps=10` 为服务级固定值（deploy yaml 的 voxcpm2_runtime_config），
与旧客户端默认值一致，不支持请求级修改。

## 3. 四种业务模式如何映射

| 旧模式 | 新请求形态 |
|---|---|
| tts（零样本） | 仅 `input`，无 `ref_audio` |
| design（声音设计） | 把 control 渲染成 `(control)正文` 放入 `input`，无 `ref_audio` |
| clone（参考克隆） | `input` + `ref_audio`（data URI） |
| hifi（极致克隆） | `input` + `ref_audio` + `ref_text`；input 不包裹 control |

## 4. 响应头

- `audio/sample-rate`（或 `x-audio-sample-rate`）：采样率，VoxCPM2 为 48000
- `x-audio-channels`：声道数（1）
- `x-audio-duration-seconds`：音频时长（秒）
- `x-vllm-omni-input-tokens` / `output-tokens` / `total-tokens`：用量
- `x-request-id`：请求追踪 ID

## 5. 流式

### 5.1 裸 PCM（低延迟播放）
请求 `"stream": true, "stream_format": "audio", "response_format": "pcm"`，
响应体即 48kHz、16bit、小端、单声道 PCM 字节流，HTTP 头带 `audio/sample-rate: 48000`。
播放示例：`curl ... | play -t raw -r 48000 -e signed -b 16 -c 1 -`

### 5.2 SSE 事件
`"stream_format": "sse"`，事件类型：
- `speech.audio.delta`：base64 音频块（data 内含 sample_rate/channels/response_format）
- `speech.audio.done`：最终 duration 与 usage
- `speech.audio.error`：错误

## 6. 健康检查与模型列表

- `GET /health`：无需 Key。200 空体=就绪；503=模型加载中。
- `GET /v1/models`：需 Key，返回 `{"data":[{"id":"voxcpm2",...}]}`。
- 客户端 health 逻辑：先探 /health，再带 Key 探 /v1/models 取模型名；
  无 Key 遇 401/403 时返回 `status=unauthorized, apiKeyRequired=true`，不硬失败。

## 7. 参考音频（音色）机制变化

- 旧 `/v1/references` 注册表（reference_id）**已移除**。
- Electron 客户端把参考音频只保存在本机 userData/refs/，每次合成读出并转 data URI 内联到 `ref_audio`。
- 服务端备用能力 `POST /v1/audio/voices`（multipart：audio_sample ≤10MB、name、consent 必填、ref_text 可选）
  可注册命名音色，持久化在 `SPEAKER_SAMPLES_DIR=/opt/vllm-omni-deploy/speakers`，
  `GET /v1/audio/voices` 列表、`DELETE /v1/audio/voices/{name}` 删除；当前客户端不使用该机制。
- 时长限制由旧的 1–60s 收紧为 **1–30s**；上传类接口音频 ≤10MB，MIME 限 wav/mp3/flac/ogg/webm/m4a 等。

## 8. curl 示例

```bash
KEY=YOUR_VOXCPM_API_KEY
BASE=http://127.0.0.1:8000   # 走隧道；外网把主机换成 127.0.0.1:8000

# 零样本
curl -sS -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"voxcpm2","input":"你好，这是冒烟测试。","voice":"default","response_format":"wav"}' \
  -o zero.wav

# 克隆（ref_audio 内联）
DATAURI="data:audio/wav;base64,$(base64 -w0 ref.wav)"
curl -sS -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d "{\"model\":\"voxcpm2\",\"input\":\"克隆测试。\",\"voice\":\"default\",\"ref_audio\":\"$DATAURI\"}" \
  -o clone.wav

# 流式 PCM
curl -sS -N -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"voxcpm2","input":"流式测试。","voice":"default","response_format":"pcm","stream":true,"stream_format":"audio"}' \
  -o stream.pcm
```

## 9. 错误码对照（客户端 lib/voxcpm.js）

| HTTP | 含义 | 客户端提示要点 |
|---|---|---|
| 401/403 | API Key 缺失/错误 | 检查服务商配置里的 vLLM API Key |
| 400 | 请求参数错误 | 常见：空 input、参考音频不在 1–30s、ref_audio 格式非法 |
| 404 | 接口或模型不存在 | 检查 baseURL 与服务是否已切换到 vllm-omni |
| 413 | 请求体过大 | 参考音频 data URI 太大，换更短的音频 |
| 5xx | 服务端错误 | 看服务器 logs/service.log；冷启动首次编译可能较慢 |
| 网络失败 | 连不上 | 启动「启动VoxCPM隧道.bat」走 SSH 隧道 |
