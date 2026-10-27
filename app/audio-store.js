// 跨页面暂存的音频文件。
//
// home 页选中文件 → 存到这里 → 跳到 translate 页 → 从「读」出来做识别。
//
// 为什么不塞进 sessionStorage / URL？
//   File 对象没法直接序列化，转成 base64 又要多占 1/3 体积，10MB 的文件直接超配额。
// 为什么模块级变量就够？
//   用 <Link> 在 /home 和 /translate 之间跳转属于「客户端导航」，
//   页面没刷新，JS 模块一直是同一份，变量自然还在。
// 注意：刷新页面（F5）或直接打开 /translate 会丢掉它 —— 那就得回 home 重新选一次。
// 这个文件只给客户端组件（带 "use client" 的）用。

let pickedAudio = null;

export function setPickedAudio(file) {
  pickedAudio = file;
}

export function getPickedAudio() {
  return pickedAudio;
}

export function clearPickedAudio() {
  pickedAudio = null;
}
