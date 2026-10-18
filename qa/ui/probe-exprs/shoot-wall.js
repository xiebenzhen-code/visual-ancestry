(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 电影画面墙在页面深处：渐进滚动把 lazy 图片真的下载/解码出来再判定。
  for (let y = 0; y <= document.body.scrollHeight; y += Math.round(window.innerHeight * 0.8)) {
    window.scrollTo(0, y);
    await sleep(140);
  }
  window.scrollTo(0, 0);
  await sleep(1200);
  const cards = [...document.querySelectorAll(".film-ref-card")];
  const rows = cards.map((c) => {
    const img = c.querySelector("img");
    const slot = c.querySelector(".img-slot");
    return {
      title: (c.querySelector("em")?.textContent || "").trim(),
      state: img ? (img.complete && img.naturalWidth > 0 ? "ok" : "pending") : "no-img",
      natural: img ? img.naturalWidth + "x" + img.naturalHeight : "",
      broken: Boolean(slot && slot.classList.contains("is-broken")),
    };
  });
  return {
    blocks: document.querySelectorAll(".shoot-film-refs").length,
    cards: cards.length,
    decoded: rows.filter((r) => r.state === "ok").length,
    broken: rows.filter((r) => r.broken).length,
    visibleUnavailable: [...document.querySelectorAll(".shoot-film-refs .img-unavailable")].filter(
      (s) => s.getClientRects().length
    ).length,
    list: rows,
    pageHeight: document.body.scrollHeight,
  };
})()
