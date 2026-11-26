#!/usr/bin/env bash
# vllm-omni VoxCPM2 冒烟测试：在服务器上对 http://127.0.0.1:${PORT} 跑全接口用例。
# 用法：bash smoke_test.sh [port] [api_key]
set -u
PORT="${1:-8001}"
KEY="${2:-YOUR_VOXCPM_API_KEY}"
BASE="http://127.0.0.1:${PORT}"
OUT="$(mktemp -d)"
FAIL=0
REF_WAV="/opt/voxcpm2/refs/ref_065f39a9f856d7ff.wav"   # 1.2s，满足 1–30s 限制
trap 'rm -rf "$OUT"' EXIT

say() { echo -e "\n=== $* ==="; }
check() { if [ "$1" = "$2" ]; then echo "PASS $3"; else echo "FAIL $3 (got=$1 want=$2)"; FAIL=1; fi; }

say "1. 等待 /health 就绪（最多 300s，含首次编译预热）"
OK=0
for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$BASE/health" || true)
  if [ "$code" = "200" ]; then OK=1; echo "health 200 after ~$((i*5))s"; break; fi
  sleep 5
done
check "$OK" "1" "GET /health 最终 200"

say "2. 鉴权：无 Key 访问 /v1/models 应 401，带 Key 应 200 且模型名为 voxcpm2"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/models")
check "$code" "401" "无 Key 被拒"
code=$(curl -s -o "$OUT/models.json" -w '%{http_code}' -H "Authorization: Bearer $KEY" "$BASE/v1/models")
check "$code" "200" "带 Key 可访问"
python3 - "$OUT/models.json" <<'PY'
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
ids = [m.get("id") for m in data.get("data", [])]
assert "voxcpm2" in ids, f"voxcpm2 not in {ids}"
print("PASS 服务名包含 voxcpm2：", ids)
PY

say "3. 零样本 TTS（wav）"
curl -sS -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"voxcpm2","input":"你好，这是 vllm-omni 框架的冒烟测试。","voice":"default","response_format":"wav"}' \
  -o "$OUT/zero.wav" -D "$OUT/zero.hdr"
head -c 4 "$OUT/zero.wav" | grep -q RIFF && echo "PASS RIFF 头" || { echo "FAIL 非 WAV：$(head -c 200 "$OUT/zero.wav")"; FAIL=1; }
size=$(stat -c%s "$OUT/zero.wav"); echo "字节数=$size"; [ "$size" -gt 10000 ] && echo "PASS 体积合理" || { echo "FAIL 体积过小"; FAIL=1; }
grep -qi 'audio/sample-rate: 48000\|x-audio-sample-rate: 48000' "$OUT/zero.hdr" && echo "PASS 采样率 48k 响应头" || echo "WARN 未见 48k 响应头（以文件头为准）"

say "4. 克隆（ref_audio 内联 data URI）"
DATAURI="data:audio/wav;base64,$(base64 -w0 "$REF_WAV")"
python3 - "$KEY" "$BASE" "$DATAURI" "$OUT/clone.wav" <<'PY'
import json, sys, urllib.request
key, base, data_uri, out = sys.argv[1:5]
body = json.dumps({"model":"voxcpm2","input":"这是参考音频克隆测试。","voice":"default",
                   "response_format":"wav","ref_audio":data_uri}).encode()
req = urllib.request.Request(base + "/v1/audio/speech", data=body,
      headers={"Authorization":f"Bearer {key}","Content-Type":"application/json"})
with urllib.request.urlopen(req, timeout=300) as r, open(out, "wb") as f:
    f.write(r.read())
print("HTTP OK")
PY
head -c 4 "$OUT/clone.wav" | grep -q RIFF && echo "PASS 克隆返回 WAV" || { echo "FAIL 克隆响应异常：$(head -c 200 "$OUT/clone.wav")"; FAIL=1; }

say "5. 极致克隆（ref_audio + ref_text）"
python3 - "$KEY" "$BASE" "$DATAURI" "$OUT/hifi.wav" <<'PY'
import json, sys, urllib.request
key, base, data_uri, out = sys.argv[1:5]
body = json.dumps({"model":"voxcpm2","input":"极致克隆模式冒烟测试。","voice":"default",
                   "response_format":"wav","ref_audio":data_uri,
                   "ref_text":"这是参考音频里说的原话。"}).encode()
req = urllib.request.Request(base + "/v1/audio/speech", data=body,
      headers={"Authorization":f"Bearer {key}","Content-Type":"application/json"})
with urllib.request.urlopen(req, timeout=300) as r, open(out, "wb") as f:
    f.write(r.read())
print("HTTP OK")
PY
head -c 4 "$OUT/hifi.wav" | grep -q RIFF && echo "PASS 极致克隆返回 WAV" || { echo "FAIL 极致克隆响应异常：$(head -c 200 "$OUT/hifi.wav")"; FAIL=1; }

say "6. 控制指令（design 风格，input 里包 (control)text）"
curl -sS -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"voxcpm2","input":"(年轻女性，声音轻柔)这是声音设计测试。","voice":"default","response_format":"wav"}' \
  -o "$OUT/design.wav"
head -c 4 "$OUT/design.wav" | grep -q RIFF && echo "PASS design 返回 WAV" || { echo "FAIL design 异常"; FAIL=1; }

say "7. 流式 PCM（stream + stream_format=audio）"
curl -sS -N -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"voxcpm2","input":"流式合成测试。","voice":"default","response_format":"pcm","stream":true,"stream_format":"audio"}' \
  -o "$OUT/stream.pcm" -D "$OUT/stream.hdr"
psize=$(stat -c%s "$OUT/stream.pcm"); echo "PCM 字节数=$psize"
[ "$psize" -gt 1000 ] && echo "PASS 流式 PCM 有数据" || { echo "FAIL PCM 数据过少"; FAIL=1; }
grep -qi 'audio/sample-rate: 48000\|x-audio-sample-rate: 48000' "$OUT/stream.hdr" && echo "PASS PCM 48k 响应头" || echo "WARN PCM 响应头未见 48k"

say "8. mp3 格式"
curl -sS -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"voxcpm2","input":"MP3 格式测试。","voice":"default","response_format":"mp3"}' \
  -o "$OUT/out.mp3"
msize=$(stat -c%s "$OUT/out.mp3")
[ "$msize" -gt 1000 ] && echo "PASS mp3 有数据（$msize 字节）" || { echo "FAIL mp3 异常"; FAIL=1; }

say "9. 错误请求：空 input 应 400"
code=$(curl -s -o "$OUT/err.json" -w '%{http_code}' -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"voxcpm2","input":"","voice":"default"}' "$BASE/v1/audio/speech")
check "$code" "400" "空 input 返回 400"
echo "错误体：$(head -c 200 "$OUT/err.json")"

echo
if [ "$FAIL" = "0" ]; then echo "🎉 SMOKE ALL PASSED（产物临时目录 $OUT，已在退出时清理）"; else echo "💥 SMOKE FAILED"; exit 1; fi
