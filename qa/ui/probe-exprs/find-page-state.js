(() => {
  const body = document.body;
  const ids = ["find-text", "find-run", "find-results", "find-remote", "find-name-hits"];
  const present = {};
  for (const id of ids) present[id] = Boolean(document.querySelector("#" + id));
  return {
    title: document.title,
    modeButtons: [...document.querySelectorAll("[data-find-mode]")].map((b) => b.dataset.findMode + (b.classList.contains("is-on") ? "(on)" : "")),
    mediaButtons: [...document.querySelectorAll("[data-find-media]")].map((b) => b.dataset.findMedia + (b.classList.contains("is-on") ? "(on)" : "")),
    present,
    appChildren: [...(document.querySelector("#app")?.children || [])].map((c) => c.tagName + "." + (c.className || "")),
    bodyText: body.innerText.replace(/\s+/g, " ").slice(0, 400),
  };
})()