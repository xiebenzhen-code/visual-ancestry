(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  out.hasRemoteHost = !!document.querySelector("#find-remote");
  out.hasText = !!document.querySelector("#find-text");
  out.hasRun = !!document.querySelector("#find-run");
  out.mediaButtons = [...document.querySelectorAll("[data-find-media]")].map((b) => b.dataset.findMedia + (b.classList.contains("is-on") ? "(on)" : ""));
  out.modeButtons = [...document.querySelectorAll("[data-find-mode]")].map((b) => b.dataset.findMode + (b.classList.contains("is-on") ? "(on)" : ""));
  // 只跑文字检索，不动媒介筛选
  const t = document.querySelector("#find-text");
  t.value = "Intolerance";
  document.querySelector("#find-run").click();
  await sleep(9000);
  out.remoteHtml = (document.querySelector("#find-remote")?.innerHTML || "(empty)").slice(0, 600);
  out.remoteText = (document.querySelector("#find-remote")?.textContent || "").replace(/\s+/g, " ").slice(0, 300);
  out.localHits = document.querySelectorAll("#find-results .find-hit").length;
  // 现在再切到仅电影画面，看有没有区别
  const filmBtn = document.querySelector('[data-find-media="film"]');
  out.filmBtnExists = Boolean(filmBtn);
  if (filmBtn) {
    filmBtn.click();
    await sleep(9000);
    out.afterFilmHtml = (document.querySelector("#find-remote")?.innerHTML || "(empty)").slice(0, 400);
    out.afterFilmText = (document.querySelector("#find-remote")?.textContent || "").replace(/\s+/g, " ").slice(0, 260);
  }
  return out;
})()