(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  const film = document.querySelector('[data-find-media="film"]');
  if (film && !film.classList.contains("is-on")) film.click();
  await sleep(300);
  document.querySelector("#find-text").value = "night city street";
  document.querySelector("#find-run").click();
  for (let i = 0; i < 90; i++) {
    await sleep(500);
    const t = document.querySelector("#find-remote")?.textContent.replace(/\s+/g, " ") || "";
    if (t && !/正在检索/.test(t)) break;
  }
  const before = document.querySelectorAll(".find-hit-film").length;
  out.before = before;
  out.summaryBefore = (document.querySelector(".find-remote-summary")?.textContent || "").replace(/\s+/g, " ").slice(-160);
  const card = document.querySelector(".find-hit-film");
  if (!card) return Object.assign(out, { error: "no card" });
  out.recall = (card.querySelector(".find-remote-recall")?.textContent || "").replace(/\s+/g, " ").slice(0, 160);
  card.querySelector('[data-film-action="exclude"]').click();
  await sleep(900);
  out.after = document.querySelectorAll(".find-hit-film").length;
  out.summaryAfter = (document.querySelector(".find-remote-summary")?.textContent || "").replace(/\s+/g, " ").slice(-200);
  out.sectionTextTail = (document.querySelector("#find-remote")?.textContent || "").replace(/\s+/g, " ").slice(-220);
  // 排除后动作是否还能用（重渲染后必须重新绑定）
  const anyCard = document.querySelector(".find-hit-film");
  out.stillHasCards = Boolean(anyCard);
  out.boundFlag = document.querySelector("#find-remote")?.dataset.filmBound;
  return out;
})()