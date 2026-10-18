(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 60; i++) {
    const im = [...document.querySelectorAll(".album-wall img")];
    if (im.length && im.every((x) => x.complete)) break;
    await sleep(500);
  }
  const plates = [...document.querySelectorAll(".plate")];
  const bad = [];
  plates.forEach((plate, i) => {
    const img = plate.querySelector("img");
    const slot = plate.querySelector(".img-slot");
    if (!img) {
      bad.push({ i, title: plate.getAttribute("aria-label"), why: "no img element" });
      return;
    }
    if (img.naturalWidth === 0) {
      bad.push({
        i,
        title: plate.getAttribute("aria-label"),
        why: "naturalWidth=0",
        src: (img.currentSrc || img.src || "").slice(-58),
        slotBroken: Boolean(slot?.classList.contains("is-broken")),
        slotLoading: Boolean(slot?.classList.contains("is-loading")),
        placeholderVisible: (() => {
          const u = plate.querySelector(".img-unavailable");
          return u ? u.getClientRects().length > 0 : false;
        })(),
      });
    }
  });
  return {
    plates: plates.length,
    badCount: bad.length,
    bad,
  };
})()