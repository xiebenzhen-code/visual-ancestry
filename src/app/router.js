// router.js — SPA hash router. Primary nav carries only INDEX / CREATE / SHOOT.
// CINEMA (#cinema, route kept, not in primary nav), YOUR EYE (#eye, same),
// taxonomy deep-links (#mood / #atmosphere / #traditions) and artwork details
// (#artwork/:key) remain reachable. "search" is no longer a page — it opens
// the global search layer on the current view.
//
// SPA hash-navigation scroll memory: leaving a route remembers its scrollY,
// coming back restores it (detail -> back to feed keeps the position).

import { renderHome } from "../pages/home.js";
import { renderFind } from "../pages/find.js";
import { renderTaxonomy } from "../pages/taxonomy.js";
import { renderArtwork } from "../pages/artwork.js";
import { renderFilmStill } from "../pages/filmDetail.js";
import { renderCreateIndex, renderCreate } from "../pages/create.js";
import { renderShootIndex, renderShoot } from "../pages/shoot.js";
import { renderCinema } from "../pages/cinema.js";
import { renderEye } from "../pages/eye.js";
import { renderMemoryIndex, renderMemoryUpload, renderMemoryDetail } from "../pages/memory.js";
import { renderMemorySearch } from "../pages/memorySearch.js";
import { renderMemoryProfile } from "../pages/memoryProfile.js";
import { renderMemoryAssistant } from "../pages/memoryAssistant.js";

const app = document.querySelector("#app");

const scrollMemory = new Map();
let lastRouteKey = null;

export function route() {
  const [name = "index", id] = window.location.hash.replace(/^#/, "").split("/");
  const routeKey = name + (id ? "/" + id : "");

  // "search" is a trigger, not a page: open the layer on the current view.
  if (name === "search") {
    if (window.__searchLayer) window.__searchLayer.open();
    if (!lastRouteKey) {
      renderHome(app);
      lastRouteKey = "index";
    }
    return;
  }

  if (lastRouteKey !== null) scrollMemory.set(lastRouteKey, window.scrollY);

  if (name === "artwork") renderArtwork(app, id);
  else if (name === "film") renderFilmStill(app, id);
  else if (name === "find") renderFind(app);
  else if (name === "explore" || name === "discover") renderHome(app);
  else if (name === "create") (id ? renderCreate(app, id) : renderCreateIndex(app));
  else if (name === "shoot") (id ? renderShoot(app, id) : renderShootIndex(app));
  else if (name === "mood") renderTaxonomy(app, "emotion");
  else if (name === "atmosphere") renderTaxonomy(app, "atmosphere");
  else if (name === "traditions") renderTaxonomy(app, "tradition");
  else if (name === "cinema") renderCinema(app);
  else if (name === "eye") renderEye(app);
  else if (name === "memory") {
    if (id === "upload") renderMemoryUpload(app);
    else if (id === "search") renderMemorySearch(app);
    else if (id === "profile") renderMemoryProfile(app);
    else if (id === "assistant") renderMemoryAssistant(app);
    else if (id) renderMemoryDetail(app, id);
    else renderMemoryIndex(app);
  }
  else renderHome(app);

  const saved = scrollMemory.get(routeKey);
  if (saved !== undefined && saved > 0) {
    window.scrollTo({ top: saved, behavior: "instant" });
  } else {
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  if (scrollMemory.size > 40) {
    const oldest = scrollMemory.keys().next().value;
    if (oldest !== routeKey) scrollMemory.delete(oldest);
  }
  lastRouteKey = routeKey;
}
