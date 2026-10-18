(async () => {
  const out = {};
  const errs = [];
  window.addEventListener("error", (e) => errs.push("error: " + String(e.message).slice(0, 200)));
  window.addEventListener("unhandledrejection", (e) => errs.push("rejection: " + String(e.reason && (e.reason.stack || e.reason.message || e.reason)).slice(0, 300)));
  const origErr = console.error;
  console.error = (...a) => { errs.push("console.error: " + a.map(String).join(" ").slice(0, 200)); origErr(...a); };

  // 0) 缓存到底在哪个存储里？
  out.localKeys = Object.keys(localStorage).filter(k => k.startsWith("va-"));
  out.sessionKeys = Object.keys(sessionStorage).filter(k => k.startsWith("va-"));
  localStorage.clear();
  sessionStorage.clear();

  // 1) media=all 的整条远程链路耗时
  const t0 = Date.now();
  try {
    const { findRemoteReferences } = await import("/src/services/retrieval/remoteReferences.js");
    const all = await findRemoteReferences("Intolerance", { media: "all" });
    out.allMs = Date.now() - t0;
    out.allCount = all.results?.length;
    out.allDegraded = all.degraded;
    out.allNote = (all.note || "").slice(0, 160);
  } catch (e) {
    out.allError = String(e && (e.stack || e.message)).slice(0, 300);
    out.allMs = Date.now() - t0;
  }

  // 2) 走 UI 真实序列，然后看区段内容与错误
  const t1 = Date.now();
  document.querySelector("#find-text").value = "Intolerance";
  document.querySelector("#find-run").click();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const txt = (document.querySelector("#find-remote")?.textContent || "").replace(/\s+/g, " ");
    if (txt && !/正在检索/.test(txt)) { out.uiSettledAtMs = Date.now() - t1; break; }
  }
  out.uiWaitedMs = Date.now() - t1;
  out.remoteText = (document.querySelector("#find-remote")?.textContent || "").replace(/\s+/g, " ").slice(0, 300);
  out.cards = document.querySelectorAll(".find-hit-film").length;
  out.errors = errs.slice(0, 6);
  return out;
})()