// Shared types for the tradingcli-tui engine bridge.
// The Python CLI (`papertrade.py … --json`) always replies with the envelope
// `{ok: true, data} | {ok: false, error}`; this module types that contract.

/** CLI JSON envelope: `{ok: true, data} | {ok: false, error}`. */
export type Ok<T> = { ok: true; data: T } | { ok: false; error: string };

/** Typed failure from the engine bridge (ok:false, timeout, bad JSON, spawn). */
export class EngineError extends Error {
  readonly command: string;
  constructor(message: string, command: string) {
    super(`${command}: ${message}`);
    this.name = "EngineError";
    this.command = command;
  }
}

/** Raw result of one child-process invocation. */
export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Injectable process runner (tests stub this; prod uses Bun.spawn). */
export type SpawnFn = (
  argv: string[],
  opts: { timeoutMs: number }
) => Promise<SpawnResult>;

/** Per-call options accepted by `runCli` and every engine wrapper. */
export interface EngineOpts {
  timeoutMs?: number;
  spawn?: SpawnFn;
}
