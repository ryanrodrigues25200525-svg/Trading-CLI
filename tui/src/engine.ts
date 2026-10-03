// Engine bridge: every read/write goes through `python3 papertrade.py … --json`.
// This module never opens SQLite directly — `PAPERTRADE_DB` flows via the
// inherited environment. Success prints the command's own JSON on stdout;
// failures print `{ok: false, error}` on stderr with a nonzero exit.

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EngineError, type EngineOpts, type SpawnFn, type SpawnResult } from "./types";

export { EngineError };
export type { EngineOpts, Ok, SpawnFn, SpawnResult } from "./types";

export const ENGINE_TIMEOUT_MS = 15_000;
const BUSY_RETRY_MS = 250;

const HERE = dirname(fileURLToPath(import.meta.url));
/** Absolute path to the (unchanged) Python engine CLI. */
export const PAPER_TRADE_PY = join(HERE, "..", "..", "papertrade.py");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Production runner: one `python3 papertrade.py …` spawn via Bun.spawn. */
const defaultSpawn: SpawnFn = async (argv, opts) => {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, {
      stdout: "pipe",
      stderr: "pipe",
      env: process.env as Record<string, string | undefined>,
    });
  } catch (e) {
    throw new EngineError(
      `python3 not available: ${(e as Error).message}`,
      argv.join(" ")
    );
  }
  // Backstop: never leave the child lingering past the caller's timeout.
  const killTimer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      /* already exited */
    }
  }, opts.timeoutMs + 50);
  try {
    const { stdout, stderr } = proc;
    if (!(stdout instanceof ReadableStream) || !(stderr instanceof ReadableStream)) {
      throw new EngineError("engine produced no piped output", argv.join(" "));
    }
    const [outText, errText] = await Promise.all([
      new Response(stdout).text(),
      new Response(stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { stdout: outText, stderr: errText, exitCode };
  } finally {
    clearTimeout(killTimer);
  }
};

function describeCommand(fullArgs: string[]): string {
  return ["papertrade.py", ...fullArgs].join(" ");
}

/**
 * Run one engine command and return its payload.
 * Appends `--json`, enforces a 15s timeout, and retries once after 250ms
 * when SQLite reports `database is locked|busy`.
 *
 * Real CLI contract (verified against papertrade.py): success prints the
 * command's own JSON on stdout (usually a bare array/object; text output is
 * wrapped as `{"ok": true, "output": [...]}`), while failures print
 * `{"ok": false, "error": ...}` on stderr with a nonzero exit. Throws
 * EngineError on `ok:false`, bad JSON, timeout, or spawn failure.
 */
export async function runCli(
  args: string[],
  opts: EngineOpts = {}
): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? ENGINE_TIMEOUT_MS;
  const spawn = opts.spawn ?? defaultSpawn;
  const fullArgs = args.includes("--json") ? args : [...args, "--json"];
  const command = describeCommand(fullArgs);
  const argv = ["python3", PAPER_TRADE_PY, ...fullArgs];

  for (let attempt = 1; ; attempt++) {
    let res: SpawnResult;
    try {
      res = await Promise.race([
        spawn(argv, { timeoutMs }),
        sleep(timeoutMs).then((): SpawnResult => {
          throw new EngineError(`timed out after ${timeoutMs}ms`, command);
        }),
      ]);
    } catch (e) {
      if (e instanceof EngineError && e.command) throw e;
      throw new EngineError(
        `failed to spawn python3: ${(e as Error).message}`,
        command
      );
    }
    // fail() throws EngineError, except on the first busy error, when it
    // sleeps and returns so the caller can `continue` for exactly one retry.
    const fail = async (message: string): Promise<undefined> => {
      if (attempt === 1 && /database is (locked|busy)/i.test(message)) {
        await sleep(BUSY_RETRY_MS);
        return undefined;
      }
      throw new EngineError(message, command);
    };
    const failed = async (message: string): Promise<boolean> => {
      await fail(message);
      return true; // reached only via the busy-retry path (fail didn't throw)
    };

    let parsedStdout: unknown;
    let stdoutParses = false;
    try {
      parsedStdout = JSON.parse(res.stdout);
      stdoutParses = true;
    } catch {
      stdoutParses = false;
    }
    if (stdoutParses) {
      if (
        typeof parsedStdout === "object" &&
        parsedStdout !== null &&
        "ok" in parsedStdout
      ) {
        const envelope = parsedStdout as {
          ok: unknown;
          data?: unknown;
          output?: unknown;
          error?: unknown;
        };
        if (envelope.ok === true) {
          return "data" in envelope
            ? (envelope.data ?? null)
            : "output" in envelope
              ? envelope.output
              : parsedStdout;
        }
        if (envelope.ok === false) {
          const message =
            typeof envelope.error === "string" && envelope.error
              ? envelope.error
              : "unknown engine error";
          if (await failed(message)) continue;
        }
      } else if (res.exitCode === 0) {
        // Bare JSON payload (array/object/scalar, e.g. `accounts`, `market`).
        return parsedStdout;
      }
      // Else: parsed stdout but nonzero exit — fall through to stderr below.
    }
    // No usable stdout payload: the CLI reports failures on stderr as
    // `{"ok": false, "error": ...}` with a nonzero exit.
    let stderrMessage: string | null = null;
    try {
      const parsedStderr = JSON.parse(res.stderr) as {
        ok?: unknown;
        error?: unknown;
      };
      if (
        typeof parsedStderr === "object" &&
        parsedStderr !== null &&
        parsedStderr.ok === false
      ) {
        stderrMessage =
          typeof parsedStderr.error === "string" && parsedStderr.error
            ? parsedStderr.error
            : "unknown engine error";
      }
    } catch {
      /* not a JSON envelope on stderr either */
    }
    if (stderrMessage !== null) {
      if (await failed(stderrMessage)) continue;
    } else {
      const tail = `${res.stdout.trim()}${res.stderr.trim()}`.slice(-300);
      if (await failed(`engine failed (exit ${res.exitCode}${tail ? `: ${tail}` : ""})`)) continue;
    }
  }
}

/** Account overview (`accounts`), or one account's positions (`positions -a X`). */
export function snapshot(account?: string, opts: EngineOpts = {}): Promise<unknown> {
  return runCli(
    account ? ["positions", "-a", account] : ["accounts"],
    opts
  );
}

/** Evaluate pending orders against current prices. */
export function tick(opts: EngineOpts = {}): Promise<unknown> {
  return runCli(["tick"], opts);
}

export interface PlaceOrderArgs {
  side: "buy" | "sell";
  symbol: string;
  qty: number;
  account?: string;
  limit?: number;
}

/** Submit a simple market/limit buy or sell (`buy|sell SYM QTY [-a X] [--limit P]`). */
export function placeOrder(
  order: PlaceOrderArgs,
  opts: EngineOpts = {}
): Promise<unknown> {
  const args = [order.side, order.symbol, String(order.qty)];
  if (order.account) args.push("-a", order.account);
  if (order.limit !== undefined) args.push("--limit", String(order.limit));
  return runCli(args, opts);
}

/** Cancel one pending order (`order cancel <id>`). */
export function cancelOrder(
  orderId: number | string,
  opts: EngineOpts = {}
): Promise<unknown> {
  return runCli(["order", "cancel", String(orderId)], opts);
}

/** Backtest an account's current open positions over a lookback window. */
export function backtest(
  account: string,
  lookbackDays = 1825,
  opts: EngineOpts = {}
): Promise<unknown> {
  return runCli(
    ["backtest", "-a", account, "--lookback-days", String(lookbackDays)],
    opts
  );
}

/** Time-weighted performance since inception (`perf [-a X]`). */
export function equityCurve(
  account?: string,
  opts: EngineOpts = {}
): Promise<unknown> {
  return runCli(account ? ["perf", "-a", account] : ["perf"], opts);
}

/** NYSE status and next open/close (`market`). */
export function marketClock(opts: EngineOpts = {}): Promise<unknown> {
  return runCli(["market"], opts);
}
