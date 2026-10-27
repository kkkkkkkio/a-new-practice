"use client";
// ↑ 这个组件要解码音频、发请求、改界面，全是浏览器里的活，必须声明为客户端组件。

import { useCallback, useEffect, useRef, useState } from "react";
import { getPickedAudio } from "../audio-store";

// 后端地址。想换端口就在项目根目录建 .env.local 写：
//   NEXT_PUBLIC_ASR_API=http://127.0.0.1:8000
const API_BASE = process.env.NEXT_PUBLIC_ASR_API || "http://127.0.0.1:8000";

const TARGET_RATE = 16000; // 后端按 16kHz 单声道来识别
const FAIL_TEXT = "无法识别";

/* ------------------------------------------------------------------
   把任意音频（MP3 也行）转成后端认的格式：16kHz 单声道 16bit WAV。

   为什么要转？后端的 SpeechRecognition 只认 WAV / AIFF / FLAC 这种
   带 PCM 数据的容器，MP3 是压缩格式它读不了；本机也没装 ffmpeg 之类
   的解码工具。好在浏览器天生会解码 MP3（Web Audio API），所以让浏览器
   先把音频解开、重采样、重新打包成 WAV，再传给后端。
   ------------------------------------------------------------------ */
async function toWav16k(file) {
  const arrayBuffer = await file.arrayBuffer();

  // 第一步：解码。这一步会把 MP3 解成浮点采样数据。
  // 这里故意用 OfflineAudioContext（不出声的那种）来解码，而不是 AudioContext：
  // AudioContext 在用户没点过页面时会被浏览器挂起、控制台还刷一条
  // “The AudioContext was not allowed to start” 的警告；
  // OfflineAudioContext 不受这条限制，进页面自动识别就不会报。
  const decoder = new OfflineAudioContext(1, 1, TARGET_RATE);
  const decoded = await decoder.decodeAudioData(arrayBuffer);

  // 第二步：重采样成 16kHz 单声道。
  // OfflineAudioContext 不出声、只做运算，用来干这个最合适。
  const frames = Math.max(1, Math.ceil(decoded.duration * TARGET_RATE));
  const offline = new OfflineAudioContext(1, frames, TARGET_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();

  // 第三步：打包成 WAV 文件（44 字节文件头 + PCM 数据）
  return encodeWav(rendered.getChannelData(0), TARGET_RATE);
}

// 手写一个 WAV 头。字段含义按 WAV 规范来，可以直接对照网上的格式表。
function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  const writeText = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };

  writeText(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true); // 后面还有多少字节
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true); // fmt 块长度，PCM 固定 16
  view.setUint16(20, 1, true); // 1 = PCM 不压缩
  view.setUint16(22, 1, true); // 声道数：1 = 单声道
  view.setUint32(24, sampleRate, true); // 采样率
  view.setUint32(28, sampleRate * 2, true); // 每秒字节数 = 采样率 × 声道 × 位深/8
  view.setUint16(32, 2, true); // 块对齐 = 声道 × 位深/8
  view.setUint16(34, 16, true); // 位深：16 bit
  writeText(36, "data");
  view.setUint32(40, samples.length * 2, true); // PCM 数据长度

  // 浮点 [-1, 1] 转成 16bit 整数。超出范围的先压回边界，避免爆音。
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(
      44 + i * 2,
      clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff,
      true
    );
  }

  return new Blob([view], { type: "audio/wav" });
}

export default function Recognizer() {
  const [fileName, setFileName] = useState("");
  const [status, setStatus] = useState("idle"); // idle | working | done
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const startedRef = useRef(false); // 防止开发模式下 useEffect 跑两遍、发两次请求

  // 真正干活：解码 → 上传后端 → 拿结果。
  // 用 useCallback 包起来是为了让下面 useEffect 的依赖稳定，只跑一次。
  const run = useCallback(async (file) => {
    setStatus("working");
    setText("");
    setNote("");

    try {
      const wav = await toWav16k(file);

      const form = new FormData();
      form.append("file", wav, "audio.wav");

      const response = await fetch(`${API_BASE}/api/asr`, {
        method: "POST",
        body: form,
      });
      if (!response.ok) {
        throw new Error(`后端返回 ${response.status}`);
      }

      const data = await response.json();
      setText(data.text || FAIL_TEXT);
      // 后端识别不出来时会顺带说明原因，显示出来方便排查
      // （比如连不上识别服务）。不想要这行，把下面这句删掉即可。
      if (data.reason) setNote(data.reason);
    } catch (error) {
      // 解码失败、后端没启动、网络断了……统一按识别不出来处理
      setText(FAIL_TEXT);
      setNote(`请求失败：${error.message}（后端服务启动了吗？）`);
    } finally {
      setStatus("done");
    }
  }, []);

  // 进页面就自动识别一次：文件是刚从 home 页选好带过来的。
  useEffect(() => {
    const file = getPickedAudio();
    if (!file) return;
    if (startedRef.current) return;
    startedRef.current = true;

    setFileName(file.name);
    run(file);
  }, [run]);

  return (
    <div className="asr-card">
      <p className="asr-card__label">音频</p>
      <p className="asr-card__file">{fileName || "（还没选音频）"}</p>

      <p className="asr-card__label" style={{ marginTop: 18 }}>
        识别结果
      </p>
      <p className="asr-result">
        {status === "working" ? "识别中…" : text || "—"}
      </p>

      {note && <p className="asr-note">{note}</p>}
      {!fileName && (
        <p className="asr-note">
          没有读到音频。回 <a href="/home">home 页</a> 选一个 MP3 再点「转文字」。
        </p>
      )}

      <button
        type="button"
        className="btn-again"
        disabled={status === "working"}
        onClick={() => {
          const file = getPickedAudio();
          if (!file) return;
          setFileName(file.name);
          run(file);
        }}
      >
        重新识别
      </button>
    </div>
  );
}
