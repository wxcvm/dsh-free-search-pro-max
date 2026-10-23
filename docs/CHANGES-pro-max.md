# pro-max changes

Three ports on top of upstream `dsh-free-search@0.9.14`, plus a defended cache.

## 1. Engine tag

`auto` mode used to write no note at all, so a response never said which engine
answered. Now every successful search appends `(engine: bing)` unless a fallback
`Note:` already names it. Off with `showEngineTag: false`.

## 2. Aggregate failures

A total failure used to throw only the last engine's error. Now every engine's
`[class] message` is collected and thrown once:

```
all search engines failed (4): baidu [auth] BAIDU_API_KEY not configured |
bing [invalid-response] returned 0 results | ...
```

## 3. Tunable cooldown

`BOT_WALL_COOLDOWN_MS` was hard-coded at 60s; it is now `cooldownSeconds`.
Quota and auth failures still cool down for the whole session.

## 4. Snippet budget (cost-neutral)

Per-result cap of 300 chars is replaced by one budget per search:

```yaml
snippetBudget: 2400   # total characters across all results
snippetMax: 600       # ceiling per result
```

* 2 results → up to 600 chars each (was 300)
* 8 results → 300 chars each (identical to before)
* worst case unchanged at ~2400 chars per search

Snippets also cut on sentence boundaries now, and lines that look like
instructions are dropped (`stripSuspiciousLines`, default on).

## 5. Research cache: four defenses

`lib/cache.js` stores fetched pages in `~/.cache/dsh-free-search-pro-max/research.db`
(7-day TTL, `node:sqlite`). Storing raw page text means replaying it later, so:

1. **Sanitise on write** — control chars, zero-width chars, HTML comments,
   `<script>`/`<style>` blocks stripped; 200k char cap per row.
2. **Content-hash dedupe** — identical text is stored once, no matter how many
   URLs serve it. Stops a page farm from filling the cache with one payload.
3. **Caps** — 200 rows per domain, 5000 rows total, oldest evicted first.
4. **Quarantine** — a page whose text matches instruction-shaped patterns twice
   or more is stored with `trust = 0` and never returned by `getFresh` or
   `search`. It cannot resurface days later as "cached evidence".

Schema upgrades in place (`PRAGMA user_version = 2`), so an existing database
keeps working.

Cached text is still untrusted input: callers keep wrapping it in the
`<untrusted-web-content>` boundary.
