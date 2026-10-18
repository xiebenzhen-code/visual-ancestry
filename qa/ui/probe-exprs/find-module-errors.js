(async () => {
  const out = {};
  // 1) 其它路由是否也空？判断是「整个 app 挂了」还是「只有 FIND 挂了」
  out.bodyHasAnyMain = document.body.innerText.replace(/\s+/g, " ").slice(0, 200);
  // 2) 直接 import 相关模块，把异常抓出来
  const mods = [
    "/src/pages/find.js",
    "/src/components/remoteFilmCard.js",
    "/src/services/retrieval/remoteReferences.js",
    "/src/services/retrieval/filmCorrections.js",
    "/src/services/source/filmVisionRerank.js",
    "/src/services/source/filmFrameEvidence.js",
    "/src/services/source/filmIdentityWikidata.js",
    "/src/services/source/remoteDiscovery.js",
  ];
  out.modules = {};
  for (const m of mods) {
    try {
      const mod = await import(m);
      out.modules[m] = "ok: " + Object.keys(mod).slice(0, 6).join(",");
    } catch (e) {
      out.modules[m] = "IMPORT ERROR: " + String(e && (e.message || e)).slice(0, 200);
    }
  }
  // 3) 手动调用渲染，看抛什么
  try {
    const find = await import("/src/pages/find.js");
    const app = document.querySelector("#app") || document.body;
    find.renderFind(app, "Intolerance", { media: "film" });
    out.renderCall = "ok";
  } catch (e) {
    out.renderCall = "RENDER ERROR: " + String(e && (e.stack || e.message || e)).slice(0, 400);
  }
  out.afterBody = document.body.innerText.replace(/\s+/g, " ").slice(0, 200);
  return out;
})()