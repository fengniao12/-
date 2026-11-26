# VoxCPM2 迁移 vllm-omni 部署 Runbook（127.0.0.1:8000）

> 2026-11-24 制定。目标：把 `voxcpm2.service`（FastAPI + voxcpm 2.0.3，Python 3.10）迁移为
> vLLM 0.34.0 + vllm-omni 0.34.0（Python 3.12 conda 环境 omni），外网入口 8015 → 内网 8000 不变，
> API Key 不变，Electron「语音工坊」客户端改为直连 OpenAI 兼容 `/v1/audio/speech`。

## 0. 关键事实与路径

| 项 | 值 |
|---|---|
| SSH | `fnyy@fn.feng-niao.com -p 33`，密码 YOUR_SUDO_PASSWORD（sudo 同密码，`echo YOUR_SUDO_PASSWORD \| sudo -S`） |
| 新环境（conda，当前） | `/home/fnyy/miniconda3/envs/omni`（Python 3.12.16），vllm/vllm-omni 均 0.34.0；解释器有非确定性崩溃，见第 8 节 |
| 新环境（standalone，备用） | `/home/fnyy/omni-venv`（python-build-standalone 3.12.16，重建脚本 `tools/rebuild_standalone_venv.sh`） |
| 模型（本地） | `/home/fnyy/VoxCPM2/models/VoxCPM2`（BF16，含 config.json/tokenizer/tokenization_voxcpm2.py） |
| 部署目录 | `/home/fnyy/vllm-omni-deploy/`（yaml、service 源文件、logs、speakers、smoke 脚本） |
| 新 systemd 单元 | `voxcpm2-omni.service`（旧单元 `voxcpm2.service` 保留不删，停用即可回滚） |
| GPU | 物理 GPU1（`CUDA_VISIBLE_DEVICES=1`），48GB RTX 4090 ×2，驱动 595.99.02 / CUDA 13.2 |
| API Key | `vx-y6e-R4M76W0kyLgCi08-Hk4f9UDThJX3`（vLLM 原生 `--api-key`，Bearer 头不变） |
| 服务名 | `--served-model-name voxcpm2`，客户端 DEFAULT_MODEL='voxcpm2' |
| 网络 | github.com / huggingface.co 不可达；PyPI 用清华源，HF 强制离线（HF_HUB_OFFLINE=1）；conda 用南大镜像 |
| 路由器 | WAN 22 端口是路由器自身 SSH（Debian 12/OpenSSH 9.2），33 才转发到 Ubuntu 服务器（OpenSSH 8.9） |

## 1. 环境安装（已由 setup_omni_env.sh 完成）

幂等脚本 `/home/fnyy/setup_omni_env.sh`（本地副本 `tools/setup_omni_env.sh`）：
Miniconda（南大镜像）→ `conda create -n omni python=3.12` → 清华 pip 安装
`vllm==0.34.0`、`vllm-omni==0.34.0`、`voxcpm==2.0.3 soundfile ninja` → import 验证 →
`/home/fnyy/vllm-omni-freeze.txt`（326 包）。日志：`/home/fnyy/logs/setup_omni.log`。
实际安装结果：torch 2.14.0+cu130、triton 3.8.0、transformers 5.22.2、flashinfer-python 0.7.3、
cuda-python/cuda-bindings 13.5.0。

## 2. 部署文件上传与目录初始化

本地 `remote/vllm_omni_deploy/` 4+2 个文件上传到 `/home/fnyy/vllm-omni-deploy/`：
`voxcpm2.yaml`（正式，gpu_mem 0.9）、`voxcpm2.smoke.yaml`（冒烟，0.7）、
`voxcpm2-omni.service`、`omni.env`、`smoke_test.sh`、`start_smoke.sh`。

```bash
mkdir -p /home/fnyy/vllm-omni-deploy/{logs,speakers}
# 安装单元（先不 enable/start）
sudo cp /home/fnyy/vllm-omni-deploy/voxcpm2-omni.service /etc/systemd/system/
sudo systemctl daemon-reload
```
若改用 standalone venv（第 8 节），需把 service 里 ExecStart 的
`/home/fnyy/miniconda3/envs/omni/bin/vllm` 改为 `/home/fnyy/omni-venv/bin/vllm`。

## 3. 8001 端口冒烟（旧服务不动）

```bash
bash /home/fnyy/vllm-omni-deploy/start_smoke.sh
# 冷启动含 torch.compile/flashinfer JIT，约 60–120s；跟踪：
tail -f /home/fnyy/vllm-omni-deploy/logs/smoke.log
bash /home/fnyy/vllm-omni-deploy/smoke_test.sh 8001   # 9 项全过才算成功
```
冒烟失败先看 smoke.log；显存 OOM 就把 smoke yaml 的 gpu_memory_utilization 再降（0.6）。
停止冒烟：`kill $(cat /home/fnyy/vllm-omni-deploy/smoke.pid)`。

## 4. 正式切换（停机窗口）

```bash
# 4.1 停冒烟实例（若还在）
kill $(cat /home/fnyy/vllm-omni-deploy/smoke.pid) 2>/dev/null || true
# 4.2 停旧 FastAPI，释放 8000 与 GPU1 显存
sudo systemctl stop voxcpm2.service
sudo systemctl disable voxcpm2.service   # 取消开机自启（单元文件保留）
# 4.3 起新服务
sudo systemctl enable --now voxcpm2-omni.service
systemctl status voxcpm2-omni.service --no-pager
journalctl -u voxcpm2-omni.service -f   # 或 tail -f /home/fnyy/vllm-omni-deploy/logs/service.log
# 4.4 本机 + 外网验证
bash /home/fnyy/vllm-omni-deploy/smoke_test.sh 8000
curl -sS http://127.0.0.1:8000/health
```
外网 8015 经路由器既有转发到内网 8000，无需改路由；本机会受 Clash fake-IP 影响，
验证外网用手机热点或 SSH 隧道（`tools/ssh_tunnel.py` → 127.0.0.1:8000）。

## 5. 回滚

```bash
sudo systemctl disable --now voxcpm2-omni.service
sudo systemctl enable --now voxcpm2.service
```
旧目录 `/home/fnyy/VoxCPM2`（含 .venv、app.py、refs）全程不动。

## 6. 接口差异（客户端已适配，供排查）

- 合成：`POST /v1/audio/speech`，body `{model,input,voice:"default",response_format,stream,stream_format,ref_audio?,ref_text?,seed?}`；成功直接返回音频二进制（无 JSON 包裹），错误才 JSON `{error:{message,...}}`。
- 控制指令：客户端把 control 渲染成 `(control)text` 放进 input（hifi 模式不包裹）。
- 参考音频：不再有 `/v1/references` 注册表；音色只存 Electron 本地，合成时以 data URI 内联 `ref_audio`；hifi 用 `ref_text`。服务端限制 1–30s（旧为 1–60s）、内联无 10MB 上传限制但请求体不宜过大。
- `cfg_value/inference_timesteps` 仅服务级（yaml voxcpm2_runtime_config，默认 2.0/10），无请求级覆盖；UI 本就无此控件。
- 健康：`GET /health`（200 就绪/503 加载中，空体）；模型列表 `GET /v1/models`（需 Key）。
- 流式：`stream:true, stream_format:"audio", response_format:"pcm"` → 48kHz s16le 字节流；`stream_format:"sse"` → OpenAI speech.audio.delta/done 事件。

## 7. 切换后收尾

- 观察 24h 日志与显存 `nvidia-smi`；确认开机自启 `systemctl is-enabled voxcpm2-omni`。
- 旧 `voxcpm2.service` 保留一周后再评估删除；`/home/fnyy/VoxCPM2/app.py` 等旧代码备份不动。
- 更新 `docs/VoxCPM2部署说明.md`、`docs/VoxCPM2远程接口.md`，Electron 重新打包发版（dist 副本已同步）。

## 8. 故障处理

### 8.1 非确定性解释器崩溃（conda 环境，2026-11-24 实测）

现象：`vllm serve --omni` 启动秒退，崩溃点每次不同且都是"不可能"的解释器层错误：
triton JIT 装饰链 tokenize 抛 `SystemError: Unmatched paren in format`、
torch._dynamo 装饰器抛 `TypeError: 'str' object is not callable`、
cuda.bindings 导入链 `AttributeError: '_EnumDict' object has no attribute '_is_internal_class'`；
而干净进程单独 import torch / cuda.bindings / triton / vllm_omni 均成功。
判断：非应用 bug，疑似 Anaconda 自编译 CPython 3.12.16 与 cuda-python 13.5.0 非标准
FastEnumMetaclass 冲突（官方 quickstart 用 uv + python-build-standalone，非 conda），
或字节码缓存/硬件内存问题。

排查（`tools/diag_hw.sh`，已上传 `/home/fnyy/diag_hw.sh`）：
`sudo dmesg` 查 EDAC/MCE/ECC、`/sys/devices/system/edac` 计数、`free -h`、
清空 conda env 全部 `__pycache__`、sysconfig 确认构建类型与 Py_GIL_DISABLED。

处置顺序：
1. 清 pycache 后 `PYTHONDONTWRITEBYTECODE=1` 重试冒烟 2–3 次，观察失败率；
2. 仍随机崩 → 用 `tools/rebuild_standalone_venv.sh` 重建：南大镜像下载
   `cpython-3.12.16+20261123-x86_64-unknown-linux-gnu-install_only.tar.gz`（65MiB）→
   解压到 `~/python312-standalone` → 建 `~/omni-venv` → 清华 pip 装同版本三件套
   （pip cache 已暖）→ VERIFY_RESULT: ALL_OK；
3. 改 service 的 ExecStart 指向 `~/omni-venv/bin/vllm` 后再冒烟；
4. 若 dmesg 有硬件 ECC/MCE 记录，停止软件层尝试，安排内存检测（memtest86+）与硬件报修。

### 8.2 整机离线（2026-11-24 19:06 实测）

现象：33/8015/8000/3389 等全部拒连，仅 WAN 22 通（banner `OpenSSH_9.2p1 Debian`，是路由器），
旧 8015 HTTP 直连失败、Clash 回源 502。结论：路由器存活、其后 Ubuntu 整机网络层离线
（宕机/断电/重启/内核 panic）。处置：物理或 awesun/向日葵/rustdesk 检查并手动重启；
voxcpm2.service 开机自启，8015 恢复即代表网络正常。恢复后先查
`uptime`、`last -x reboot shutdown`、`sudo dmesg -T | tail -200` 确认是否崩溃重启及原因。

### 8.3 SSH 认证超时/被拒

高频短连接会触发 sshd MaxStartups 限流：TCP 通、KEX 秒成，但认证阶段 ~40s 后 EOF。
处置：静默 ≥3 分钟（LoginGraceTime 120s 回收）再用单连接 `tools/ssh_probe.py` 探测，
不要立刻重试循环。注意区分 8.2 的整机离线（此时 TCP 直接 refused）。
