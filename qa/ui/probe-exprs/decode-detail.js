(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { cards: [] };
  const film = document.querySelector('[data-find-media="film"]');
  if (film && !film.classList.contains("is-on")) film.click();
  await sleep(300);
  document.querySelector("#find-text").value = "night city street";
  document.querySelector("#find-run").click();
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    const t = document.querySelector("#find-remote")?.textContent.replace(/\s+/g, " ") || "";
    if (t && !/正在检索/.test(t)) break;
  }
  await sleep(1500);
  // 轮询等图片加载完（有上限）：一次量「刚出现时」的解码率会把慢加载误报成解码失败。
  for (let i = 0; i < 40; i++) {
    const imgs = [...document.querySelectorAll(".find-hit-film img")];
    if (imgs.length && imgs.every((im) => im.complete)) break;
    await sleep(500);
  }
  out.waitedMs = 1500 + 500 * 40;
  for (const card of document.querySelectorAll(".find-hit-film")) {
    const img = card.querySelector("img");
    const src = img ? img.currentSrc || img.src : "";
    let http = "n/a";
    try {
      const r = await fetch(src, { method: "GET", mode: "no-cors" });
      http = `status=${r.status} type=${r.type} ok=${r.ok}`;
    } catch (e) {
      http = "fetch-error " + String(e.message || e).slice(0, 40);
    }
    out.cards.push({
      title: (card.dataset.filmSource || "").slice(-70),
      src: src.replace(/^https:\/\/upload\.wikimedia\.org/, "…up"),
      naturalWidth: img ? img.naturalWidth : -1,
      complete: img ? img.complete : false,
      slotBroken: Boolean(card.querySelector(".img-slot.is-broken")),
      http,
    });
  }
  return out;
})()