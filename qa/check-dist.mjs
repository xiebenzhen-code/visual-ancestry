// Verify dist markers after the Phase 2A.5 rebuild.
import { readFileSync, writeFileSync } from "node:fs";
const root = "C:<local-path>";
const read = (p) => {
  try {
    return readFileSync(root + "/" + p, "utf8");
  } catch {
    return "";
  }
};
const result = {
  distHomeHero: read("dist/src/pages/home.js").includes("hero-kicker"),
  distHomeOld: read("dist/src/pages/home.js").includes("exhibition-home"),
  distSearchDebounce: read("dist/src/components/searchLayer.js").includes("DEBOUNCE_MS"),
  distSearchHero: read("dist/src/components/searchLayer.js").includes("bindHeroSearch"),
  distSearchFail: read("dist/src/components/searchLayer.js").includes("\u9986\u85cf\u641c\u7d22\u6682\u65f6\u4e0d\u53ef\u7528"),
  distFeedTileDiv: !read("dist/src/components/feedTile.js").includes('<a class="feed-tile"'),
  distTileActions: read("dist/src/components/feedTile.js").includes("tile-actions"),
  distRouterNoSearchPage: read("dist/src/app/router.js").includes("__searchLayer"),
  distCreateEntry: read("dist/src/pages/create.js").includes("workflow-title"),
  distShootWizard: read("dist/src/pages/shoot.js").includes("subject-card"),
  distArtworkCompact: read("dist/src/pages/artwork.js").includes("detail-actionsrow"),
  distArtServiceTimeout: read("dist/src/services/artService.js").includes("withTimeout"),
  distMixedFeed: read("dist/src/services/artService.js").includes("getMixedFeed"),
  distShellCss: read("dist/index.html").includes("shell.css"),
};
writeFileSync(root + "/qa/dist-final-check.json", JSON.stringify(result, null, 2));
console.log("DONE");