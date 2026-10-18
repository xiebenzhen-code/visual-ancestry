(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 50; i++) {
    const imgs = [...document.querySelectorAll(".album-wall img")].filter((x) => x.offsetParent !== null);
    if (imgs.length && imgs.every((x) => x.complete)) break;
    await sleep(500);
  }
  await sleep(1500);

  const slots = [...document.querySelectorAll(".album-wall .img-slot")];
  const broken = [];
  for (const slot of slots) {
    const visiblePlaceholder = slot.querySelector(".img-unavailable");
    const showing = visiblePlaceholder ? visiblePlaceholder.getClientRects().length > 0 : false;
    if (showing) {
      const plate = slot.closest(".plate");
      broken.push({
        title: plate?.getAttribute("aria-label"),
        slotClasses: slot.className,
        hasImg: Boolean(slot.querySelector("img")),
        dataFailures: slot.querySelector("img")?.dataset.failures ?? "(img 已移除)",
        src: (slot.querySelector("img")?.currentSrc || "").slice(-46),
      });
    }
  }

  // 单独请求这两个 URL，看看是不是服务端问题
  const probeUrls = ["/public/assets/artworks/socrates/thumb.webp", "/public/assets/artworks/milkmaid/thumb.webp"];
  const loads = [];
  for (const u of probeUrls) {
    const t0 = performance.now();
    const r = await new Promise((resolve) => {
      const img = new Image();
      let done = false;
      const fin = (v) => { if (!done) { done = true; resolve(v); } };
      img.onload = () => fin({ ok: true, w: img.naturalWidth });
      img.onerror = () => fin({ ok: false });
      img.src = u;
      setTimeout(() => fin({ ok: false, timeout: true }), 15000);
    });
    loads.push({ url: u.split("/").slice(-2).join("/"), ...r, ms: Math.round(performance.now() - t0) });
  }

  return {
    slotsTotal: slots.length,
    visiblePlaceholders: broken.length,
    broken,
    loads,
  };
})()