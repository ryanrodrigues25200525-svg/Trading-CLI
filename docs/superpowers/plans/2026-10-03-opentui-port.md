# OpenTUI Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `tui/` (Bun + OpenTUI React) as the primary terminal dashboard over the unchanged Python engine via `papertrade.py --json` sidecar calls.

**Architecture:** Thin TS frontend shells to `python3 papertrade.py … --json` for every read/write against the same SQLite file; money math, risk, OCC, margin stay Python-only. Rich `dashboard.py` kept as `--rich` fallback.

**Tech Stack:** Bun >=1.4.1, `@opentui/core` + `@opentui/react` (pinned), Python >=3.10 existing `requirements.txt`, SQLite WAL via Python only.

**Spec:** `docs/superpowers/specs/2026-10-03-opentui-port-design.md`

## Global Constraints

- Bun >=1.4.1 (dev has 1.4.0 — upgrade first: `bun upgrade`).
- Python >=3.10 with existing `requirements.txt`; engine code in `papertrade.py` stays behavior-identical.
- TUI never opens SQLite directly; every read/write spawns `python3 papertrade.py <cmd> --json` with the caller's `PAPERTRADE_DB` env.
- JSON boundary is `{ok: true, data} / {ok: false, error}`; `NaN/±Inf` become `null/—`, never bare `Infinity`.
- No web SPA work; `web_ui.py` + `static/` stay in repo but leave docs/build (Task 4 only).
- No new order types, asset classes, or DB schema changes.
- Terminal must restore on quit/Ctrl-C/error; non-TTY without `--headless` exits with `need a TTY or --headless`.
- Pin exact `@opentui/*` versions in `tui/package.json` + `tui/bun.lock`; no floating ranges.
- All 13 existing `test_*.py` scripts keep passing unmodified.

## Review Focus

- Yahoo outage / unknown symbol shows `?` / `~cost-basis` and keeps the last good frame instead of blanking — pinned in Task 2 `snapshot-outage` test.
- Pending `stop / stop_limit / trailing_stop` rows render trigger text and auto-tick re-snapshots without duplicating fills — pinned in Task 2 `pending-triggers` + Task 3 `tick-resnapshot` tests.
- Bad OCC input (bad date/strike/expiry) shows inline modal error with no state change, Esc aborts — pinned in Task 3 `option-validation` test.
- DB busy/locked retries once after 250ms then shows `database busy — retrying` and keeps polling — pinned in Task 1 `db-busy` test.
- Non-TTY without `--headless` exits non-zero with the TTY message (no hang); Ctrl-C/`q` restores the terminal — pinned in Task 2 `tty-guard` + Task 3 `lifecycle-restore` tests.

---

### Task 1: Scaffold + engine bridge + chart port

**Files:**
- Create: `tui/package.json`, `tui/tsconfig.json`, `tui/src/types.ts`, `tui/src/engine.ts`, `tui/src/chart.ts`, `tui/tests/engine.test.ts`, `tui/tests/chart.test.ts`
- Modify: none
- Test: `tui/tests/engine.test.ts`, `tui/tests/chart.test.ts`

**Interfaces:**
- Consumes: `python3 papertrade.py <cmd> --json` stdout/stderr (existing CLI contract); `dashboard.braille_chart` algorithm (Python reference).
- Produces: `runCli(args: string[], opts?: {timeoutMs}) => Promise<unknown>`; `snapshot(account?)`, `tick()`, `placeOrder()`, `cancelOrder()`, `backtest()`, `equityCurve()`, `marketClock()` in `tui/src/engine.ts`; `brailleChart(values: number[], width, height) => string[]` in `tui/src/chart.ts`; `EngineError(message, command)`; `Ok<T> = {ok: true, data: T} | {ok: false, error: string}` in `tui/src/types.ts`.

- [ ] **Step 1: Write failing chart test**

```ts
// tui/tests/chart.test.ts
import { describe, expect, test } from "bun:test";
import { brailleChart } from "../src/chart";
describe("brailleChart", () => {
  test("drops non-finite and renders rows", () => {
    const rows = brailleChart([1, NaN, 2, Infinity, 3], 12, 4);
    expect(rows.length).toBe(4);
  });
  test("single point returns placeholder", () => {
    expect(brailleChart([5], 12, 4)).toEqual(["(not enough history yet)"]);
  });
  test("flat series does not throw", () => {
    expect(brailleChart([7, 7, 7], 12, 4).length).toBe(4);
  });
});
```

- [ ] **Step 2: Write failing engine tests (mocked spawn, no DB/network)**

```ts
// tui/tests/engine.test.ts
import { describe, expect, test } from "bun:test";
describe("engine envelope", () => {
  test("ok:false maps to EngineError", async () => { /* spawn stub returning {ok:false,error:"no account 'x'"} → expect EngineError with command in message */ });
  test("bad JSON maps to EngineError", async () => {});
  test("timeout maps to EngineError", async () => {});
  test("db busy retries once then surfaces busy message", async () => {});
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test ./tui/tests/chart.test.ts ./tui/tests/engine.test.ts`
Expected: FAIL with "Cannot find module '../src/chart'" (or missing `src/engine`).

- [ ] **Step 4: Scaffold `tui/package.json` + `tsconfig.json`, pin OpenTUI deps**

Run `bun add @opentui/core @opentui/react` inside `tui/` and record the exact installed versions in `package.json` (no `^`/`~`). `tsconfig` strict + `jsx: react-jsx`.

- [ ] **Step 5: Implement `brailleChart` in `tui/src/chart.ts`**

Port `dashboard.braille_chart` exactly: filter non-finite, `lo/hi` guard (`hi = lo + 1`), `W = width*2, H = height*4`, same `dot` table and Bresenham-ish stepping, return `"(not enough history yet)"` / `"(not enough finite history yet)"` placeholders.

- [ ] **Step 6: Implement `types.ts` + `engine.ts` (`runCli`, envelope parse, timeout 15s, busy-retry)**

`runCli` spawns `python3 papertrade.py … --json` inheriting env (so `PAPERTRADE_DB` flows), 15s timeout, parses stdout JSON, throws `EngineError` on `ok:false`/bad JSON/timeout/missing python. On `database is locked|busy` retry once after 250ms. Thin wrappers call the exact existing CLI verbs with `--json` (e.g. `accounts`, `positions -a X`, `data snapshot`, `tick`, `backtest -a X --lookback-days N`, `perf`).

- [ ] **Step 7: Run tests to verify they pass**

Run: `bun test ./tui/tests/chart.test.ts ./tui/tests/engine.test.ts`
Expected: PASS, all tests green with mocked spawn only.

- [ ] **Step 8: Commit**

```bash
git add tui/package.json tui/tsconfig.json tui/bun.lock tui/src/types.ts tui/src/engine.ts tui/src/chart.ts tui/tests/engine.test.ts tui/tests/chart.test.ts
git commit -m "feat(tui): scaffold Bun app with engine bridge and chart port"
```

### Task 2: Read-only dashboard (panels, banner, refresh, keymap)

**Files:**
- Create: `tui/src/index.ts`, `tui/src/store.ts`, `tui/src/views/App.tsx`, `tui/src/views/PortfolioPanels.tsx`, `tui/src/views/StatusBar.tsx`, `tui/tests/dashboard.test.ts`
- Modify: none (no `papertrade.py` changes in this task)
- Test: `tui/tests/dashboard.test.ts`

**Interfaces:**
- Consumes: `snapshot/tick/marketClock` from Task 1 `tui/src/engine.ts`; `brailleChart` from Task 1 (for later backtest sparkline reuse).
- Produces: `tradingcli-tui` entry (`tui/src/index.ts` arg parse: `-a/--account`, `-n/--interval`, `--headless`, `--json`); `loadSnapshot()` in `store.ts` returning `{panels, quotes, clock, pending}` with prev-price tickmarks `▲/▼/·`.

- [ ] **Step 1: Install the OpenTUI skill docs (read-only setup for this task's deliverable)**

Run: `npx skills add anomalyco/opentui --skill opentui` (accepts docs-only install; needed so Task 2 uses accurate `@opentui/react` + keymap + lifecycle APIs).

- [ ] **Step 2: Write failing dashboard tests (mock engine, no rendering TTY)**

```tsx
// tui/tests/dashboard.test.ts
import { describe, expect, test } from "bun:test";
describe("dashboard store", () => {
  test("quote outage keeps cost basis and '?' markers", async () => {});
  test("pending stop/trailing_stop trigger text renders", async () => {});
  test("non-TTY without --headless exits with TTY message", async () => {});
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test ./tui/tests/dashboard.test.ts`
Expected: FAIL with "Cannot find module '../src/store'".

- [ ] **Step 4: Implement `store.ts` (`loadSnapshot`, prev-price map, pending trigger labels)**

Mirror `dashboard.snapshot/render` inputs: per-account cash/deposits/realized/positions/pending, quotes map with `null` on outage (render `?`/`~cost`), pending label port of `_pending_order_label` (`lim / stop / stop … / lim … / trail …`), tickmarks from prev map, auto-tick condition (any pending or expired OCC → `tick()` then re-snapshot once).

- [ ] **Step 5: Implement `App.tsx` + `PortfolioPanels.tsx` + `StatusBar.tsx` + `index.ts` loop**

`@opentui/react` tree: logo banner, market-clock strip (`Market open/closed` + `as of` stamp), per-account panels with the 8 columns (SYMBOL/SIDE/QTY/AVG COST/PRICE/MKT VALUE/UNREAL P&L/P&L %), stats grid (CASH/EQUITY/DAY/UNREAL/REALIZED/TOTAL), pending line, key hints. Refresh scheduler (`-n`, default 2.0s), keys `t` (tick), `r` (refresh), `q` (quit with renderer destroy in `finally`). Non-TTY guard unless `--headless`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test ./tui/tests/dashboard.test.ts ./tui/tests/engine.test.ts ./tui/tests/chart.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add tui/src/index.ts tui/src/store.ts tui/src/views/App.tsx tui/src/views/PortfolioPanels.tsx tui/src/views/StatusBar.tsx tui/tests/dashboard.test.ts
git commit -m "feat(tui): read-only dashboard with refresh loop and keymap"
```

### Task 3: Mutations, wizard, backtest view, headless JSON

**Files:**
- Create: `tui/src/views/OrderModal.tsx`, `tui/src/views/BacktestView.tsx`, `tui/src/headless.ts`, `tui/tests/modals.test.ts`, `tui/tests/backtest.test.ts`
- Modify: `tui/src/index.ts` (modal routing + `b/s/o/g/c/n/e/u` dispatch, first-run wizard gate)
- Test: `tui/tests/modals.test.ts`, `tui/tests/backtest.test.ts`

**Interfaces:**
- Consumes: Task 1 engine wrappers + Task 2 store/loop (`loadSnapshot`, refresh scheduler, keymap).
- Produces: `openOrderModal(kind: "buy"|"sell"|"option"|"cancel"|"new"|"rename"|"switch")`, `openBacktest(account, preset)`, `runHeadless(cmd: "snapshot"|"backtest") => Promise<void>` (prints single `{ok,…}` JSON, exit 0/1, no ANSI).

- [ ] **Step 1: Write failing modal/backtest tests**

```ts
// tui/tests/modals.test.ts + tui/tests/backtest.test.ts
import { describe, expect, test } from "bun:test";
describe("modals", () => {
  test("bad OCC date shows inline error with no state change", async () => {});
  test("non-numeric qty/limit aborts with inline error", async () => {});
  test("tick after mutation re-snapshots once", async () => {});
});
describe("backtest view", () => {
  test("ok backtest renders RETURN/CAGR/SHARPE-SORTINO + universe line", async () => {});
  test("no_positions renders message + hypothesis", async () => {});
  test("lifecycle restores terminal on Esc/q", async () => {});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test ./tui/tests/modals.test.ts ./tui/tests/backtest.test.ts`
Expected: FAIL with missing `OrderModal`/`BacktestView`/`headless` modules.

- [ ] **Step 3: Implement `OrderModal.tsx` + `index.ts` dispatch + first-run wizard**

OpenTUI `Input`/`Select` forms per kind (buy/sell: account/symbol/qty/limit; option: account/side/underlying/expiry/strike/contracts/limit; cancel/new/rename/switch), inline validation mirroring `prompt_*` messages (incl. `YYYY-MM-DD` OCC error), Esc aborts with no CLI call, success runs mutation then one re-snapshot (no `sleep`). First-run modal when zero accounts + no `setup_done` (name/cash/risk profile conservative/standard/unrestricted via CLI).

- [ ] **Step 4: Implement `BacktestView.tsx` (`g` flow)**

Preset select `6m/1y/2y/5y/10y/max` or days → concurrent `equityCurve()` + `backtest()` → side-by-side CURRENT PERFORMANCE vs CURRENT PORTFOLIO BACKTEST + BACKTEST DEFINITION notes (portfolio/universe/skipped/model/costs/caution). `chart.ts` sparklines with max/min labels. Enter/Esc returns to dashboard.

- [ ] **Step 5: Implement `headless.ts` (`--headless --json snapshot|backtest`)**

Prints one envelope JSON to stdout and exits (0/1), no ANSI/TTY required; `snapshot -a X` and `backtest -a X --lookback-days N` shapes match the CLI `--json` keys the TUI consumes.

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test ./tui/tests/modals.test.ts ./tui/tests/backtest.test.ts`
Expected: PASS (mocked engine; no real DB/network).

- [ ] **Step 7: Commit**

```bash
git add tui/src/views/OrderModal.tsx tui/src/views/BacktestView.tsx tui/src/headless.ts tui/src/index.ts tui/tests/modals.test.ts tui/tests/backtest.test.ts
git commit -m "feat(tui): mutations, setup wizard, backtest view, headless JSON"
```

### Task 4: Packaging, dash delegation, parity test, docs

**Files:**
- Create: `test_tui_parity.py`
- Modify: `papertrade.py:5061-5066` (`_run_cli` `dash` branch: default delegate to `bun tui/src/index.ts`, `--rich` keeps `dashboard.py`, pass through `-a/-n`), `pyproject.toml:32-35,40-41` (add `tradingcli-tui` script, drop `static/` from wheel include), `README.md:22-29,72-82` (TUI run section + Bun prereq, web SPA marked unsupported), `docs/agent-guide.md:11-15,131-140` (TUI row + headless recipe)
- Test: `test_tui_parity.py`

**Interfaces:**
- Consumes: Task 3 `runHeadless("snapshot"|"backtest")` output shape; Rich `dashboard.render` text (reference).
- Produces: `tradingcli-tui` console script; `tradingcli dash [--rich] [-a] [-n]` delegation; `test_tui_parity.py` standalone script (repo convention: `python3 test_tui_parity.py`, no pytest dependency).

- [ ] **Step 1: Write failing parity test**

```python
def test_tui_parity():
    # seed temp DB (PAPERTRADE_DB=tempfile), create account + pending stop/trailing-stop
    # run Rich dashboard.render to text
    # run `bun tui/src/index.ts --headless --json snapshot`
    # assert same account names, cash, symbols, pending ids, BACKTESTING markers
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 test_tui_parity.py`
Expected: FAIL with missing `tui/src/index.ts --headless` path or `tradingcli-tui` script.

- [ ] **Step 3: Implement `papertrade.py` dash delegation + `pyproject.toml` shim**

`_run_cli` `dash`: parse `--rich -a -n`, default `os.execv(bun, [bun, tui/src/index.ts, …])` with env passthrough; `--rich` execs `dashboard.py` as today. `pyproject` adds `tradingcli-tui = "papertrade:main_tui_shim"` (minimal shim that execs bun; no engine import) and removes `static/` from `include`.

- [ ] **Step 4: Update `README.md` + `docs/agent-guide.md`, keep `web_ui.py` file but unadvertised**

README: Bun >=1.4.1 prereq, `tradingcli-tui` / `tradingcli dash` / `--rich` fallback, headless recipe; web section replaced with one unsupported-notice line. Agent guide: TUI row updated, headless + MCP preference noted.

- [ ] **Step 5: Run full verification to confirm green**

Run: `bun test ./tui/tests/`
Expected: PASS.
Run: `python3 test_tui_parity.py`
Expected: PASS (`tui parity checks passed`).
Run: `python3 test_papertrade.py && python3 test_dashboard.py && python3 test_cli.py`
Expected: PASS (engine untouched; Rich fallback intact).

- [ ] **Step 6: Commit**

```bash
git add papertrade.py pyproject.toml README.md docs/agent-guide.md test_tui_parity.py
git commit -m "feat(tui): wire dash delegation, packaging, parity test, docs"
```
