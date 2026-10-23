// pro-max: research document cache (node:sqlite, no extra deps).
//
// A cache that stores whatever a page said is a cache that replays whatever a
// page said - including text written to steer a model two days later. Four
// rules keep that from happening:
//
//   1. sanitise before storing (control chars, HTML comments/script, size cap)
//   2. content-hash dedupe: identical text is stored once, not once per URL
//   3. per-domain and global row caps, oldest evicted first
//   4. instruction-shaped rows are quarantined (trust = 0) and never read back
//
// Cached text is still untrusted input: callers must keep wrapping it.
// Node < 22.5 has no node:sqlite, so the module degrades to a no-op.

import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

const STALE_MS = 7 * 24 * 3600 * 1000; // keep in sync with research.js
const MAX_CONTENT_CHARS = 200_000;
const MAX_ROWS = 5_000;
const MAX_ROWS_PER_DOMAIN = 200;
const TRUST_QUARANTINE = 0;
const TRUST_OK = 1;

const PAYLOAD_LINE =
  /(ignore (all )?(previous|prior) (instructions?|prompts?)|disregard (the )?(above|previous)|system prompt|you are now|begin (system|instructions)|<\|im_start\|>|<\/?system>|(\u5ffd\u7565|\u65e0\u89c6)(\u4e4b\u524d|\u4ee5\u4e0a|\u4e0a\u9762|\u524d\u9762)|\u7cfb\u7edf\u63d0\u793a)/gi;

let db = null;
try {
  const req = createRequire(import.meta.url);
  const { DatabaseSync } = req("node:sqlite");
  const dir = process.env.RESEARCH_CACHE_DIR || join(homedir(), ".cache", "dsh-free-search-pro-max");
  mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(join(dir, "research.db"));
  migrate(db);
} catch {
  db = null;
}

function migrate(handle) {
  handle.exec(
    "CREATE TABLE IF NOT EXISTS pages(url TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', content TEXT NOT NULL, fetched_at INTEGER NOT NULL)",
  );
  const cols = new Set(handle.prepare("PRAGMA table_info(pages)").all().map((row) => row.name));
  const add = (name, ddl) => {
    if (!cols.has(name)) handle.exec(`ALTER TABLE pages ADD COLUMN ${ddl}`);
  };
  add("content_hash", "content_hash TEXT");
  add("domain", "domain TEXT");
  add("trust", `trust INTEGER NOT NULL DEFAULT ${TRUST_OK}`);
  add("bytes", "bytes INTEGER NOT NULL DEFAULT 0");
  handle.exec("CREATE INDEX IF NOT EXISTS pages_domain ON pages(domain)");
  handle.exec("CREATE INDEX IF NOT EXISTS pages_hash ON pages(content_hash)");
  handle.exec("CREATE INDEX IF NOT EXISTS pages_fetched ON pages(fetched_at)");
  handle.exec("PRAGMA user_version = 2");
}

/** Strip what a page can hide in: control chars, comments, scripts, size. */
function sanitize(content) {
  return String(content ?? "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u200B-\u200F\u202A-\u202E\u2060-\u2064]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CONTENT_CHARS);
}

function looksLikePayload(content) {
  return (content.match(PAYLOAD_LINE) ?? []).length >= 2;
}

function domainOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** Fresh cached copy, or null. Quarantined rows never come back out. */
export function getFresh(url, maxAgeMs) {
  if (!db) return null;
  const row = db
    .prepare("SELECT title, content, fetched_at FROM pages WHERE url = ? AND trust = ?")
    .get(url, TRUST_OK);
  if (!row || Date.now() - row.fetched_at > maxAgeMs) return null;
  return row;
}

/** Store one page: sanitised, hashed, deduped, capped. */
export function put(url, title, content) {
  if (!db) return;
  const text = sanitize(content);
  if (text.length < 32) return;
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 32);
  const now = Date.now();
  const duplicate = db
    .prepare("SELECT url FROM pages WHERE content_hash = ? AND fetched_at > ? LIMIT 1")
    .get(hash, now - STALE_MS);
  if (duplicate && duplicate.url !== url) return;
  const trust = looksLikePayload(text) ? TRUST_QUARANTINE : TRUST_OK;
  db.prepare("DELETE FROM pages WHERE url = ?").run(url);
  db.prepare(
    "INSERT INTO pages(url, title, content, fetched_at, content_hash, domain, trust, bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(url, String(title ?? "").slice(0, 300), text, now, hash, domainOf(url), trust, text.length);

  const domain = domainOf(url);
  const overflow = db
    .prepare("SELECT url FROM pages WHERE domain = ? ORDER BY fetched_at DESC LIMIT -1 OFFSET ?")
    .all(domain, MAX_ROWS_PER_DOMAIN);
  for (const row of overflow) db.prepare("DELETE FROM pages WHERE url = ?").run(row.url);
  const globalOverflow = db
    .prepare("SELECT url FROM pages ORDER BY fetched_at DESC LIMIT -1 OFFSET ?")
    .all(MAX_ROWS);
  for (const row of globalOverflow) db.prepare("DELETE FROM pages WHERE url = ?").run(row.url);
}

/** Full-text LIKE search over trusted cached pages (7 days). */
export function search(query, limit = 8) {
  if (!db) return [];
  db.prepare("DELETE FROM pages WHERE fetched_at < ?").run(Date.now() - STALE_MS);
  const like = `%${String(query).replace(/[%_]/g, " ")}%`;
  const rows = db
    .prepare(
      "SELECT url, title, content, fetched_at FROM pages WHERE trust = ? AND (title LIKE ? OR content LIKE ?) AND fetched_at > ? ORDER BY fetched_at DESC LIMIT ?",
    )
    .all(TRUST_OK, like, like, Date.now() - STALE_MS, limit);
  return rows.map((row) => {
    const at = row.content.toLowerCase().indexOf(String(query).toLowerCase());
    const start = Math.max(0, at - 40);
    return {
      url: row.url,
      title: row.title,
      excerpt:
        (start > 0 ? "... " : "") + row.content.slice(start, start + 160).replace(/\s+/g, " "),
      fetched_at: new Date(row.fetched_at).toISOString(),
    };
  });
}
