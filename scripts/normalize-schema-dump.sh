#!/usr/bin/env bash
# scripts/normalize-schema-dump.sh
#
# Normalizes pg_dump --schema-only output so that two dumps produced by
# different application paths (sequential 0000-0011 vs squashed
# 0000_v1_baseline.sql) are byte-comparable.
#
# Usage:   pg_dump --schema-only ... | ./scripts/normalize-schema-dump.sh > dump.sql
#
# Normalization steps (per .planning/phases/15-carveout-migration-squash/15-CONTEXT.md
# §"Migration Squash Equivalence" / "Specifics"):
#   - Strip pg_dump preamble/timestamp/comment lines
#     ("Dumped from database version", "Dumped by pg_dump", "PostgreSQL database
#      dump" header + "complete" footer, "Started on", "Completed on")
#   - Strip pg_dump SET-statements (environment-dependent header noise)
#   - Strip pg_catalog.set_config calls
#   - Strip \restrict / \unrestrict psql metacommands — Postgres 14+ emits a
#     fresh random token on every dump, so these would create false-positive
#     diffs between any two dump runs.
#   - Skip COPY blocks targeting any __drizzle_migrations* table — migration
#     journal data is not part of the schema equivalence proof and varies
#     trivially between the two application paths (one row per migration vs
#     a single row for the squash).
#
# Belt-and-suspenders: pg_dump --schema-only usually emits no data rows, so
# the COPY-skip block is defensive — if it ever produces noise, simplify.

set -euo pipefail

sed -E \
  -e '/^-- Dumped (from|by) /d' \
  -e '/^-- PostgreSQL database dump( complete)?$/d' \
  -e '/^-- Started on /d' \
  -e '/^-- Completed on /d' \
  -e '/^SET (statement_timeout|lock_timeout|idle_in_transaction_session_timeout|client_encoding|standard_conforming_strings|xmloption|client_min_messages|row_security)/d' \
  -e '/^SELECT pg_catalog\.set_config/d' \
  -e '/^\\(un)?restrict /d' \
  | awk '
    # Skip COPY blocks targeting __drizzle_migrations* (journal data, not schema).
    /^COPY (public\.|drizzle\.)?__drizzle_migrations/ { skipping = 1; next }
    skipping && /^\\\.$/                              { skipping = 0; next }
    skipping                                          { next }
                                                      { print }
  '
