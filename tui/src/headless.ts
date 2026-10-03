// Headless JSON: `tradingcli-tui --headless --json snapshot|backtest` for
// agents that cannot run a TUI. Prints a single `{ok, data|error}` envelope
// to stdout (no ANSI, no TTY required) and exits 0/1. Shapes match the CLI
// `--json` keys the TUI consumes: the full dashboard snapshot for `snapshot`
// (accounts, positions, pending, quotes, clock) and the perf-lines +
// backtest object for `backtest`.

import { EngineError } from "./engine";
import { loadSnapshot } from "./store";
import type { EngineOpts, SpawnFn } from "./types";
import { openBacktest } from "./views/BacktestView";

export type HeadlessCmd = "snapshot" | "backtest";

export interface HeadlessOpts {
  account?: string;
  lookbackDays?: number;
  spawn?: SpawnFn;
  timeoutMs?: number;
  write?: (text: string) => void;
  exit?: (code: number) => void;
}

/** Parse `--lookback-days N` (integer days, same 2..36500 bounds as the CLI). */
export function parseHeadlessLookback(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`invalid --lookback-days '${raw}': expected integer days`);
  }
  const days = parseInt(raw.trim(), 10);
  if (days < 2 || days > 36500) {
    throw new Error(`invalid --lookback-days '${raw}': expected 2..36500`);
  }
  return days;
}

/**
 * Run one headless command, print the envelope, and exit. `write`/`exit` are
 * injectable so tests capture output without killing the runner.
 */
export async function runHeadless(cmd: HeadlessCmd, opts: HeadlessOpts = {}): Promise<void> {
  const write = opts.write ?? ((text: string) => process.stdout.write(text));
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const engineOpts: EngineOpts = { spawn: opts.spawn, timeoutMs: opts.timeoutMs };
  try {
    let data: unknown;
    if (cmd === "snapshot") {
      data = await loadSnapshot({
        account: opts.account,
        spawn: engineOpts.spawn,
        timeoutMs: engineOpts.timeoutMs,
      });
    } else {
      data = await openBacktest(
        opts.account,
        String(opts.lookbackDays ?? 1825),
        engineOpts,
      );
    }
    write(`${JSON.stringify({ ok: true, data })}\n`);
    exit(0);
  } catch (e) {
    const message = e instanceof EngineError ? e.message : String(e);
    write(`${JSON.stringify({ ok: false, error: message })}\n`);
    exit(1);
  }
}
