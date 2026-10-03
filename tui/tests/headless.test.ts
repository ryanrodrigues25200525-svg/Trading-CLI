// tui/tests/headless.test.ts — Task 3: --headless JSON envelope.
import { describe, expect, test } from "bun:test";
import { parseHeadlessLookback, runHeadless } from "../src/headless";
import type { SpawnFn } from "../src/types";

function capture() {
  const out: string[] = [];
  const codes: number[] = [];
  return {
    out,
    codes,
    opts: {
      write: (text: string) => out.push(text),
      exit: (code: number) => codes.push(code),
    },
  };
}

/** Route one CLI argv to a canned payload (mirrors the real --json shapes). */
function mockCli(): SpawnFn {
  return async (argv) => {
    const cmd = argv.join(" ");
    if (cmd.includes("accounts")) {
      return {
        stdout: JSON.stringify([{ name: "main", cash: 100000, default: true }]),
        stderr: "",
        exitCode: 0,
      };
    }
    if (cmd.includes("positions")) {
      return { stdout: JSON.stringify([]), stderr: "", exitCode: 0 };
    }
    if (cmd.includes("order") && cmd.includes("list")) {
      return { stdout: JSON.stringify([]), stderr: "", exitCode: 0 };
    }
    if (cmd.includes("market")) {
      return {
        stdout: JSON.stringify({ is_open: false, transition: "open", next_transition: null }),
        stderr: "",
        exitCode: 0,
      };
    }
    if (/(^|\s)perf(\s|$)/.test(cmd)) {
      return {
        stdout: JSON.stringify({ ok: true, output: ["main  2024 → 2026", "return +1.00%"] }),
        stderr: "",
        exitCode: 0,
      };
    }
    if (cmd.includes("backtest")) {
      return {
        stdout: JSON.stringify({ status: "ok", account: "main", metrics: {}, curve: [] }),
        stderr: "",
        exitCode: 0,
      };
    }
    throw new Error(`unmocked CLI call: ${cmd}`);
  };
}

describe("headless", () => {
  test("snapshot prints one {ok:true} envelope and exits 0", async () => {
    const cap = capture();
    await runHeadless("snapshot", { spawn: mockCli(), ...cap.opts });
    expect(cap.codes).toEqual([0]);
    expect(cap.out).toHaveLength(1);
    const envelope = JSON.parse(cap.out[0]!);
    expect(envelope.ok).toBe(true);
    expect(envelope.data.panels).toHaveLength(1);
    expect(envelope.data.panels[0].name).toBe("main");
    expect(envelope.data.pending).toEqual([]);
    // No ANSI escape codes in headless output.
    expect(cap.out[0]).not.toContain("\u001b");
  });

  test("backtest prints perf + backtest shapes and exits 0", async () => {
    const cap = capture();
    await runHeadless("backtest", { account: "main", lookbackDays: 365, spawn: mockCli(), ...cap.opts });
    expect(cap.codes).toEqual([0]);
    const envelope = JSON.parse(cap.out[0]!);
    expect(envelope.ok).toBe(true);
    expect(envelope.data.account).toBe("main");
    expect(envelope.data.lookbackDays).toBe(365);
    expect(envelope.data.performance).toEqual(["main  2024 → 2026", "return +1.00%"]);
    expect(envelope.data.backtest.status).toBe("ok");
  });

  test("engine failure prints one {ok:false} envelope and exits 1", async () => {
    const cap = capture();
    const failing: SpawnFn = async () => ({
      stdout: "",
      stderr: JSON.stringify({ ok: false, error: "no account 'ghost'" }),
      exitCode: 1,
    });
    await runHeadless("snapshot", { account: "ghost", spawn: failing, ...cap.opts });
    expect(cap.codes).toEqual([1]);
    expect(cap.out).toHaveLength(1);
    const envelope = JSON.parse(cap.out[0]!);
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toContain("no account 'ghost'");
  });

  test("parseHeadlessLookback validates the day range", async () => {
    expect(parseHeadlessLookback(undefined)).toBeUndefined();
    expect(parseHeadlessLookback("365")).toBe(365);
    expect(() => parseHeadlessLookback("fortnight")).toThrow("invalid --lookback-days");
    expect(() => parseHeadlessLookback("1")).toThrow("invalid --lookback-days");
  });
});
