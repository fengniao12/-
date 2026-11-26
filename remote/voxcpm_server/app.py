#!/usr/bin/env python3
"""
VoxCPM2 FastAPI service.

Endpoints are documented in API.md and at /docs (Swagger UI).
The model is loaded lazily on first request, or preloaded at startup when
VOXCPM_PRELOAD=1. Only one generation runs at a time (single GPU).
"""
from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import os
import re
import secrets
import subprocess
import tempfile
import threading
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal, Optional

import numpy as np
import soundfile as sf
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent
MODEL_DIR = Path(os.getenv("VOXCPM_MODEL_DIR", str(ROOT / "models" / "VoxCPM2")))
DEVICE = os.getenv("VOXCPM_DEVICE", "cuda:1")
API_KEY = os.getenv("VOXCPM_API_KEY", "").strip()
PRELOAD = os.getenv("VOXCPM_PRELOAD", "1") == "1"
OPTIMIZE = os.getenv("VOXCPM_OPTIMIZE", "0") == "1"
LOAD_DENOISER = os.getenv("VOXCPM_DENOISER", "0") == "1"
MAX_TEXT = int(os.getenv("VOXCPM_MAX_TEXT", "2000"))
MAX_AUDIO_MB = int(os.getenv("VOXCPM_MAX_AUDIO_MB", "25"))
MAX_REF_SECONDS = float(os.getenv("VOXCPM_MAX_REF_SECONDS", "60"))
REFS_DIR = ROOT / "refs"
REFS_DIR.mkdir(exist_ok=True)
INDEX_PATH = REFS_DIR / "index.json"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("voxcpm-api")

app = FastAPI(
    title="VoxCPM2 TTS API",
    version="1.0.0",
    description=(
        "VoxCPM2 文本转语音 / 声音设计 / 可控声音克隆 / 极致克隆 / 流式生成。"
        " 所有生成接口使用同一个模型实例，串行执行。"
    ),
)

_model = None
_load_lock = threading.Lock()
_gen_lock = threading.Lock()
_state: dict = {
    "status": "idle",
    "error": None,
    "loaded_at": None,
    "load_seconds": None,
}
_denoiser_loaded = False


# --------------------------------------------------------------------------- #
# Auth / errors
# --------------------------------------------------------------------------- #
def require_key(authorization: Optional[str] = Header(default=None)) -> None:
    if API_KEY and authorization != f"Bearer {API_KEY}":
        raise HTTPException(
            status_code=401,
            detail="invalid or missing API key; use Authorization: Bearer <key>",
            headers={"WWW-Authenticate": "Bearer"},
        )


@app.exception_handler(HTTPException)
async def _http_error(_request, exc: HTTPException):
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": {"code": exc.status_code, "message": exc.detail}},
        headers=exc.headers,
    )


# --------------------------------------------------------------------------- #
# Model loading
# --------------------------------------------------------------------------- #
def _load_model_sync() -> None:
    global _model, _denoiser_loaded
    if _model is not None:
        return
    with _load_lock:
        if _model is not None:
            return
        t0 = time.time()
        _state["status"] = "loading"
        try:
            import torch  # noqa: F401

            from voxcpm import VoxCPM

            log.info("loading VoxCPM2 from %s on %s (optimize=%s)", MODEL_DIR, DEVICE, OPTIMIZE)
            _model = VoxCPM.from_pretrained(
                str(MODEL_DIR),
                load_denoiser=LOAD_DENOISER,
                device=DEVICE,
                optimize=OPTIMIZE,
                local_files_only=True,
            )
            _denoiser_loaded = LOAD_DENOISER
            # Warm up one tiny generation so the first real request is not
            # penalised by lazy CUDA / kernel initialisation.
            if os.getenv("VOXCPM_WARMUP", "1") == "1":
                try:
                    _model.generate(text="你好。", inference_timesteps=6, max_len=80)
                except Exception as exc:  # warmup must not kill the service
                    log.warning("warmup failed: %s", exc)
            _state.update(
                status="ready",
                error=None,
                loaded_at=time.time(),
                load_seconds=round(time.time() - t0, 2),
            )
            log.info("model ready in %.2fs", time.time() - t0)
        except Exception as exc:
            _state.update(status="error", error=str(exc))
            log.exception("model load failed")
            raise


def get_model():
    if _model is None:
        _load_model_sync()
    return _model


def _load_bg() -> None:
    try:
        _load_model_sync()
    except Exception:
        pass


@asynccontextmanager
async def lifespan(_app: FastAPI):
    if PRELOAD:
        threading.Thread(target=_load_bg, name="voxcpm-loader", daemon=True).start()
    yield


app.router.lifespan_context = lifespan


def sample_rate() -> int:
    if _model is None:
        return 48000
    return int(getattr(_model.tts_model, "sample_rate", 48000))


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _check_text(text: str) -> str:
    text = (text or "").strip()
    if not text:
        raise HTTPException(400, "text must not be empty")
    if len(text) > MAX_TEXT:
        raise HTTPException(400, f"text too long: {len(text)} > {MAX_TEXT} characters")
    return text


def _decode_audio_b64(value: str) -> bytes:
    value = (value or "").strip()
    if not value:
        raise HTTPException(400, "reference_audio is empty")
    if value.startswith("data:"):
        try:
            value = value.split(",", 1)[1]
        except IndexError:
            raise HTTPException(400, "invalid data URI")
    if len(value) > MAX_AUDIO_MB * 1024 * 1024 * 2:
        raise HTTPException(413, f"reference audio too large (limit {MAX_AUDIO_MB} MB)")
    try:
        return base64.b64decode(value, validate=True)
    except Exception:
        raise HTTPException(400, "reference_audio is not valid base64")


def _to_wav16k(raw: bytes, name: str = "upload") -> Path:
    """Convert arbitrary uploaded audio to a mono 16 kHz WAV via ffmpeg."""
    suffix = Path(name).suffix.lower() or ".bin"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix, dir=str(ROOT / "tmp")) as src:
        src.write(raw)
        src_path = src.name
    out_path = str(ROOT / "tmp" / f"ref_{uuid.uuid4().hex}.wav")
    try:
        proc = subprocess.run(
            [
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                "-i", src_path,
                "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
                out_path,
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        if proc.returncode != 0:
            raise HTTPException(400, "cannot decode reference audio: " + proc.stderr.decode("utf-8", "replace")[-300:])
        info = sf.info(out_path)
        if info.duration < 1.0:
            raise HTTPException(400, "reference audio too short (need >= 1s, 5-30s recommended)")
        if info.duration > MAX_REF_SECONDS:
            raise HTTPException(400, f"reference audio too long ({info.duration:.1f}s > {MAX_REF_SECONDS}s)")
        return Path(out_path)
    finally:
        try:
            os.unlink(src_path)
        except OSError:
            pass


def _load_index() -> list[dict]:
    if not INDEX_PATH.exists():
        return []
    try:
        return json.loads(INDEX_PATH.read_text("utf-8"))
    except Exception:
        return []


def _save_index(items: list[dict]) -> None:
    INDEX_PATH.write_text(json.dumps(items, ensure_ascii=False, indent=2), "utf-8")


def _resolve_reference(
    reference_audio: Optional[str],
    reference_id: Optional[str],
) -> tuple[Optional[Path], bool]:
    """Return (path, is_temp). reference_id wins over inline base64."""
    if reference_id:
        path = REFS_DIR / f"{reference_id}.wav"
        if not path.exists():
            raise HTTPException(404, f"reference_id not found: {reference_id}")
        return path, False
    if reference_audio:
        return _to_wav16k(_decode_audio_b64(reference_audio), "ref.wav"), True
    return None, False


def _wav_bytes(wav: np.ndarray, sr: int) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, np.asarray(wav, dtype=np.float32), sr, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def _mp3_bytes(wav: np.ndarray, sr: int) -> bytes:
    with tempfile.NamedTemporaryFile(suffix=".wav", dir=str(ROOT / "tmp"), delete=False) as f:
        sf.write(f.name, np.asarray(wav, dtype=np.float32), sr, format="WAV", subtype="PCM_16")
        path = f.name
    try:
        proc = subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", path,
             "-f", "mp3", "-b:a", "192k", "pipe:1"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        if proc.returncode != 0:
            raise HTTPException(500, "mp3 encoding failed: " + proc.stderr.decode("utf-8", "replace")[-300:])
        return proc.stdout
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def _pcm16(chunk: np.ndarray) -> bytes:
    arr = np.asarray(chunk, dtype=np.float32)
    if arr.ndim > 1:
        arr = arr.reshape(-1)
    return (np.clip(arr, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()


def _render_text(text: str, control: Optional[str]) -> str:
    control = (control or "").strip()
    if not control:
        return text
    # If the caller already embedded an instruction in parentheses, keep it.
    if re.match(r"^\([^)]*\)", text):
        return text
    return f"({control}){text}"


def _generate_kwargs(mode: str, text: str, ref_path: Optional[Path], prompt_text: Optional[str],
                     control: Optional[str], cfg_value: float, inference_timesteps: int,
                     normalize: bool, denoise: bool, max_len: int, seed: Optional[int]) -> dict:
    if mode == "hifi" and not prompt_text:
        raise HTTPException(400, "mode=hifi requires prompt_text (the exact transcript of the reference audio)")
    if mode in ("clone", "hifi") and not ref_path:
        raise HTTPException(400, f"mode={mode} requires reference_audio or reference_id")
    if denoise and not _denoiser_loaded:
        raise HTTPException(400, "denoise is not enabled on this server (start with VOXCPM_DENOISER=1)")

    kwargs: dict = {
        "text": _render_text(text, control) if mode != "hifi" else text,
        "cfg_value": float(cfg_value),
        "inference_timesteps": int(inference_timesteps),
        "normalize": bool(normalize),
        "denoise": bool(denoise),
        "retry_badcase": True,
        "max_len": int(max_len),
    }
    if seed is not None:
        kwargs["seed"] = int(seed)
    if mode in ("clone", "hifi"):
        kwargs["reference_wav_path"] = str(ref_path)
    if mode == "hifi":
        kwargs["prompt_wav_path"] = str(ref_path)
        kwargs["prompt_text"] = prompt_text
        # VoxCPM2 ignores the style instruction in combined hifi mode; keep text plain.
    return kwargs


def _generate_once(kwargs: dict) -> np.ndarray:
    model = get_model()
    with _gen_lock:
        return model.generate(**kwargs)


# --------------------------------------------------------------------------- #
# Schemas
# --------------------------------------------------------------------------- #
class TTSRequest(BaseModel):
    text: str = Field(..., description="要合成的文本，最多 2000 字符")
    mode: Literal["tts", "design", "clone", "hifi"] = Field("tts", description="tts=文本转语音, design=声音设计, clone=可控克隆, hifi=极致克隆")
    control: Optional[str] = Field(None, description="声音/风格描述，如：年轻女性，温柔甜美，语速稍快")
    reference_audio: Optional[str] = Field(None, description="参考音频 base64 或 data URI（clone/hifi 必填）")
    reference_id: Optional[str] = Field(None, description="先用 /v1/references 上传得到的 ID，优先级高于 reference_audio")
    prompt_text: Optional[str] = Field(None, description="参考音频的逐字文本，mode=hifi 必填")
    cfg_value: float = Field(2.0, ge=1.0, le=3.0)
    inference_timesteps: int = Field(10, ge=4, le=30)
    normalize: bool = False
    denoise: bool = False
    max_len: int = Field(4096, ge=100, le=8192)
    seed: Optional[int] = None
    response_format: Literal["wav", "mp3", "json"] = "wav"
    stream: bool = False
    stream_format: Literal["pcm", "sse"] = Field("pcm", description="stream=true 时的输出格式")


class SpeechRequest(BaseModel):
    """Small OpenAI-compatible shim."""
    model: str = "voxcpm2"
    input: str
    voice: Optional[str] = Field(None, description="作为声音/风格描述使用，可留空")
    response_format: Literal["wav", "mp3"] = "wav"
    stream: bool = False
    reference_audio: Optional[str] = None
    reference_id: Optional[str] = None


# --------------------------------------------------------------------------- #
# Health / metadata
# --------------------------------------------------------------------------- #
@app.get("/", include_in_schema=False)
def root():
    return {
        "service": "VoxCPM2 TTS API",
        "docs": "/docs",
        "api_md": "/api.md",
        "health": "/health",
    }


@app.get("/health", summary="服务健康状态")
def health():
    gpu = []
    try:
        out = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=index,name,memory.total,memory.used,memory.free,utilization.gpu",
             "--format=csv,noheader,nounits"],
            text=True, timeout=2,
        )
        for line in out.strip().splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) >= 6:
                gpu.append({
                    "index": int(parts[0]), "name": parts[1],
                    "memory_total_mb": int(float(parts[2])),
                    "memory_used_mb": int(float(parts[3])),
                    "memory_free_mb": int(float(parts[4])),
                    "utilization_pct": int(float(parts[5])),
                })
    except Exception:
        pass
    return {
        "status": "ok" if _state["status"] == "ready" else _state["status"],
        "model": "VoxCPM2",
        "model_dir": str(MODEL_DIR),
        "device": DEVICE,
        "sample_rate": sample_rate(),
        "optimize": OPTIMIZE,
        "denoiser": _denoiser_loaded,
        "loaded_at": _state["loaded_at"],
        "load_seconds": _state["load_seconds"],
        "error": _state["error"],
        "busy": _gen_lock.locked(),
        "gpu": gpu,
        "api_key_required": bool(API_KEY),
    }


@app.get("/v1/models", summary="模型列表（OpenAI 风格）")
def models():
    return {
        "object": "list",
        "data": [{
            "id": "voxcpm2",
            "object": "model",
            "created": int(_state["loaded_at"] or 0),
            "owned_by": "OpenBMB",
            "metadata": {"sample_rate": sample_rate(), "modes": ["tts", "design", "clone", "hifi"]},
        }],
    }


@app.get("/api.md", include_in_schema=False)
def api_md():
    p = ROOT / "API.md"
    if not p.exists():
        raise HTTPException(404, "API.md not found")
    return FileResponse(p, media_type="text/markdown; charset=utf-8")


# --------------------------------------------------------------------------- #
# Reference audio registry
# --------------------------------------------------------------------------- #
@app.post("/v1/references", summary="上传参考音频，返回可复用的 reference_id")
def upload_reference(file: UploadFile = File(...), _: None = Depends(require_key)):
    raw = file.file.read(MAX_AUDIO_MB * 1024 * 1024 + 1)
    if len(raw) > MAX_AUDIO_MB * 1024 * 1024:
        raise HTTPException(413, f"file too large (limit {MAX_AUDIO_MB} MB)")
    wav_path = _to_wav16k(raw, file.filename or "upload")
    ref_id = "ref_" + secrets.token_hex(8)
    final = REFS_DIR / f"{ref_id}.wav"
    wav_path.replace(final)
    info = sf.info(str(final))
    items = _load_index()
    items.insert(0, {
        "id": ref_id,
        "filename": file.filename or "upload",
        "duration": round(info.duration, 2),
        "created_at": int(time.time()),
    })
    _save_index(items[:200])
    return {"id": ref_id, "duration": round(info.duration, 2), "sample_rate": info.samplerate}


@app.get("/v1/references", summary="参考音频列表")
def list_references(_: None = Depends(require_key)):
    items = _load_index()
    out = []
    for it in items:
        p = REFS_DIR / f"{it['id']}.wav"
        if p.exists():
            out.append(it)
    return {"object": "list", "data": out}


@app.delete("/v1/references/{ref_id}", summary="删除参考音频")
def delete_reference(ref_id: str, _: None = Depends(require_key)):
    p = REFS_DIR / f"{ref_id}.wav"
    if not p.exists():
        raise HTTPException(404, "reference not found")
    p.unlink(missing_ok=True)
    items = [it for it in _load_index() if it["id"] != ref_id]
    _save_index(items)
    return {"deleted": ref_id}


# --------------------------------------------------------------------------- #
# JSON generation
# --------------------------------------------------------------------------- #
@app.post("/v1/tts", summary="文本转语音 / 声音设计 / 可控克隆 / 极致克隆")
def tts(req: TTSRequest, _: None = Depends(require_key)):
    text = _check_text(req.text)
    ref_path, is_temp = _resolve_reference(req.reference_audio, req.reference_id)
    try:
        kwargs = _generate_kwargs(
            req.mode, text, ref_path, req.prompt_text, req.control,
            req.cfg_value, req.inference_timesteps, req.normalize, req.denoise,
            req.max_len, req.seed,
        )
        if req.stream:
            return _streaming_response(kwargs, req.stream_format)
        wav = _generate_once(kwargs)
        sr = sample_rate()
        if req.response_format == "json":
            audio_bytes = _wav_bytes(wav, sr)
            return {
                "mode": req.mode,
                "sample_rate": sr,
                "duration": round(len(wav) / sr, 3),
                "format": "wav",
                "audio_base64": base64.b64encode(audio_bytes).decode("ascii"),
                "request_id": uuid.uuid4().hex,
            }
        body = _mp3_bytes(wav, sr) if req.response_format == "mp3" else _wav_bytes(wav, sr)
        media = "audio/mpeg" if req.response_format == "mp3" else "audio/wav"
        return Response(
            content=body,
            media_type=media,
            headers={
                "X-Sample-Rate": str(sr),
                "X-Duration": f"{len(wav) / sr:.3f}",
                "X-Mode": req.mode,
                "X-Request-Id": uuid.uuid4().hex,
                "Content-Disposition": f'inline; filename="voxcpm2.{req.response_format}"',
            },
        )
    finally:
        if is_temp and ref_path:
            ref_path.unlink(missing_ok=True)


@app.post("/v1/audio/speech", summary="OpenAI 兼容 shim")
def speech(req: SpeechRequest, _: None = Depends(require_key)):
    text = _check_text(req.input)
    ref_path, is_temp = _resolve_reference(req.reference_audio, req.reference_id)
    try:
        mode = "clone" if ref_path else "design"
        kwargs = _generate_kwargs(
            mode, text, ref_path, None, req.voice,
            2.0, 10, False, False, 4096, None,
        )
        if req.stream:
            return _streaming_response(kwargs, "pcm")
        wav = _generate_once(kwargs)
        sr = sample_rate()
        body = _mp3_bytes(wav, sr) if req.response_format == "mp3" else _wav_bytes(wav, sr)
        return Response(
            content=body,
            media_type="audio/mpeg" if req.response_format == "mp3" else "audio/wav",
            headers={"X-Sample-Rate": str(sr), "X-Duration": f"{len(wav) / sr:.3f}"},
        )
    finally:
        if is_temp and ref_path:
            ref_path.unlink(missing_ok=True)


# --------------------------------------------------------------------------- #
# Multipart generation (handy for desktop / curl -F)
# --------------------------------------------------------------------------- #
@app.post("/v1/audio/design", summary="声音设计（multipart，可选 control）")
def design_audio(
    text: str = Form(...),
    control: Optional[str] = Form(None),
    cfg_value: float = Form(2.0),
    inference_timesteps: int = Form(10),
    normalize: bool = Form(False),
    response_format: str = Form("wav"),
    _: None = Depends(require_key),
):
    return tts(TTSRequest(text=text, mode="design", control=control,
                          cfg_value=cfg_value, inference_timesteps=inference_timesteps,
                          normalize=normalize, response_format=response_format), _)


@app.post("/v1/audio/clone", summary="可控声音克隆（multipart）")
def clone_audio(
    text: str = Form(...),
    file: UploadFile = File(...),
    control: Optional[str] = Form(None),
    cfg_value: float = Form(2.0),
    inference_timesteps: int = Form(10),
    normalize: bool = Form(False),
    denoise: bool = Form(False),
    response_format: str = Form("wav"),
    _: None = Depends(require_key),
):
    raw = file.file.read(MAX_AUDIO_MB * 1024 * 1024 + 1)
    ref_path = _to_wav16k(raw, file.filename or "upload")
    try:
        kwargs = _generate_kwargs("clone", _check_text(text), ref_path, None, control,
                                  cfg_value, inference_timesteps, normalize, denoise, 4096, None)
        wav = _generate_once(kwargs)
        sr = sample_rate()
        body = _mp3_bytes(wav, sr) if response_format == "mp3" else _wav_bytes(wav, sr)
        return Response(content=body,
                        media_type="audio/mpeg" if response_format == "mp3" else "audio/wav",
                        headers={"X-Sample-Rate": str(sr), "X-Duration": f"{len(wav)/sr:.3f}", "X-Mode": "clone"})
    finally:
        ref_path.unlink(missing_ok=True)


@app.post("/v1/audio/clone/hifi", summary="极致克隆（multipart，需要参考音频逐字文本）")
def hifi_audio(
    text: str = Form(...),
    file: UploadFile = File(...),
    prompt_text: str = Form(...),
    cfg_value: float = Form(2.0),
    inference_timesteps: int = Form(10),
    normalize: bool = Form(False),
    denoise: bool = Form(False),
    response_format: str = Form("wav"),
    _: None = Depends(require_key),
):
    raw = file.file.read(MAX_AUDIO_MB * 1024 * 1024 + 1)
    ref_path = _to_wav16k(raw, file.filename or "upload")
    try:
        kwargs = _generate_kwargs("hifi", _check_text(text), ref_path, prompt_text, None,
                                  cfg_value, inference_timesteps, normalize, denoise, 4096, None)
        wav = _generate_once(kwargs)
        sr = sample_rate()
        body = _mp3_bytes(wav, sr) if response_format == "mp3" else _wav_bytes(wav, sr)
        return Response(content=body,
                        media_type="audio/mpeg" if response_format == "mp3" else "audio/wav",
                        headers={"X-Sample-Rate": str(sr), "X-Duration": f"{len(wav)/sr:.3f}", "X-Mode": "hifi"})
    finally:
        ref_path.unlink(missing_ok=True)


# --------------------------------------------------------------------------- #
# Streaming
# --------------------------------------------------------------------------- #
def _streaming_response(kwargs: dict, fmt: str) -> StreamingResponse:
    def pcm_iter():
        model = get_model()
        with _gen_lock:
            for chunk in model.generate_streaming(**kwargs):
                yield _pcm16(chunk)

    def sse_iter():
        model = get_model()
        sr = sample_rate()
        yield "event: start\ndata: " + json.dumps({"sample_rate": sr, "format": "pcm_s16le"}) + "\n\n"
        with _gen_lock:
            for chunk in model.generate_streaming(**kwargs):
                yield "event: audio\ndata: " + json.dumps({"audio": base64.b64encode(_pcm16(chunk)).decode("ascii")}) + "\n\n"
        yield "event: done\ndata: {}\n\n"

    headers = {
        "X-Sample-Rate": str(sample_rate()),
        "X-Channels": "1",
        "X-Encoding": "pcm_s16le" if fmt == "pcm" else "base64-sse",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
    }
    if fmt == "sse":
        return StreamingResponse(sse_iter(), media_type="text/event-stream", headers=headers)
    return StreamingResponse(pcm_iter(), media_type="application/octet-stream", headers=headers)


@app.post("/v1/tts/stream", summary="流式生成（PCM 或 SSE）")
def tts_stream(req: TTSRequest, _: None = Depends(require_key)):
    if not req.stream:
        req.stream = True
    return tts(req, _)


# --------------------------------------------------------------------------- #
# Entrypoint
# --------------------------------------------------------------------------- #
if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app:app",
        host=os.getenv("VOXCPM_HOST", "0.0.0.0"),
        port=int(os.getenv("VOXCPM_PORT", "8000")),
        workers=1,
        log_level="info",
    )
