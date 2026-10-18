(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 等图片落地（视口内）
  for (let i = 0; i < 60; i++) {
    const vh = window.innerHeight;
    const imgs = [...document.querySelectorAll(".album-wall img")].filter((x) => {
      if (x.offsetParent === null) return false;
      const r = x.getBoundingClientRect();
      return r.bottom > 0 && r.top < vh;
    });
    if (imgs.length && imgs.every((x) => x.complete)) break;
    await sleep(400);
  }
  window.scrollTo(0, 0);
  await sleep(300);

  const vh = window.innerHeight;
  const plates = [...document.querySelectorAll(".album-wall .plate")];
  const inView = plates.filter((p) => {
    const r = p.getBoundingClientRect();
    return r.top < vh && r.bottom > 0;
  });
  const fully = plates.filter((p) => p.getBoundingClientRect().bottom <= vh);
  const partial = inView.length - fully.length;
  const keys = plates.map((p) => p.getAttribute("aria-label"));
  const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
  const imgs = [...document.querySelectorAll(".album-wall img")].filter((x) => x.offsetParent !== null);
  const slots = [...document.querySelectorAll(".album-wall .img-slot")].filter((x) => x.offsetParent !== null);
  const placeholders = slots.filter((s) => {
    const u = s.querySelector(".img-unavailable");
    return u && u.getClientRects().length > 0;
  }).length;
  const searchBox = document.querySelector(".album-search input");
  const sr = searchBox.getBoundingClientRect();
  const wallTop = document.querySelector(".album-wall").getBoundingClientRect().top;

  return {
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    skin: document.documentElement.dataset.skin,
    columns: getComputedStyle(document.querySelector(".album-wall")).columnCount,
    platesTotal: plates.length,
    firstScreen: inView.length,
    fullyVisible: fully.length,
    partial,
    duplicates: dup.length,
    imagesInViewport: imgs.length,
    imagesDecoded: imgs.filter((x) => x.naturalWidth > 0).length,
    visiblePlaceholders: placeholders,
    searchBoxVisible: sr.top >= 0 && sr.bottom <= vh,
    searchBoxTop: Math.round(sr.top),
    wallTop: Math.round(wallTop),
    imageShareOfFirstScreen: `${Math.round(((vh - wallTop) / vh) * 100)}%`,
  };
})()