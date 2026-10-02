# Changelog

All notable changes to this project are documented in this file.

## 1.0.0 (2026-10-02)

First public release.

- OpenCode V2 plugin (`@opencode/plugin` SDK, `Plugin.define`) exposing the
  `history_search` tool in Code Mode.
- Searches the V2 storage schema (`session_v2` / `session_message` with inline
  parts) read-only via `bun:sqlite`.
- Search modes: keyword (literal or regex, case-insensitive by default),
  fuzzy (fuse.js, configurable threshold), multi-term AND (all terms in one
  session), and file touch tracing.
- Filters: `date` (relative and absolute ranges), `role` (user/assistant),
  `limit` — applied after date filtering.
- Project scoping: git root hash for repositories, location id plus legacy
  `"global"` bucket for non-git directories; `searchAllProjects` for machine-wide
  search.
- Cross-platform data directory resolution (XDG / Linux / macOS / Windows)
  with `OPENCODE_DB` override and per-channel DB file discovery.
- Graceful degradation: friendly message on machines without any history,
  actionable error on unrecognized schemas.
- Test suite: unit tests for path resolution, date filtering, formatting, and
  SQLite storage, plus integration tests against a seeded temporary V2-schema
  database (CI-safe, never touches real history).
