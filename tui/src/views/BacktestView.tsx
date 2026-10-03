// BacktestView: side-by-side current performance vs portfolio backtest, plus
// the BACKTEST DEFINITION notes. Text port of dashboard.py
// `backtesting_graphs_view` / `prompt_backtesting_graphs`: the same stats
// (RETURN/CAGR/SHARPE-SORTINO…), universe/skipped/model/costs/caution notes,
// and braille sparklines with max/min labels. Enter/Esc/q returns to the
// dashboard. Data comes only from the engine bridge (`perf` + `backtest`
// concurrently); the TS `parseLookbackDays` mirrors
// portfolio_backtest.parse_lookback_days, presets and error messages included.

import { useState } from "react";
import { useKeyboard } from "@opentui/react";
import { backtest, equityCurve, runCli } from "../engine";
import type { EngineOpts } from "../types";
import { brailleChart } from "../chart";

/** Mirrors portfolio_backtest.LOOKBACK_PRESETS (calendar days). */
export const LOOKBACK_PRESETS: Record<string, number> = {
  "6m": 183,
  "1y": 365,
  "2y": 730,
  "5y": 1825,
  "10y": 3650,
  max: 36500,
  all: 36500,
};

export const DEFAULT_LOOKBACK_DAYS = 1825;

/**
 * Parse a history preset (`6m/1y/2y/5y/10y/max`) or day count — same accepted
 * values and SystemExit messages as `parse_lookback_days`, as Error text.
 */
export function parseLookbackDays(value: string, dflt = DEFAULT_LOOKBACK_DAYS): number {
  const raw = (value ?? "").trim().toLowerCase();
  if (raw === "") return dflt;
  if (Object.hasOwn(LOOKBACK_PRESETS, raw)) return LOOKBACK_PRESETS[raw]!;
  let digits = raw;
  if (digits.endsWith("d")) digits = digits.slice(0, -1).trim();
  if (!/^\d+$/.test(digits)) {
    throw new Error("history must be 6m, 1y, 2y, 5y, 10y, max, or a number of days");
  }
  const days = parseInt(digits, 10);
  if (days < 2 || days > 36500) {
    throw new Error("history must be between 2 and 36500 days");
  }
  return days;
}

export interface BacktestMetrics {
  initial_equity?: number | null;
  final_equity?: number | null;
  return_pct?: number | null;
  cagr_pct?: number | null;
  max_drawdown_pct?: number | null;
  sharpe?: number | null;
  sortino?: number | null;
  annual_volatility_pct?: number | null;
  commissions?: number | null;
}

export interface BacktestSymbol {
  symbol: string;
}

export interface BacktestSkipped {
  symbol: string;
  reason: string;
}

export interface BacktestResult {
  status: string;
  account?: string;
  message?: string;
  hypothesis?: string;
  start?: string;
  end?: string;
  bars?: number;
  lookback_days?: number;
  commission_bps?: number;
  symbols?: Array<BacktestSymbol | string>;
  skipped?: BacktestSkipped[];
  curve?: Array<{ equity: number }>;
  metrics?: BacktestMetrics;
  warnings?: string[];
}

export interface BacktestData {
  account: string;
  lookbackDays: number;
  /** Verbatim `perf` output lines for the CURRENT PERFORMANCE panel. */
  performance: string[];
  backtest: BacktestResult;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

/** `perf` prints text (wrapped as `{ok:true, output:[lines]}`) → string lines. */
function asLines(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === "string") return value.split("\n");
  return [];
}

/**
 * Load both halves concurrently: current performance (`perf`) and the
 * portfolio backtest over the preset window. Throws EngineError on failure.
 */
export async function openBacktest(
  account: string | undefined,
  preset: string,
  opts: EngineOpts = {},
): Promise<BacktestData> {
  const lookbackDays = parseLookbackDays(preset ?? "");
  // Same argv the engine wrapper builds (`-a` omitted so the CLI resolves
  // the default account, mirroring prompt_backtesting_graphs).
  const backtestCall =
    account !== undefined && account !== ""
      ? backtest(account, lookbackDays, opts)
      : runCli(["backtest", "--lookback-days", String(lookbackDays)], opts);
  const [performance, result] = await Promise.all([
    equityCurve(account === "" ? undefined : account, opts).then(asLines),
    backtestCall.then((r) => asRecord(r) as unknown as BacktestResult),
  ]);
  return {
    account: account && account !== "" ? account : (result.account ?? ""),
    lookbackDays,
    performance,
    backtest: result,
  };
}

/** `_display_number`: NULL/non-finite renders as `—`, never blank. */
function disp(value: unknown, digits = 2, signed = false): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const text = value.toFixed(digits);
  return signed && value >= 0 ? `+${text}` : text;
}

function dispInt(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function dispMoney(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Python `:g` for the commission note (whole bps print without decimals). */
function pyG(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  if (Number.isInteger(value)) return String(value);
  return String(parseFloat(value.toPrecision(6)));
}

function symbolName(item: BacktestSymbol | string): string {
  return typeof item === "string" ? item : (item.symbol ?? "");
}

/** Sparkline group with max/min labels (mirror of `_chart_group`). */
function chartLines(values: number[]): string[] {
  if (values.length === 0) return ["No curve available."];
  const rows = brailleChart(values, 36, 9);
  return [dispInt(Math.max(...values)), ...rows, dispInt(Math.min(...values))];
}

/**
 * Full view as text lines (drives both the component and headless/tests):
 * CURRENT PERFORMANCE vs CURRENT PORTFOLIO BACKTEST + BACKTEST DEFINITION.
 */
export function backtestLines(data: BacktestData): string[] {
  const bt = data.backtest;
  const lines: string[] = [`BACKTESTING & GRAPHS — ${data.account.toUpperCase()}`, ""];
  lines.push("CURRENT PERFORMANCE");
  if (data.performance.length > 0) lines.push(...data.performance);
  else lines.push("No recorded activity yet.");
  lines.push("", "CURRENT PORTFOLIO BACKTEST");
  if (bt.status === "ok") {
    const m = bt.metrics ?? {};
    lines.push(`${bt.start ?? ""} → ${bt.end ?? ""} (${bt.bars ?? 0} bars)`);
    lines.push(...chartLines((bt.curve ?? []).map((p) => p.equity)));
    lines.push(`EQUITY ${dispInt(m.initial_equity)} → ${dispInt(m.final_equity)}`);
    lines.push(`RETURN ${disp(m.return_pct, 2, true)}%`);
    lines.push(`CAGR ${disp(m.cagr_pct, 2, true)}%`);
    lines.push(`MAX DD ${disp(m.max_drawdown_pct)}%`);
    lines.push(`SHARPE / SORTINO ${disp(m.sharpe)} / ${disp(m.sortino)}`);
    lines.push(`VOL / COSTS ${disp(m.annual_volatility_pct, 1)}% / ${dispMoney(m.commissions)}`);
  } else {
    lines.push(`${bt.start ?? ""} → ${bt.end ?? ""}`);
    lines.push(bt.message ?? "Backtest unavailable.");
    lines.push("Open positions in this portfolio will automatically become the backtest universe.");
  }
  lines.push("", "BACKTEST DEFINITION");
  lines.push(`PORTFOLIO ${data.account}`);
  const universe = (bt.symbols ?? []).map(symbolName).filter((s) => s !== "");
  lines.push(`UNIVERSE ${universe.length > 0 ? universe.join(", ") : "no eligible open positions"}`);
  const skipped = (bt.skipped ?? []).map((s) => `${s.symbol} (${s.reason})`);
  if (skipped.length > 0) lines.push(`SKIPPED ${skipped.join(", ")}`);
  lines.push(`MODEL ${bt.hypothesis ?? ""}`);
  lines.push(`COSTS ${pyG(bt.commission_bps ?? 0)} bps at synthetic entry and exit`);
  if (bt.warnings && bt.warnings.length > 0) lines.push(`CAUTION ${bt.warnings.join(" ")}`);
  return lines;
}

export interface BacktestViewProps {
  data: BacktestData;
  onClose: () => void;
}

/** Side-by-side panels; Enter/Esc/q returns to the dashboard. */
export function BacktestView({ data, onClose }: BacktestViewProps) {
  useKeyboard((key) => {
    if (key.name === "escape" || key.name === "return" || key.name === "enter" || key.name === "q") {
      onClose();
    }
  });
  return (
    <box flexDirection="column">
      <text>{backtestLines(data).join("\n")}</text>
      <text>(Enter/Esc) return to dashboard</text>
    </box>
  );
}

export interface BacktestPromptProps {
  defaultAccount?: string;
  spawn?: EngineOpts["spawn"];
  loader?: (account: string, preset: string) => Promise<BacktestData>;
  onClose: () => void;
  onPick: (data: BacktestData) => void;
}

/** Account + history prompt (mirror of `prompt_backtesting_graphs`). */
export function BacktestPrompt({
  defaultAccount,
  spawn,
  loader,
  onClose,
  onPick,
}: BacktestPromptProps) {
  const [account, setAccount] = useState(defaultAccount ?? "");
  const [history, setHistory] = useState("5y");
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useKeyboard((key) => {
    if (busy) return;
    if (key.name === "escape") onClose();
    else if (key.name === "tab") setActive((i) => (i + 1) % 2);
  });

  const submit = async () => {
    if (busy) return;
    try {
      parseLookbackDays(history); // throws on bad preset; openBacktest re-parses it
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    if (!account.trim()) {
      setError("no portfolio ''");
      return;
    }
    setBusy(true);
    try {
      const load =
        loader ?? ((a: string, preset: string) => openBacktest(a, preset, { spawn }));
      onPick(await load(account.trim(), history));
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^.*?: /, "") : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <box border borderStyle="single" title="▚ Backtesting & Graphs" flexDirection="column">
      <box flexDirection="row">
        <text>{"  which: "}</text>
        <input
          focused={active === 0}
          value={account}
          placeholder={defaultAccount ?? ""}
          onInput={setAccount}
          onSubmit={() => setActive(1)}
        />
      </box>
      <box flexDirection="row">
        <text>{"  history (6m/1y/2y/5y/10y/max or days) [5y]: "}</text>
        <input
          focused={active === 1}
          value={history}
          onInput={setHistory}
          onSubmit={() => void submit()}
        />
      </box>
      {busy ? <text>{"  reconstructing current performance and backtesting…"}</text> : null}
      {error !== null ? <text>{"  [!] "}{error}</text> : null}
      <text>{"  (Enter) next · (Esc) abort"}</text>
    </box>
  );
}
