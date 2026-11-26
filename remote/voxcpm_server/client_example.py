#!/usr/bin/env python3
"""Minimal Python client for the VoxCPM2 FastAPI service.

Environment:
  VOXCPM_BASE_URL  default http://127.0.0.1:8000
  VOXCPM_API_KEY   optional bearer key

Run `python client_example.py` to generate one sample of each mode.
"""
from __future__ import annotations

import base64
import os
import sys
from pathlib import Path

import requests

BASE = os.environ.get("VOXCPM_BASE_URL", "http://127.0.0.1:8000").rstrip("/")
KEY = os.environ.get("VOXCPM_API_KEY", "")


def _headers(content_type: str | None = None) -> dict:
    h = {}
    if KEY:
        h["Authorization"] = "Bearer " + KEY
    if content_type:
        h["Content-Type"] = content_type
    return h


def health() -> dict:
    return requests.get(f"{BASE}/health", timeout=10).json()


def upload_reference(path: str | Path) -> dict:
    with open(path, "rb") as f:
        r = requests.post(
            f"{BASE}/v1/references",
            headers=_headers(),
            files={"file": (Path(path).name, f, "application/octet-stream")},
            timeout=120,
        )
    r.raise_for_status()
    return r.json()


def tts(
    text: str,
    out: str | Path = "out.wav",
    *,
    mode: str = "tts",
    control: str | None = None,
    reference_id: str | None = None,
    reference_audio_path: str | Path | None = None,
    prompt_text: str | None = None,
    cfg_value: float = 2.0,
    inference_timesteps: int = 10,
    normalize: bool = False,
    denoise: bool = False,
    response_format: str = "wav",
) -> Path:
    payload: dict = {
        "text": text,
        "mode": mode,
        "cfg_value": float(cfg_value),
        "inference_timesteps": int(inference_timesteps),
        "normalize": normalize,
        "denoise": denoise,
        "response_format": response_format,
    }
    if control:
        payload["control"] = control
    if reference_id:
        payload["reference_id"] = reference_id
    if reference_audio_path:
        payload["reference_audio"] = base64.b64encode(Path(reference_audio_path).read_bytes()).decode()
    if prompt_text:
        payload["prompt_text"] = prompt_text

    r = requests.post(f"{BASE}/v1/tts", headers=_headers("application/json"), json=payload, timeout=600)
    r.raise_for_status()
    ext = {"wav": "wav", "mp3": "mp3", "json": "json"}.get(response_format, "wav")
    path = Path(out).with_suffix("." + ext) if Path(out).suffix else Path(str(out) + "." + ext)
    if response_format == "json":
        import json
        path.write_text(json.dumps(r.json(), ensure_ascii=False, indent=2), "utf-8")
    else:
        path.write_bytes(r.content)
    return path


def design(text: str, control: str, out: str | Path = "design.wav") -> Path:
    return tts(text, out, mode="design", control=control)


def clone(text: str, audio: str | Path, out: str | Path = "clone.wav", control: str | None = None) -> Path:
    return tts(text, out, mode="clone", control=control, reference_audio_path=audio)


def hifi(text: str, audio: str | Path, prompt_text: str, out: str | Path = "hifi.wav") -> Path:
    return tts(text, out, mode="hifi", reference_audio_path=audio, prompt_text=prompt_text)


def stream(text: str, out: str | Path = "stream.pcm", **kwargs) -> Path:
    payload = {"text": text, "mode": kwargs.pop("mode", "tts"), "stream": True, "stream_format": "pcm"}
    payload.update(kwargs)
    path = Path(out)
    with requests.post(
        f"{BASE}/v1/tts", headers=_headers("application/json"), json=payload,
        stream=True, timeout=600,
    ) as r:
        r.raise_for_status()
        with path.open("wb") as f:
            for chunk in r.iter_content(chunk_size=4096):
                if chunk:
                    f.write(chunk)
    return path


if __name__ == "__main__":
    print("health:", health())
    if len(sys.argv) > 1 and sys.argv[1] == "--demo":
        print(tts("你好，这是 VoxCPM2 的文本转语音测试。", "demo_tts.wav"))
        print(design("欢迎来到天幻纪元。", "年轻女性，温柔，语速稍慢", "demo_design.wav"))
        if Path("ref.wav").exists():
            print(clone("这是克隆音色的测试。", "ref.wav", "demo_clone.wav"))
            print(hifi("这是极致克隆的测试。", "ref.wav", "参考音频的逐字文本", "demo_hifi.wav"))
        print(stream("这是流式输出的测试。", "demo_stream.pcm"))
    else:
        print("用法: python client_example.py --demo")
