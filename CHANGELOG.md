# Changelog

All notable changes to tradingcli are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.5.2] — 2026-10-04

### Changed

- README readability pass (emoji section headers, grouped commands) and
  corrected MCP tool counts (60 / 72 / 79) plus the missing
  `test_quote_cache.py` entry. No code changes since 0.5.1.

## [0.5.1] — 2026-10-03

### Added

- Server-side quote delay: `latest_quote` / `bulk_quotes` / `market_snapshot`
  marks are cached up to `QUOTE_TTL_SEC` (60s); failures are never cached.
  Fills and ticks always price live. `pt.clear_quote_cache()` forces fresh.
- `test_quote_cache.py` proving delayed reads, TTL expiry, and no stale fills.
- `Dockerfile` (pinned Python 3.11 + requirements + Bun 1.4.2) — verified by
  build + in-container `--version`, accounts flow, and 60-tool MCP import.
- MCP SDK compatibility: server imports on both `mcp` 1.x (`FastMCP`) and 2.x
  (`MCPServer`); dependency floor widened to `mcp>=1.27,<3`. All three MCP
  suites pass under 1.30 and 2.3.0.
- 50-row book render test (110/80/40 cols): every row present, no overflow.

### Changed

- TUI display quotes are 15-minute delayed (`QUOTE_TTL_MS`); failed auto-tick
  backs off 60s (manual `t` unaffected).
- TUI refresh economy: single meta round, quotes fetched once per refresh,
  retick only on fills, 60s market-clock cache — steady refresh 22 spawns/6s
  down to 4 local spawns/1.5s on the live book.
- TUI snapshot survives tick failure: panels + pending render with a `tickError`
  note instead of a blank error.
- TUI color (gains/losses/accents, valid greys), airy layout with rules and an
  aligned stats grid; transient tick notices demoted below the red error box.

### Fixed

- `dash` exec failures now raise a clean error instead of falling through;
  parity packaging assertion narrowed to the wheel `include` block;
  `web_ui.py` wheel wording corrected in the agent guide.

## [0.5.0] — 2026-10-03

### Added

- OpenTUI terminal app (`tui/`, Bun + `@opentui/react`) — new primary
  terminal dashboard: per-account panels, market-clock banner, `b/s/o/g/c/n/e/u/t/r/q`
  keymap, first-run setup wizard, order modals, backtesting & graphs view.
- `tradingcli-tui` entry point and `tradingcli dash` delegation
  (`--rich` keeps the legacy Rich dashboard).
- Agent headless mode: `tradingcli-tui --headless --json snapshot|backtest`.
- 15s TTL display-quote cache in the TUI (post-tick re-snapshot stays fresh)
  to avoid Yahoo Finance rate-limiting; fills/ticks always use live prices.
- `accounts --detail` flag (additive, default output unchanged) exposing
  deposits/realized/created for the TUI's TOTAL/return stats.
- `test_tui_parity.py` — Rich-vs-TUI parity checks (panels, realized, pending,
  backtesting markers).

### Changed

- Web SPA retired from docs and wheel (`web_ui.py` retained but unsupported).
- Fresh-clone setup now includes `(cd tui && bun install)` (Bun >= 1.4.1).

### Verification

- 14/14 Python test scripts pass (pinned deps, incl. 79 MCP tools across
  core/advanced/full profiles); 43 Bun tests pass.
- Live end-to-end: MCP quote/order/fill/watchlist lifecycle, TUI headless
  snapshot vs CLI positions agreement, backtest `status: ok` on real history.

## [0.4.1] — earlier

- Correctness hardening across portfolio, linked orders, and backtesting
  (see git history).
