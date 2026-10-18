// download.js — 把一段文本存成文件（与 MEMORY 的档案导出同一套做法：
// Blob + <a download>，不经过任何服务端）。
export function downloadText(filename, text, mime = "text/plain;charset=utf-8") {
  try {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // 立刻 revoke 会在部分浏览器里打断下载，交给下一轮事件循环回收。
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return true;
  } catch {
    return false;
  }
}
