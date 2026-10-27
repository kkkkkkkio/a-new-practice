"use client";
// ↑ 这一行是必须的：下面用了 useState / useRef，这类只能在浏览器里跑。
//   Next 默认让所有组件在服务器端渲染，碰到这种要交互的组件就得显式声明"这是客户端组件"。

import { useRef, useState } from "react";
import { setPickedAudio } from "../audio-store";

const MAX_SIZE = 10 * 1024 * 1024; // 10 MB

export default function AudioBar() {
  const inputRef = useRef(null); // 用来拿到那个藏起来的 <input type="file">
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");

  function pickFile(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return; // 用户在弹窗里点了取消

    // 要求：最大 10M，超了就拒绝
    if (file.size > MAX_SIZE) {
      setFileName("");
      setPickedAudio(null); // 别把上一个文件留在暂存里
      setError(
        `「${file.name}」有 ${(file.size / 1024 / 1024).toFixed(1)} MB，超过 10 MB 上限`
      );
      event.target.value = ""; // 清空，这样再选同一个文件也会触发 onChange
      return;
    }

    setError("");
    setFileName(file.name);
    // 文件本身存进暂存区：translate 页要拿它去做识别。
    // 这里只存不读，所以 this 页面不用管识别的事。
    setPickedAudio(file);
  }

  return (
    <>
      <div className="audio-bar">
        {/* 左边：还没选文件时是提示文字，选好后显示文件名 */}
        <span className="audio-bar__name">{fileName || "读取音频（MP3）"}</span>

        {/* 中间：右箭头，纯装饰 */}
        <svg className="audio-bar__arrow" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M4 12h14M12 5l7 7-7 7"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>

        {/* 右边：加号。自己不去选文件，只是替用户"点一下"下面那个 input */}
        <button
          type="button"
          className="audio-bar__plus"
          aria-label="选择本地音频"
          onClick={() => inputRef.current && inputRef.current.click()}
        >
          +
        </button>
      </div>

      {/* 真正干活的文件选择框，用 CSS 藏起来了 */}
      <input
        ref={inputRef}
        type="file"
        accept="audio/mpeg,.mp3"
        className="file-input-hidden"
        onChange={pickFile}
      />

      {error && <p className="audio-bar__error">{error}</p>}
    </>
  );
}
