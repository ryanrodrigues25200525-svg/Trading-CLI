// tui/tests/modals.test.ts — Task 3: mutation modals + setup wizard.
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { testRender } from "@opentui/react/test-utils";
import {
  buildModalArgs,
  emptyFields,
  needsFirstRun,
  submitModal,
  validateFields,
  OrderModal,
  type ModalFields,
  type SubmitDeps,
} from "../src/views/OrderModal";
import type { SpawnFn } from "../src/types";

function depsWith(calls: { runs: string[][]; resnapshots: number }): SubmitDeps {
  return {
    run: async (argv: string[]) => {
      calls.runs.push(argv);
      return { ok: true };
    },
    resnapshot: async () => {
      calls.resnapshots++;
    },
  };
}

describe("modals", () => {
  test("bad OCC date shows inline error with no state change", async () => {
    const fields: ModalFields = {
      ...emptyFields(),
      account: "main",
      side: "buy",
      underlying: "AAPL",
      expiry: "not-a-date",
      optionKind: "C",
      strike: "150",
      contracts: "1",
      limit: "",
    };
    const error = validateFields("option", fields);
    expect(error).toContain("YYYY-MM-DD");
    // Full submit path: validation failure performs no CLI call and no refresh.
    const calls = { runs: [] as string[][], resnapshots: 0 };
    const result = await submitModal("option", fields, depsWith(calls));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("YYYY-MM-DD");
    expect(calls.runs).toEqual([]);
    expect(calls.resnapshots).toBe(0);
  });

  test("non-numeric qty/limit aborts with inline error", async () => {
    const base: ModalFields = {
      ...emptyFields(),
      account: "main",
      symbol: "AAPL",
      qty: "abc",
      limit: "",
    };
    expect(validateFields("buy", base)).toBe("not a number, aborted");
    expect(validateFields("sell", { ...base, qty: "10", limit: "xyz" })).toBe(
      "not a number, aborted",
    );
    const calls = { runs: [] as string[][], resnapshots: 0 };
    expect((await submitModal("buy", base, depsWith(calls))).ok).toBe(false);
    expect(calls.runs).toEqual([]);
    expect(calls.resnapshots).toBe(0);
  });

  test("tick after mutation re-snapshots once", async () => {
    const fields: ModalFields = {
      ...emptyFields(),
      account: "main",
      symbol: "aapl",
      qty: "10",
      limit: "",
    };
    const calls = { runs: [] as string[][], resnapshots: 0 };
    const result = await submitModal("buy", fields, depsWith(calls));
    expect(result).toEqual({ ok: true });
    // Exactly one mutation CLI call, then exactly one re-snapshot (no sleep/tick).
    expect(calls.runs).toEqual([["buy", "AAPL", "10", "-a", "main"]]);
    expect(calls.resnapshots).toBe(1);
  });

  test("cancel passes only the order id (no -a flag)", async () => {
    const fields: ModalFields = { ...emptyFields(), orderId: "42" };
    expect(buildModalArgs("cancel", fields)).toEqual([
      ["order", "cancel", "42"],
    ]);
    const calls = { runs: [] as string[][], resnapshots: 0 };
    expect((await submitModal("cancel", fields, depsWith(calls))).ok).toBe(true);
    expect(calls.runs).toEqual([["order", "cancel", "42"]]);
    expect(calls.resnapshots).toBe(1);
  });

  test("setup wizard validates cash/profile like first_run_setup", async () => {
    expect(
      validateFields("setup", { ...emptyFields(), name: "", cash: "xyz", profile: "standard" }),
    ).toBe("starting cash must be a number — try again");
    expect(
      validateFields("setup", { ...emptyFields(), name: "main", cash: "100000", profile: "wild" }),
    ).toBe("unknown risk profile — try again");
    // Blank name defaults to main; conservative wires risk limits + setup_done.
    const argv = buildModalArgs("setup", {
      ...emptyFields(),
      name: "",
      cash: "100000",
      profile: "conservative",
    });
    expect(argv[0]).toEqual(["new", "main", "--cash", "100000"]);
    expect(argv[argv.length - 1]).toEqual(["config", "set", "setup_done", "1"]);
    expect(argv.some((a) => a[0] === "risk")).toBe(true);
  });

  test("OrderModal Esc aborts with no CLI call", async () => {
    const calls = { runs: [] as string[][], resnapshots: 0 };
    let closed = 0;
    let succeeded = 0;
    const setup = await testRender(
      createElement(OrderModal, {
        kind: "buy",
        defaultAccount: "main",
        onClose: () => closed++,
        onSuccess: () => succeeded++,
        deps: depsWith(calls),
      }),
      { width: 100, height: 30 },
    );
    try {
      const frame = await setup.waitForFrame((f) => f.includes("Buy order"));
      expect(frame).toContain("symbol");
      setup.mockInput.pressEscape();
      await new Promise((r) => setTimeout(r, 300));
      await setup.flush();
      expect(closed).toBe(1);
      expect(succeeded).toBe(0);
      expect(calls.runs).toEqual([]);
      expect(calls.resnapshots).toBe(0);
    } finally {
      setup.renderer.destroy();
    }
  });

  test("needsFirstRun gates on zero accounts + setup_done", async () => {
    const routes = (accounts: unknown, setupDone: string | null): SpawnFn =>
      async (argv) => {
        const cmd = argv.join(" ");
        if (cmd.includes("accounts")) {
          return { stdout: JSON.stringify(accounts), stderr: "", exitCode: 0 };
        }
        if (cmd.includes("config") && cmd.includes("get")) {
          if (setupDone === null) {
            return {
              stdout: "",
              stderr: JSON.stringify({ ok: false, error: "no config 'setup_done'" }),
              exitCode: 1,
            };
          }
          return {
            stdout: JSON.stringify({ ok: true, output: [setupDone] }),
            stderr: "",
            exitCode: 0,
          };
        }
        throw new Error(`unmocked CLI call: ${cmd}`);
      };
    expect(await needsFirstRun({ spawn: routes([], null) })).toBe(true);
    expect(await needsFirstRun({ spawn: routes([], "1") })).toBe(false);
    expect(
      await needsFirstRun({ spawn: routes([{ name: "main", cash: 1 }], null) }),
    ).toBe(false);
  });
});
