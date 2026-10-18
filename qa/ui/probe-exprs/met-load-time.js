(async () => {
  const urls = [
    "https://images.metmuseum.org/CRDImages/dp/original/DP811071.jpg",
    "https://images.metmuseum.org/CRDImages/ad/original/ap29.35.jpg",
    "https://openaccess-cdn.clevelandart.org/1972.47/1972.47_print.jpg",
    "https://openaccess-cdn.clevelandart.org/1967.19/1967.19_print.jpg",
  ];
  // 串行加载，各自计时：并发会把 Wikimedia/Met 的限流混进来，看不清单个耗时。
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
      setTimeout(() => fin({ ok: false, timeout: true }), 60000);
    });
    out.push({ url: u.split("/").pop(), ...r, ms: Math.round(performance.now() - t0) });
  }
  return out;
})()