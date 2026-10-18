(async () => {
  const urls = [
    "https://images.metmuseum.org/CRDImages/dp/web-large/DP811071.jpg",
    "https://images.metmuseum.org/CRDImages/ad/web-large/ap29.35.jpg",
    "https://openaccess-cdn.clevelandart.org/1972.47/1972.47_web.jpg",
    "https://openaccess-cdn.clevelandart.org/1967.19/1967.19_web.jpg",
  ];
  const out = [];
  for (const u of urls) {
    const t0 = performance.now();
    const r = await new Promise((resolve) => {
      const img = new Image();
      let done = false;
      const fin = (v) => { if (!done) { done = true; resolve(v); } };
      img.onload = () => fin({ ok: true, w: img.naturalWidth });
      img.onerror = () => fin({ ok: false });
      img.src = u;
      setTimeout(() => fin({ ok: false, timeout: true }), 30000);
    });
    out.push({ url: u.split("/").pop(), ...r, ms: Math.round(performance.now() - t0) });
  }
  return out;
})()