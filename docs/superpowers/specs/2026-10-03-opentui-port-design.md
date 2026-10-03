# tradingcli OpenTUI port — design spec

Date: 2026-10-03 · Approach A (approved): Sidecar CLI bridge · Status: awaiting spec review

## 1. Intent

Port the tradingcli terminal experience from Rich (`dashboard.py`) to OpenTUI
(Zig core + TypeScript + `@opentui/react`, Bun runtime) so the paper trader is a
first-class terminal app for humans **and** AI agents (OpenCode-style workflow),
while keeping all money behavior identical.

What the partner said vs assumptions:

- Said: "port most of it to that runtime while keeping most functionality",
  "fit the paper trader for AI agents in the terminal".
- Said (answers): TS UI + Python engine; surfaces TUI + CLI + MCP only (drop web SPA).
- Assumptions (correct if wrong): same SQLite file + schema stays canonical;
  `~/.papertrade.db` + `PAPERTRADE_DB` contract unchanged; MCP tool contract
  unchanged; no new order types / asset classes; Bun + Python both required.

Success criteria:

1. `tradingcli-tui` (Bun/OpenTUI) reproduces the Rich dashboard: per-account
   panels (cash/equity/day/unreal/realized/total), tickmarks, pending-orders
   line, market-clock banner, `b/s/o/g/c/n/e/u/t/r/q` keymap, first-run setup,
   buy/sell/option/cancel/new/rename/switch flows, backtesting & graphs view.
2. Zero money-logic drift: every read/write goes through `papertrade.py`
   (`--json` CLI). TUI never opens SQLite directly. Existing `test_*.py` suite
   keeps passing unmodified.
3. Agent-friendly: `tradingcli-tui --headless --json snapshot` (and backtest)
   emits the same `{ok, data}` envelope for scripting; MCP server unchanged.
4. Terminal restores cleanly on quit/Ctrl-C/error (OpenTUI lifecycle).
5. Web SPA removed from docs/build; `web_ui.py` retained as unsupported file
   (not deleted, not advertised) to keep the diff reviewable.

Non-goals: full TS engine rewrite; new charting beyond braille/sparkline parity;
images/audio/3D; web SPA feature work; changing the DB schema for the TUI.

## 2. Architecture

```
┌───────────── tui/ (Bun + @opentui/react) ─────────────┐
│ App · PortfolioPanels · StatusBar · OrderModal ·       │
│ BacktestView · keymap · engine.ts bridge · chart.ts    │
└──────────────────────┬────────────────────────────────┘
                       │ spawn `python3 papertrade.py … --json`
                       │ same PAPERTRADE_DB / ~/.papertrade.db
┌──────────────────────▼────────────────────────────────┐
│ papertrade.py (unchanged engine + CLI --json)          │
│ SQLite (WAL, BEGIN IMMEDIATE via writing()) + yfinance │
└───────────────────────────────────────────────────────┘
MCP server (mcp_server.py): untouched, same DB contract.
```

- New `tui/` Bun app: `src/index.ts` (entry/args), `src/engine.ts` (spawn +
  parse + cache), `src/types.ts` (CLI JSON envelope types), `src/chart.ts`
  (TS port of `dashboard.braille_chart`), `src/views/*` (panels/modals).
- Entrypoints: `tradingcli-tui` → `bun tui/src/index.ts`; `tradingcli dash`
  delegates to the OpenTUI app; `tradingcli dash --rich` keeps old Rich loop.
- Runtime: Bun >=1.4.1 (dev has 1.4.0 — upgrade note), prebuilt OpenTUI native
  (no Zig toolchain needed), Python >=3.10 with existing `requirements.txt`.
- Build/packaging: add `tui/package.json` (bun worktree, `@opentui/core`,
  `@opentui/react`); `pyproject.toml` gains `tradingcli-tui` shim script and
  drops `static/` from wheel include; README documents Bun prerequisite.
- Web: `web_ui.py` + `static/index.html` stay in repo but are removed from
  README run-sections, `pyproject` build include, and agent-guide surfaces.

## 3. Components

| Component | Responsibility | Maps from |
|---|---|---|
| `engine.ts` | `snapshot()`, `tick()`, `place/cancel/*`, `backtest()`, `perf()` via CLI `--json`; batch + dedupe; 2s poll default | `dashboard.snapshot/fetch_quotes/run_tick`, `pt.*` |
| `store.ts` | accounts, quotes, prev-close map, pending, clock, selected account | `dashboard.render` inputs |
| `PortfolioPanels` | per-account table (symbol/side/qty/avg/price/mkt/unreal/pct) + stats grid | `dashboard.render` Table+Panel |
| `StatusBar`/`Banner` | market-clock (`pt.market_clock` via CLI), `as of` stamp, key hints | `dashboard.render` banner+keys |
| `OrderModal` (buy/sell/option/cancel/new/rename/switch) | OpenTUI `Input`/`Select` forms, inline validation, confirm output line | `prompt_*` functions |
| `BacktestView` | split current-performance vs backtest, stats grids, notes panel | `backtesting_graphs_view`, `prompt_backtesting_graphs` |
| `chart.ts` | `brailleChart(values,w,h)` + min/max labels; drop non-finite first | `dashboard.braille_chart`, `_chart_group` |
| `keymap` | `@opentui/keymap` bindings `b/s/o/g/c/n/e/u/t/r/q`, Esc closes modal | `run_dashboard` key dispatch |
| `headless.ts` | `--headless --json snapshot|backtest` prints envelope, no TTY | new (agent use) |

First-run setup ports `first_run_setup` (name/cash/risk profile) as a modal
wizard gated on `setup_done` + zero accounts, via CLI queries.

## 4. Data flow

- Refresh loop (default 2.0s, `-n` override, `-a` account filter):
  1. `engine.accounts()` → positions + pending (one CLI call per refresh,
     batched; quotes fetched via `data snapshot --json` batch, not N calls).
  2. Compute tickmarks locally from prev-price map (`▲/▼/·`), same as Rich.
  3. If any OCC expiry passed or any pending orders exist → `engine.tick()`
     then re-snapshot (mirrors `run_dashboard` auto-fill).
  4. Render; store prev prices.
- Keys: `t` = tick now, `r` = refresh now, `q` = quit; `b/s/o/c/n/e/u/g`
  suspend live loop, open modal, run mutation via CLI, sleep-free re-render on
  close (no `time.sleep` blocking; use OpenTUI scheduler).
- Backtest flow: modal asks account + history preset (`6m/1y/2y/5y/10y/max` or
  days via shared `parse_lookback_days` semantics) → `engine.equityCurve()` +
  `engine.backtest()` concurrently → `BacktestView` (current + backtest side by
  side, universe/skipped/model/costs/caution notes). Enter/Esc returns.
- Market data: never direct Yahoo from TS. All prices/quotes/history come from
  the Python side so rate-limiting, OCC pricing, and `aggregated/indicative`
  disclaimers stay single-sourced.
- Headless: `tradingcli-tui --headless --json snapshot -a X` prints one JSON
  envelope and exits (exit code 0/1, no ANSI), for agents that cannot run a TUI.

Sequence (refresh): scheduler → engine.snapshot+quotes → tick? → store →
React render → keymap/idle → next tick.

## 5. Error handling

- Every CLI call returns `{ok, data|error}`; engine throws typed
  `EngineError(message, command)` on `ok:false`, timeout (>15s), bad JSON, or
  Python-missing. Views render a red inline panel with the command + message
  and keep the last good frame (quote outage renders `?`/`~cost`, never blank).
- Non-finite numbers (`NaN/Inf`) sanitized to `null/—` at the TS boundary
  (mirror `pt._json_safe`); `Infinity` never reaches the renderer.
- DB locked/busy: retry once after 250ms, then show `database busy — retrying`
  and continue polling; never hold a WAL reader during slow calls.
- Invalid input (bad OCC, non-numeric qty/limit, unknown account): inline modal
  error, no state change, Esc aborts.
- Lifecycle: `try/finally` renderer destroy on quit, Ctrl-C, or uncaught
  exception; raw-mode/TTY restored (OpenTUI lifecycle API). Non-TTY without
  `--headless` exits with `need a TTY or --headless` instead of hanging.
- Python missing / wrong version: preflight check with actionable message
  (`python3 -m papertrade --schema` probe).

## 6. Testing

- Keep all 13 `test_*.py` scripts passing unmodified (engine untouched).
- New Bun tests (`tui/tests/`, `bun test`):
  - `chart.test.ts`: braille port vs golden vectors incl. NaN/single-point/flat.
  - `engine.test.ts`: envelope parsing, `ok:false` mapping, timeout, non-TTY guard
    (mock spawn, no real DB/network).
  - `headless.test.ts`: snapshot JSON shape matches CLI `--json` keys.
- Parity test (`test_tui_parity.py`, standalone script like the rest): seeds
  temp DB, runs Rich `dashboard.render` to text and `tradingcli-tui --headless
  --json snapshot`, asserts same account names, cash, symbols, pending ids, and
  `BACKTESTING` markers present in both views.
- Manual: `tradingcli-tui` smoke on macOS arm64/x64 + Linux x64; resize,
  modal Esc, `q` restore (`echo $TERM` sane after exit); Bun 1.4.1+.

## 7. Risks / open questions

- Spawn-per-refresh latency vs daemon: accepted; mitigated by batching +
  2s cadence. If p95 refresh >1s on real books, follow-up can add a persistent
  Python sidecar over stdio (no REST daemon per approved approach).
- Bun version bump 1.4.0 → 1.4.1+ on dev machine (one-line upgrade).
- OpenTUI React API drift: pin exact `@opentui/*` versions in `tui/bun.lock`;
  install the `anomalyco/opentui` skill (`npx skills add`) before implementing
  for API-accurate code.
- `web_ui.py` kept-but-unsupported may confuse; alternative is full delete —
  left as follow-up to keep this diff reviewable.

## 8. Rollout

1. Land `tui/` + `tradingcli-tui` shim + docs; `dash` delegates, `--rich` fallback.
2. Deprecation notice on Rich path; web SPA removed from README/build.
3. Later (separate spec): optional stdio sidecar if perf demands; optional
   `web_ui.py` deletion.
