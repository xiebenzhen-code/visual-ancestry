import { escapeHtml } from "../utils/html.js";

export function searchBox(compact = false) {
  return `
    <form class="search-form ${compact ? "is-compact" : ""}" id="search-form">
      <label for="main-search">${compact ? "SEARCH" : "检索档案"}</label>
      <input id="main-search" name="query" value="${escapeHtml(window.__visualAncestryState?.query || "")}" autocomplete="off" placeholder="孤独 / dreamlike / 巴洛克" />
    </form>
  `;
}