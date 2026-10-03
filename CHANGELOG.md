# Changelog

All notable changes to tradingcli are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/); versions follow
[Semantic Versioning](https://semver.org/).

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
