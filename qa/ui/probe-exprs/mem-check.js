(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(1500);
  const app = document.querySelector("#app");
  const imgs = [...app.querySelectorAll("img")];
  const text = app.textContent.replace(/\s+/g, " ").trim();
  const links = [...app.querySelectorAll("a[href^='#']")].slice(0, 8).map((a) => a.getAttribute("href"));
  const buttons = [...app.querySelectorAll("button")].slice(0, 8).map((b) => b.textContent.trim()).filter(Boolean);
  return {
    hash: location.hash,
    panelLeaked: Boolean(document.querySelector(".work-panel:not([hidden])")),
    heading: (app.querySelector("h1, h2")?.textContent || "").trim(),
    textHead: text.slice(0, 180),
    images: imgs.length,
    decoded: imgs.filter((i) => i.naturalWidth > 0).length,
    links,
    buttons,
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  };
})()