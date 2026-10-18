import { route } from "./app/router.js";
import { initSearchLayer } from "./components/searchLayer.js";
import { track } from "./utils/profile.js";

// Global search layer (topbar + homepage share the same engine).
initSearchLayer();

const menuTrigger = document.querySelector("#mobile-menu-trigger");
const nav = document.querySelector(".main-nav");
if (menuTrigger && nav) {
  menuTrigger.addEventListener("click", () => {
    const open = document.body.classList.toggle("menu-open");
    menuTrigger.setAttribute("aria-expanded", String(open));
  });
  nav.addEventListener("click", () => {
    document.body.classList.remove("menu-open");
    menuTrigger.setAttribute("aria-expanded", "false");
  });
}

// Background behaviour log for the future YOUR EYE surface.
// Nothing is rendered from this data yet — it is recorded only.
window.addEventListener("hashchange", () => {
  const name = window.location.hash.replace(/^#/, "").split("/")[0] || "index";
  track("route", name);
});

window.addEventListener("hashchange", route);
route();
