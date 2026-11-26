# VoxCPM2 部署与远程调用说明

> 部署完成时间：2026-11-23；服务已在服务器上以 systemd 常驻，外网 8015 入口已实测可用。

## 1. 地址与凭据

| 项目 | 值 |
|---|---|
| 外网 Base URL | `http://127.0.0.1:8000` |
| 服务器本机 | `http://127.0.0.1:8000` |
| API Key | `YOUR_VOXCPM_API_KEY` |
| 鉴权头 | `Authorization: Bearer YOUR_VOXCPM_API_KEY` |
| Swagger | `http://127.0.0.1:8000/docs` |
| 在线接口文档 | `http://127.0.0.1:8000/api.md` |
| SSH | `deploy@<你的服务器地址>`，端口 `33`，密码/密钥请自行配置 |
| 部署目录 | `/opt/voxcpm2` |
| systemd 服务 | `voxcpm2.service` |

端口说明：路由器把外网 **8015** 转发到服务器内网 **8000**；服务本身监听 `0.0.0.0:8000`（沿用原 vLLM 端口）。外网调用写 `:8015`，服务器本机调试写 `:8000`。

## 2. 模型与运行环境

- 模型：`OpenBMB/VoxCPM2` 2B（BF16），48 kHz 输出，30 语言。
- 模型目录：`/opt/voxcpm2/models/VoxCPM2`（约 4.7 GB）。
- 推理设备：`cuda:1`（RTX 4090），加载约 9.4 秒，显存占用约 6.1 GB。
- Python 环境：`/opt/voxcpm2/.venv`，Python 3.10.12，torch 2.11.0+cu130，voxcpm 2.0.3。
- 生成任务在服务端串行执行（单模型实例）；并发请求排队，不会报错，但总耗时叠加。

## 3. 已实现能力

| mode / 接口 | 能力 | 实测 |
|---|---|---|
| `tts` / `POST /v1/tts` | 文本转语音 | 外网 8015 返回 4.16 秒 WAV（399 KB），HTTP 200 |
| `design` / `POST /v1/tts` 或 `/v1/audio/design` | 用自然语言设计音色与风格 | 外网 200，337 KB WAV |
| `clone` / `POST /v1/tts` 或 `/v1/audio/clone` | 可控声音克隆（参考音频 + control） | 外网参考音频上传后 200，261 KB，1.75 秒 |
| `hifi` / `POST /v1/audio/clone/hifi` | 极致克隆（参考音频 + 逐字文本） | 外网 8015 200，261 KB WAV，1.06 秒 |
| `stream=true` / `POST /v1/tts` | 流式生成 | 外网 SSE 22 个 `data:` 事件；本机 PCM 80 chunks，首包 0.09 秒 |

另外提供：`POST /v1/audio/speech`（OpenAI 兼容）、`/v1/references`（参考音频上传/复用）、`/health`、`/v1/models`。

接口字段、curl/Python 示例、流式处理、错误码：见同目录 [`VoxCPM2远程接口.md`](VoxCPM2远程接口.md)，也就是线上 `/api.md`。

## 4. 本机代理 / DNS 注意事项

这台 Windows 机器上的 Clash 类代理会把 `127.0.0.1` 解析成 `198.18.0.14`（fake-IP），普通程序访问 `:8015` 会出现 “Empty reply from server”。两种可靠办法：

1. **SSH 隧道（推荐，已实测）**
   直接双击项目根目录的 `启动VoxCPM隧道.bat`，或在 PowerShell 里运行：
   ```powershell
   $env:SSH_PASS=''
   python tools/ssh_tunnel.py
   ```
   之后把客户端 Base URL 写成 `http://127.0.0.1:8000`。隧道脚本在 `tools/ssh_tunnel.py`，保持窗口运行即可；断开后自动重连。
2. **让代理直连该域名/端口**：在 Clash 规则里给 `127.0.0.1`（或 `180.107.0.121:8015`）加 DIRECT，避免 fake-IP。

## 5. 服务管理

```bash
ssh -p 33 deploy@127.0.0.1
sudo systemctl status voxcpm2
sudo systemctl restart voxcpm2
sudo journalctl -u voxcpm2 -n 100 --no-pager
tail -n 100 /opt/voxcpm2/logs/service.log
```

配置文件：`/opt/voxcpm2/.env`（权限 600）。改端口/Key/设备后执行 `sudo systemctl restart voxcpm2`。

## 6. 与 vLLM 的共存限制

部署 VoxCPM2 时，按你的选择停掉了原来的 vLLM（Qwen3.6-35B-A3B，TP2，262K，占用约 43.8 GB/卡），否则 VoxCPM2 没有足够显存。

- 两者**不能同时常驻**：VoxCPM2 约 6 GB，vLLM 需要约 44 GB/卡，而单卡共 49 GB。
- 两者都使用 **8000** 端口，也不能同时启动。
- 已将 vLLM 的**开机自启关闭**（unit 保留，仍可手动启动），避免重启后抢占 GPU/8000 端口；VoxCPM2 为开机自启。
- 需要恢复 Qwen 时：
  ```bash
  sudo systemctl stop voxcpm2
  sudo systemctl start vllm
  ```
  需要 VoxCPM2 时反向操作。vLLM 的 unit 仍是 `/etc/systemd/system/vllm.service`，未改动其参数。

## 7. 快速验证命令

```bash
curl -H "Authorization: Bearer YOUR_VOXCPM_API_KEY" \
  http://127.0.0.1:8000/health

curl -X POST http://127.0.0.1:8000/v1/tts \
  -H "Authorization: Bearer YOUR_VOXCPM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"text":"你好，这是 VoxCPM2 远程语音。","mode":"tts","response_format":"wav"}' \
  -o out.wav
```

流式（SSE）：

```bash
curl -N -X POST http://127.0.0.1:8000/v1/tts \
  -H "Authorization: Bearer YOUR_VOXCPM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"text":"流式测试。","mode":"tts","stream":true,"stream_format":"sse"}'
```
