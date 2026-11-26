#!/usr/bin/env bash
# 在服务器上手动启动 vllm-omni 冒烟实例（端口 8001，与旧 FastAPI 服务 8000 共存）。
# 用法：bash /opt/vllm-omni-deploy/start_smoke.sh
set -euo pipefail
DEPLOY=/opt/vllm-omni-deploy
mkdir -p "$DEPLOY/logs" "$DEPLOY/speakers"

# 单卡可见：物理 GPU1；yaml 内 devices "0" 相对该卡
export CUDA_VISIBLE_DEVICES=1
# huggingface.co 不可达，强制离线（模型/tokenizer 全部本地）
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
export HF_HOME=/opt/.cache/huggingface
export SPEAKER_SAMPLES_DIR="$DEPLOY/speakers"
export PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
export VLLM5_OMNI_DRIVEN_ORCH=1

if [ -f "$DEPLOY/smoke.pid" ] && kill -0 "$(cat "$DEPLOY/smoke.pid")" 2>/dev/null; then
  echo "smoke 实例已在运行：pid=$(cat "$DEPLOY/smoke.pid")"
  exit 0
fi

nohup /opt/miniconda3/envs/omni/bin/vllm serve \
  /opt/voxcpm2/models/VoxCPM2 \
  --omni \
  --host 0.0.0.0 \
  --port 8001 \
  --served-model-name voxcpm2 \
  --api-key YOUR_VOXCPM_API_KEY \
  --deploy-config "$DEPLOY/voxcpm2.smoke.yaml" \
  > "$DEPLOY/logs/smoke.log" 2>&1 &
echo $! > "$DEPLOY/smoke.pid"
echo "smoke 已启动 pid=$(cat "$DEPLOY/smoke.pid")，日志：$DEPLOY/logs/smoke.log"
echo "停止：kill \$(cat $DEPLOY/smoke.pid)"
