// server/security/staticPathGuard.mjs
//
// P2.7 SECURITY FIX — explicit allow-list for the static file server.
//
// THE DEFECT THIS CLOSES
//   `scripts/server.mjs` used to resolve ANY path under `root`, and `root`
//   defaulted to the PROJECT DIRECTORY. Measured on the real tree:
//
//     GET /.env  ->  200  application/octet-stream  147 bytes  containsKey=YES
//
//   i.e. the paid provider key was readable over plain HTTP by anyone who could
//   reach the port. Loopback binding limited the blast radius but never fixed
//   the defect: any proxy, tunnel, or `VISION_ALLOW_INSECURE_BIND=1` turned it
//   into a real disclosure.
//
// THE FIX
//   Serving is restricted to an explicit allow-list. Everything else is
//   refused with 404 and the path decision is made BEFORE any filesystem
//   access. Rejected classes:
//     - hidden entries        (.env, .env.example, .git, .gitignore, .nojekyll)
//     - non-allow-listed dirs (server/, scripts/, qa/, docs/, work/, node_modules/)
//     - path traversal        (.., and any segment starting with a dot)
//     - encoding tricks       (single decode only; %252e never becomes "..")
//     - NTFS alternate data streams (`:` anywhere in a segment)
//     - sensitive extensions  (.key, .pem, ...) even under an allowed dir
//
//   `serveFile` additionally re-checks containment AFTER resolving symlinks, so
//   a link planted inside `src/` cannot be used to read outside the allow-list.
//
// The lexical decision below is pure (no I/O, no env, unit-testable without a
// server). The ONE exception is `resolveRealStaticPath`, which must touch the
// filesystem: a symlink/junction can only be caught AFTER it is resolved.

import { realpath } from "node:fs/promises";

export const STATIC_DIRS = new Set(["src", "public"]);
export const STATIC_FILES = new Set(["index.html"]);

// Refused even when they sit inside an allow-listed directory.
export const SENSITIVE_EXT = new Set([
  ".env",
  ".key",
  ".pem",
  ".p12",
  ".pfx",
  ".crt",
  ".log",
  ".ndjson",
]);

// Decode EXACTLY ONCE. A second pass is what turns `%252e%252e` into `..`
// (double-decoding traversal). The decoded text is treated as literal data.
function decodePathOnce(urlPath) {
  try {
    return decodeURIComponent(urlPath);
  } catch {
    return null; // malformed percent-encoding, e.g. "%zz" or a lone "%"
  }
}

/**
 * Is `absPath` inside the allow-list, given the server root?
 * Used as the post-symlink containment check in `serveFile`.
 */
export function isInsideAllowedRoot(absPath, rootDir) {
  const abs = resolvePath(absPath);
  if (abs === resolvePath(joinPath(rootDir, "index.html"))) return true;
  for (const dir of STATIC_DIRS) {
    const base = resolvePath(joinPath(rootDir, dir));
    if (abs === base || abs.startsWith(base + sep())) return true;
  }
  return false;
}

/**
 * Symlink / junction safety gate (P2.7.1).
 *
 * `resolveStaticPath` above is purely lexical, so a link planted INSIDE an
 * allow-listed directory (e.g. `public/leak` -> the project root) passes it.
 * This second gate resolves the candidate through the filesystem and requires
 * the REAL path to still sit inside the allow-list under the REAL root. Only the
 * returned canonical path may ever be opened.
 *
 * Returns the canonical path, or null when the path is missing or escapes the
 * allow-list (the symlink case). Not pure by design: symlinks cannot be judged
 * without resolving them.
 */
export async function resolveRealStaticPath(candidatePath, rootDir) {
  if (typeof candidatePath !== "string" || candidatePath === "") return null;
  const realRoot = await realpath(rootDir).catch(() => null);
  if (!realRoot) return null;
  const realCandidate = await realpath(candidatePath).catch(() => null);
  if (!realCandidate) return null;
  return isInsideAllowedRoot(realCandidate, realRoot) ? realCandidate : null;
}

/**
 * Pure URL-pathname -> decision function.
 * Returns { ok: true, path } or { ok: false, reason }.
 * Never throws and never touches the filesystem.
 */
export function resolveStaticPath(urlPath, rootDir) {
  const decoded = decodePathOnce(urlPath);
  if (decoded === null) return { ok: false, reason: "malformed-encoding" };
  if (decoded.includes("\0")) return { ok: false, reason: "null-byte" };

  // Split on BOTH separators: on Windows a backslash is a separator too, so
  // `/..\\.env` and `/src\\..\\.env` must be judged like their slash forms.
  const segments = decoded.split(/[/\\]/).filter((s) => s !== "");
  if (segments.length === 0) return { ok: true, path: joinPath(rootDir, "index.html") };

  for (const seg of segments) {
    if (seg === "." || seg === "..") return { ok: false, reason: "traversal" };
    if (seg.startsWith(".")) return { ok: false, reason: "hidden" };
    if (seg.includes(":")) return { ok: false, reason: "ads" };
    if (seg.length > 255) return { ok: false, reason: "segment-too-long" };
  }

  const leaf = segments[segments.length - 1];
  const ext = leaf.includes(".") ? leaf.slice(leaf.lastIndexOf(".")).toLowerCase() : "";
  if (SENSITIVE_EXT.has(ext)) return { ok: false, reason: "sensitive-extension" };

  // Top level: only the exact allow-listed entries.
  if (segments.length === 1) {
    if (STATIC_FILES.has(segments[0]) || STATIC_DIRS.has(segments[0])) {
      return { ok: true, path: joinPath(rootDir, segments[0]) };
    }
    return { ok: false, reason: "not-allowed" };
  }

  if (!STATIC_DIRS.has(segments[0])) return { ok: false, reason: "not-allowed" };
  return { ok: true, path: joinPath(rootDir, ...segments) };
}

// ---- tiny path helpers (kept local so this module has no node:path import
// cost in the hot path and stays trivially testable) ------------------------
function sep() {
  return process.platform === "win32" ? "\\" : "/";
}

function joinPath(...parts) {
  const s = sep();
  const joined = parts
    .filter((p) => p !== undefined && p !== null && p !== "")
    .map((p) => String(p).replace(/[/\\]+/g, s))
    .join(s);
  return resolvePath(joined);
}

// Lexical normalization (no filesystem, no symlink resolution): collapses "a/./b"
// and "a/../b" so the containment checks below compare canonical strings.
function resolvePath(p) {
  const s = sep();
  let str = String(p).replace(/[/\\]+/g, s);
  const isAbsolute = str.startsWith(s);
  const out = [];
  for (const part of str.split(s)) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!isAbsolute) out.push("..");
      continue;
    }
    out.push(part);
  }
  return (isAbsolute ? s : "") + out.join(s);
}
