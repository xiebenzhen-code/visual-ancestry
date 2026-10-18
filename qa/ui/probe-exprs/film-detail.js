(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(600);
  const page = document.querySelector(".film-still-page");
  const img = page?.querySelector("img");
  const dts = [...(page?.querySelectorAll("dt") || [])].map((d) => d.textContent.trim());
  const dds = [...(page?.querySelectorAll("dd") || [])].map((d) => d.textContent.trim().slice(0, 120));
  return {
    hasPage: Boolean(page),
    title: page?.querySelector("h1")?.textContent.trim() || "",
    imgState: img ? (img.complete && img.naturalWidth > 0 ? "ok " + img.naturalWidth + "x" + img.naturalHeight : "pending") : "no-img",
    rows: dts.map((k, i) => k + " = " + (dds[i] || "")),
    sourceLink: page?.querySelector("dd a")?.href || "",
  };
})()
