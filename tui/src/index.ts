// tradingcli-tui entry: arg parsing, TTY guard, headless JSON, render loop.

import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { createElement } from "react";
import { parseHeadlessLookback, runHeadless, type HeadlessCmd } from "./headless";
import { DEFAULT_LOOKBACK_DAYS } from "./views/BacktestView";
import { App } from "./views/App";

export interface TuiArgs {
  account?: string;
  interval: number;
  headless: boolean;
  json: boolean;
  /** Headless subcommand (`snapshot` default). */
  command?: HeadlessCmd;
  lookbackDays: number;
}

export const DEFAULT_INTERVAL = 2.0;
export const TTY_MESSAGE = "tradingcli-tui: need a TTY or --headless";

/** Parse `-a/--account`, `-n/--interval`, `--headless`, `--json`,
 * `--lookback-days N`, and one positional `snapshot|backtest` command. */
export function parseArgs(argv: string[]): TuiArgs {
  const args: TuiArgs = {
    account: undefined,
    interval: DEFAULT_INTERVAL,
    headless: false,
    json: false,
    command: undefined,
    lookbackDays: DEFAULT_LOOKBACK_DAYS,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-a" || a === "--account") {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for '${a}'`);
      args.account = v;
    } else if (a === "-n" || a === "--interval") {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v <= 0) {
        throw new Error(`invalid --interval '${argv[i]}': expected seconds > 0`);
      }
      args.interval = v;
    } else if (a === "--headless") {
      args.headless = true;
    } else if (a === "--json") {
      args.json = true;
    } else if (a === "--lookback-days") {
      const raw = argv[++i];
      if (raw === undefined) throw new Error(`missing value for '--lookback-days'`);
      args.lookbackDays = parseHeadlessLookback(raw)!;
    } else if (!a.startsWith("-")) {
      if (a !== "snapshot" && a !== "backtest") {
        throw new Error(`unknown argument '${a}' (expected 'snapshot' or 'backtest')`);
      }
      if (args.command !== undefined) throw new Error(`unexpected argument '${a}'`);
      args.command = a;
    } else {
      throw new Error(`unknown argument '${a}'`);
    }
  }
  return args;
}

/**
 * Non-TTY guard: without an interactive terminal the fullscreen renderer
 * would hang, so refuse unless --headless was given. Returns the stderr
 * message, or null when startup may proceed.
 */
export function ttyGuardMessage(stdinIsTTY: boolean, headless: boolean): string | null {
  if (!stdinIsTTY && !headless) return TTY_MESSAGE;
  return null;
}

async function main(): Promise<void> {
  let args: TuiArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`tradingcli-tui: ${(e as Error).message}\n`);
    process.exit(2);
  }
  if (args.headless) {
    // Single `{ok,…}` JSON envelope to stdout, exit 0/1, no ANSI/TTY.
    await runHeadless(args.command ?? "snapshot", {
      account: args.account,
      lookbackDays: args.lookbackDays,
    });
    return;
  }
  const guard = ttyGuardMessage(process.stdin.isTTY ?? false, args.headless);
  if (guard !== null) {
    process.stderr.write(`${guard}\n`);
    process.exit(1);
  }
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  let quitRequested = false;
  const requestQuit = () => {
    quitRequested = true;
  };
  try {
    createRoot(renderer).render(
      createElement(App, { account: args.account, intervalSec: args.interval, onQuit: requestQuit }),
    );
    const onSigint = () => {
      quitRequested = true;
    };
    process.on("SIGINT", onSigint);
    try {
      // Idle until a key handler or SIGINT asks to quit; the App owns its
      // own refresh scheduler, so the loop here only waits.
      while (!quitRequested) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } finally {
      process.off("SIGINT", onSigint);
    }
  } finally {
    renderer.destroy(); // restores raw-mode/TTY on quit, Ctrl-C, or error
  }
}

if (import.meta.main) {
  await main();
}
