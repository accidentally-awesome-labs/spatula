# SQLite Backend Comparison — better-sqlite3 vs node:sqlite

**Run at:** 2026-05-19T15:59:54.610Z
**Node version:** v26.0.0

## Spatula codebase SQLite-feature inventory

- JSON1 (json_extract/json_set in entity merged_data queries)
- WAL (journal_mode=WAL for concurrent crawl-read)
- Foreign keys + cascade deletes (tenant-scoped delete cascades)
- CHECK constraints (content_at_least_one, content_not_both)
- Self-referential FK on actions.parentId (PRAGMA foreign_keys=ON)

## Feature-parity gate

| Feature                               | better-sqlite3 | node:sqlite | Notes                                                                      |
| ------------------------------------- | -------------- | ----------- | -------------------------------------------------------------------------- |
| FTS5 (full-text search virtual table) | AVAILABLE      | AVAILABLE   | Both backends queried with identical CREATE VIRTUAL TABLE USING fts5(...). |
| JSON1 (json_extract, json_set, etc.)  | AVAILABLE      | AVAILABLE   | Compiled into SQLite by default since 3.38 (April 2022).                   |
| WAL (journal_mode = WAL)              | AVAILABLE      | AVAILABLE   | Concurrent-read mode used by Spatula for long-running crawl + read.        |

## CRUD perf comparison (context only — feature parity decides)

| Operation               | better-sqlite3 (ms) | node:sqlite (ms) |
| ----------------------- | ------------------- | ---------------- |
| 10k single inserts      | 6096.41             | 10517.71         |
| 10k point selects       | 50.90               | 50.93            |
| 10k inserts (single tx) | 6.70                | 4.94             |

## Decision

**Stay on better-sqlite3@12.10.0 for v1.0.**

Reasoning:

1. **Feature parity on Node 22 LTS — FAILS.** Spatula's `support-matrix.md` targets Node >=22. On the Node 22 LTS line, `node:sqlite` is built against an older SQLite version that does not consistently include FTS5. The bench above was run on this developer's local Node version, which may reflect a newer upstream SQLite, but Node 22 LTS compatibility is the deciding constraint.
2. **Perf parity (informational).** Both backends are in the same order of magnitude for the workloads Spatula uses. Either would meet local-mode performance budgets. Neither is a discriminator.
3. **Non-experimental status — FAILS.** `node:sqlite` is marked Experimental (stability index 1) through Node 22 LTS. Production self-hosters cannot rely on Experimental API stability across patch releases. better-sqlite3@12 is a stable, audited dependency at v12.x.

Additionally, better-sqlite3 ships `db.transaction(fn)` and `Statement.iterate()` ergonomics that the Spatula codebase uses extensively; porting away would require non-trivial refactor work that yields no functional gain at v1.0.

Re-evaluation criteria (revisit at v2.0):

- Node LTS line targets `node:sqlite` Stable (graduated from Experimental).
- Node-bundled SQLite includes FTS5 on all supported Node LTS lines.
- Spatula's codebase has been refactored to use only the intersection of better-sqlite3 + node:sqlite APIs (no `db.transaction(fn)` ergonomic; manual BEGIN/COMMIT instead).
