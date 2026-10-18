(async () => {
  const urls = [
    "/public/assets/artworks/jatte/preview.webp",
    "/public/assets/artworks/jatte/thumb.webp",
    "/public/assets/artworks/hunters-snow/preview.webp",
    "/public/assets/artworks/hunters-snow/thumb.webp",
  ];
  const out = [];
  for (const u of urls) {
    const r = await new Promise((resolve) => {
      const img = new Image();
      const t0 = performance.now();
      let done = false;
      const fin = (v) => { if (!done) { done = true; resolve(v); } };
      img.onload = () => fin({ ok: true, w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = (e) => fin({ ok: false, err: "error-event" });
      img.src = u;
      setTimeout(() => fin({ ok: false, err: "timeout" }), 12000);
    });
    out.push({ url: u, ...r, ms: Math.round(performance.now()) });
  }
  // 同时看墙上这两张的实际 srcset / sizes
  const plates = [...document.querySelectorAll(".plate")];
  const detail = plates
    .map((p) => {
      const img = p.querySelector("img");
      return img
        ? {
            title: p.getAttribute("aria-label"),
            src: (img.currentSrc || "").split("/").slice(-2).join("/"),
            srcset: (img.getAttribute("srcset") || "").slice(0, 60),
            nw: img.naturalWidth,
          }
        : null;
    })
    .filter((x) => x && x.nw === 0);
  return { loads: out, brokenPlates: detail };
})()