"""音频转文字后端：FastAPI + SpeechRecognition。

调用链：
    home 页选好 MP3 → translate 页用浏览器把音频解码成 16kHz 单声道 WAV
    → POST 到这里的 /api/asr → 交给 speech_recognition 识别中文
    → 返回 {"text": "..."}；识别不出来就返回 "无法识别"。

启动（在 backend 目录下，用项目自带的 .venv）：
    .venv\\Scripts\\python.exe -m uvicorn main:app --reload --port 8000
"""

from __future__ import annotations

import json
import os
import re
import tempfile

import speech_recognition as sr
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

# 认准采样率：网页端已经把音频重采样到 16000Hz 单声道，这里保持一致。
SAMPLE_RATE = 16000

# 上传体积上限（网页端限 10MB，这里留点余量防止有人绕过前端直接传）。
MAX_BYTES = 20 * 1024 * 1024

app = FastAPI(title="音频转文字")

# 前端跑在 localhost:3000，后端跑在 127.0.0.1:8000，属于跨源请求，
# 不放开 CORS 浏览器会直接把请求拦掉。本地开发放开全部来源即可。
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class _SkipEngine(Exception):
    """本机没装这个引擎（缺包或缺模型），直接跳过，不算识别失败。"""


_VOSK_MODEL = None  # vosk 模型加载一次就够，加载挺慢的，别每次请求都来一遍


# ============================================================
# 引擎一：vosk（离线，不需要联网）
# ============================================================
def _find_vosk_model() -> str | None:
    """找中文模型目录。可以用环境变量 VOSK_MODEL_PATH 指定，
    否则自动在 backend/models/ 里找第一个像样的模型目录。"""
    path = os.environ.get("VOSK_MODEL_PATH")
    if path and os.path.isdir(path):
        return path

    root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")
    if not os.path.isdir(root):
        return None
    for name in sorted(os.listdir(root)):
        candidate = os.path.join(root, name)
        if os.path.isdir(candidate) and os.path.exists(
            os.path.join(candidate, "am", "final.mdl")
        ):
            return candidate
    return None


def _asr_vosk(audio: sr.AudioData) -> str:
    try:
        import vosk
    except ImportError as exc:
        raise _SkipEngine("没装 vosk") from exc

    model_path = _find_vosk_model()
    if model_path is None:
        raise _SkipEngine("没找到 vosk 中文模型")

    global _VOSK_MODEL
    if _VOSK_MODEL is None:
        vosk.SetLogLevel(-1)  # 关掉 vosk 刷屏的日志
        _VOSK_MODEL = vosk.Model(model_path)

    raw = audio.get_raw_data(convert_rate=SAMPLE_RATE, convert_width=2)
    recognizer = vosk.KaldiRecognizer(_VOSK_MODEL, SAMPLE_RATE)
    # 分块喂进去（vosk 官方示例就是 4000 字节一块），最后取 FinalResult。
    for start in range(0, len(raw), 4000):
        recognizer.AcceptWaveform(raw[start : start + 4000])
    return json.loads(recognizer.FinalResult()).get("text", "")


# ============================================================
# 引擎二：Google 免费接口（speech_recognition 自带，需要能访问 google.com）
# ============================================================
def _asr_google(audio: sr.AudioData) -> str:
    recognizer = sr.Recognizer()
    recognizer.operation_timeout = 15  # 不设的话网络不通时会一直挂着
    return recognizer.recognize_google(audio, language="zh-CN")


def _engines() -> list[tuple[str, object]]:
    """按顺序尝试的引擎。想固定用某一个，设环境变量 ASR_ENGINE=vosk 或 google。"""
    all_engines = [("vosk", _asr_vosk), ("google", _asr_google)]
    forced = os.environ.get("ASR_ENGINE", "").strip().lower()
    if forced:
        all_engines = [item for item in all_engines if item[0] == forced]
    return all_engines


# 汉字范围（含扩展 A 区），用来判断两个字符是不是“都是中文”
_CJK = r"\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff"


def _tidy_chinese(text: str) -> str:
    """vosk 是按词输出的，词之间带空格：「你好 这 是 一段 录音」，中文看着别扭。
    这里把「汉字 汉字」之间的空格删掉，英文单词之间的空格原样保留。"""
    return re.sub(rf"(?<=[{_CJK}]) +(?=[{_CJK}])", "", text)


def recognize_chinese(audio: sr.AudioData) -> tuple[str, str | None, str | None]:
    """识别中文。返回 (文字, 用到的引擎, 失败原因)。

    全都识别不出来时，文字固定是“无法识别”。
    """
    errors: list[str] = []
    for name, func in _engines():
        try:
            text = func(audio)
        except _SkipEngine:
            continue  # 本机没这个引擎，换下一个
        except Exception as exc:  # 网络不通、识别不出内容……继续试下一个
            errors.append(f"{name}: {type(exc).__name__}: {exc}")
            continue

        text = _tidy_chinese((text or "").strip())
        if text:
            return text, name, None
        errors.append(f"{name}: 没听出内容")

    reason = "; ".join(errors) if errors else "没有可用的识别引擎"
    return "无法识别", None, reason


# ============================================================
# 接口
# ============================================================
@app.get("/")
def health() -> dict:
    """访问一下确认服务活着，顺带看看识别引擎准备好了没。
    vosk_model 是 null，说明没装 vosk 或没放模型，识别时会跳过它。"""
    return {
        "status": "ok",
        "engines": [name for name, _ in _engines()],
        "vosk_model": _find_vosk_model(),
    }


@app.post("/api/asr")
async def asr(file: UploadFile = File(...)) -> dict:
    """接收音频文件，返回中文识别结果。"""
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="没有收到音频内容")
    if len(data) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="音频太大了")

    # speech_recognition 只吃 WAV / AIFF / FLAC 这几种带 PCM 的容器（MP3 得网页端先解码），
    # 它需要的是磁盘上的文件，所以先落到临时文件再读。
    suffix = os.path.splitext(file.filename or "")[1] or ".wav"
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp.write(data)
            tmp_path = tmp.name

        try:
            with sr.AudioFile(tmp_path) as source:
                audio = sr.Recognizer().record(source)
        except Exception as exc:
            # 文件本身读不出来（格式不支持 / 损坏），也算识别失败
            return {
                "text": "无法识别",
                "engine": None,
                "reason": f"音频读不出来: {type(exc).__name__}: {exc}",
            }

        text, engine, reason = recognize_chinese(audio)
        return {"text": text, "engine": engine, "reason": reason}
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)
