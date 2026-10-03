// tui/tests/engine.test.ts
import { describe, expect, test } from "bun:test";
import { runCli, EngineError } from "../src/engine";
import type { SpawnFn } from "../src/types";

const jsonSpawn = (payload: unknown): SpawnFn => async () => ({
  stdout: JSON.stringify(payload),
  stderr: "",
  exitCode: 0,
});

describe("engine envelope", () => {
  test("ok:false maps to EngineError", async () => {
    const spawn = jsonSpawn({ ok: false, error: "no account 'x'" });
    const err = await runCli(["accounts"], { spawn }).then(
      () => null,
      (e) => e
    );
    expect(err).toBeInstanceOf(EngineError);
    expect((err as EngineError).message).toContain("no account 'x'");
    expect((err as EngineError).command).toContain("accounts");
  });
  test("bad JSON maps to EngineError", async () => {
    const spawn: SpawnFn = async () => ({
      stdout: "not json at all",
      stderr: "Traceback (most recent call last): ...",
      exitCode: 1,
    });
    const err = await runCli(["tick"], { spawn }).then(
      () => null,
      (e) => e
    );
    expect(err).toBeInstanceOf(EngineError);
    expect((err as EngineError).command).toContain("tick");
  });
  test("timeout maps to EngineError", async () => {
    const spawn: SpawnFn = () => new Promise<never>(() => {});
    const err = await runCli(["tick"], { spawn, timeoutMs: 50 }).then(
      () => null,
      (e) => e
    );
    expect(err).toBeInstanceOf(EngineError);
    expect((err as EngineError).message).toMatch(/timed out/);
  });
  test("db busy retries once then surfaces busy message", async () => {
    let calls = 0;
    const busy = JSON.stringify({ ok: false, error: "database is locked" });
    const spawn: SpawnFn = async () => {
      calls++;
      return { stdout: busy, stderr: "", exitCode: 1 };
    };
    const err = await runCli(["tick"], { spawn }).then(
      () => null,
      (e) => e
    );
    expect(err).toBeInstanceOf(EngineError);
    expect((err as EngineError).message).toMatch(/database is locked/);
    expect(calls).toBe(2);
  });
  test("spawn failure maps to EngineError", async () => {
    const spawn: SpawnFn = async () => {
      throw new Error("ENOENT python3");
    };
    const err = await runCli(["tick"], { spawn }).then(
      () => null,
      (e) => e
    );
    expect(err).toBeInstanceOf(EngineError);
  });
  test("bare JSON array on stdout returns the payload", async () => {
    const rows = [{ name: "ira", cash: 100000 }];
    const spawn: SpawnFn = async () => ({
      stdout: JSON.stringify(rows),
      stderr: "",
      exitCode: 0,
    });
    expect(await runCli(["accounts"], { spawn })).toEqual(rows);
  });
  test("ok:false on stderr (empty stdout) surfaces the stderr error", async () => {
    const spawn: SpawnFn = async () => ({
      stdout: "",
      stderr: JSON.stringify({ ok: false, error: "no account 'x'" }),
      exitCode: 1,
    });
    const err = await runCli(["positions", "-a", "x"], { spawn }).then(
      () => null,
      (e) => e
    );
    expect(err).toBeInstanceOf(EngineError);
    expect((err as EngineError).message).toContain("no account 'x'");
  });
  test("ok:true output wrapper returns the output lines", async () => {
    const lines = ["#2 AAA: price 24.92, awaiting auction"];
    const spawn: SpawnFn = async () => ({
      stdout: JSON.stringify({ ok: true, output: lines }),
      stderr: "",
      exitCode: 0,
    });
    expect(await runCli(["tick"], { spawn })).toEqual(lines);
  });
  test("db busy on stderr retries once", async () => {
    let calls = 0;
    const spawn: SpawnFn = async () => {
      calls++;
      return {
        stdout: "",
        stderr: JSON.stringify({ ok: false, error: "database is busy" }),
        exitCode: 1,
      };
    };
    const err = await runCli(["tick"], { spawn }).then(
      () => null,
      (e) => e
    );
    expect(err).toBeInstanceOf(EngineError);
    expect((err as EngineError).message).toMatch(/database is busy/);
    expect(calls).toBe(2);
  });
});
