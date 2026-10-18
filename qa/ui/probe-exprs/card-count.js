(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  const film = document.querySelector('[data-find-media="film"]');
  if (film && !film.classList.contains("is-on")) film.click();
  await sleep(300);
  document.querySelector("#find-text").value = "Intolerance";
  document.querySelector("#find-run").click();
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    const t = document.querySelector("#find-remote")?.textContent.replace(/\s+/g, " ") || "";
    if (t && !/正在检索/.test(t)) break;
  }
  out.cards = document.querySelectorAll(".find-hit-film").length;
  out.allHits = document.querySelectorAll(".find-hit").length;
  out.cardTitles = [...document.querySelectorAll(".find-hit-film")].map((c) => c.textContent.replace(/\s+/g, " ").slice(0, 70));
  out.summary = (document.querySelector(".find-remote-summary")?.textContent || "").replace(/\s+/g, " ").slice(0, 400);
  return out;
})()