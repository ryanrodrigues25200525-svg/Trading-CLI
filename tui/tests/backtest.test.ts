// tui/tests/backtest.test.ts — Task 3: backtest view + headless JSON.
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { testRender } from "@opentui/react/test-utils";
import {
  BacktestView,
  backtestLines,
  openBacktest,
  parseLookbackDays,
  type BacktestData,
} from "../src/views/BacktestView";
import type { SpawnFn } from "../src/types";

function okFixture(): BacktestData {
  return {
    account: "main",
    lookbackDays: 1825,
    performance: ["main  2024-01-01 → 2026-01-01  (731d)", "return   +12.34%   CAGR +5.67%"],
    backtest: {
      status: "ok",
      account: "main",
      start: "2021-01-04",
      end: "2025-12-31",
      bars: 1258,
      lookback_days: 1825,
      commission_bps: 10,
      hypothesis: "Today's open quantities and current cash were held unchanged.",
      symbols: [{ symbol: "AAPL" }, { symbol: "MSFT" }],
      skipped: [{ symbol: "ES=F", reason: "no history" }],
      curve: [
        { equity: 100000 },
        { equity: 110000 },
        { equity: 105000 },
        { equity: 120000 },
      ],
      metrics: {
        initial_equity: 100000,
        final_equity: 120000,
        return_pct: 20,
        cagr_pct: 4.5,
        max_drawdown_pct: 3.2,
        sharpe: 1.1,
        sortino: 1.4,
        annual_volatility_pct: 12.3,
        commissions: 45.67,
      },
      warnings: ["Look-ahead bias: holdings are known today."],
    },
  };
}

function emptyFixture(): BacktestData {
  return {
    account: "main",
    lookbackDays: 1825,
    performance: [],
    backtest: {
      status: "no_positions",
      account: "main",
      start: "2021-01-04",
      end: "2025-12-31",
      bars: 0,
      lookback_days: 1825,
      commission_bps: 10,
      message: "no eligible open positions",
      hypothesis: "Today's open quantities and current cash were held unchanged.",
      symbols: [],
      skipped: [],
      curve: [],
      metrics: {},
      warnings: [],
    },
  };
}

describe("backtest view", () => {
  test("ok backtest renders RETURN/CAGR/SHARPE-SORTINO + universe line", async () => {
    const data = okFixture();
    const text = backtestLines(data).join("\n");
    for (const token of [
      "CURRENT PERFORMANCE",
      "CURRENT PORTFOLIO BACKTEST",
      "RETURN",
      "CAGR",
      "SHARPE / SORTINO",
      "BACKTEST DEFINITION",
      "UNIVERSE",
      "AAPL, MSFT",
    ]) {
      expect(text).toContain(token);
    }
    let closed = 0;
    const setup = await testRender(
      createElement(BacktestView, { data, onClose: () => closed++ }),
      { width: 160, height: 50 },
    );
    try {
      const frame = await setup.waitForFrame((f) => f.includes("BACKTESTING"));
      expect(frame).toContain("RETURN");
      expect(frame).toContain("CAGR");
      expect(frame).toContain("SHARPE / SORTINO");
      expect(closed).toBe(0);
    } finally {
      setup.renderer.destroy();
    }
  });

  test("no_positions renders message + hypothesis", async () => {
    const text = backtestLines(emptyFixture()).join("\n");
    expect(text).toContain("no eligible open positions");
    expect(text).toContain("Today's open quantities and current cash were held unchanged.");
    const setup = await testRender(
      createElement(BacktestView, { data: emptyFixture(), onClose: () => {} }),
      { width: 160, height: 50 },
    );
    try {
      const frame = await setup.waitForFrame((f) => f.includes("BACKTESTING"));
      expect(frame).toContain("no eligible open positions");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("lifecycle restores terminal on Esc/q", async () => {
    let closed = 0;
    const setup = await testRender(
      createElement(BacktestView, { data: okFixture(), onClose: () => closed++ }),
      { width: 160, height: 50 },
    );
    try {
      await setup.waitForFrame((f) => f.includes("BACKTESTING"));
      setup.mockInput.pressEscape();
      await new Promise((r) => setTimeout(r, 300));
      await setup.flush();
      expect(closed).toBe(1);
    } finally {
      // Must not throw: raw-mode/TTY restored on destroy.
      setup.renderer.destroy();
    }
    expect(closed).toBe(1);
  });

  test("parseLookbackDays mirrors parse_lookback_days presets + errors", async () => {
    expect(parseLookbackDays("")).toBe(1825);
    expect(parseLookbackDays("6m")).toBe(183);
    expect(parseLookbackDays("1y")).toBe(365);
    expect(parseLookbackDays("2y")).toBe(730);
    expect(parseLookbackDays("5y")).toBe(1825);
    expect(parseLookbackDays("10y")).toBe(3650);
    expect(parseLookbackDays("max")).toBe(36500);
    expect(parseLookbackDays("90")).toBe(90);
    expect(parseLookbackDays("90d")).toBe(90);
    expect(() => parseLookbackDays("fortnight")).toThrow(
      "history must be 6m, 1y, 2y, 5y, 10y, max, or a number of days",
    );
    expect(() => parseLookbackDays("1")).toThrow(
      "history must be between 2 and 36500 days",
    );
  });

  test("openBacktest runs perf + backtest concurrently", async () => {
    const seen: string[][] = [];
    const spawn: SpawnFn = async (argv) => {
      const inner = argv.slice(2, argv.length - 1); // strip python3 papertrade.py + --json
      seen.push(inner);
      if (inner[0] === "perf") {
        return {
          stdout: JSON.stringify({ ok: true, output: ["main  2024 → 2026", "return +1.00%"] }),
          stderr: "",
          exitCode: 0,
        };
      }
      if (inner[0] === "backtest") {
        expect(inner).toEqual(["backtest", "-a", "main", "--lookback-days", "365"]);
        return {
          stdout: JSON.stringify({ status: "ok", metrics: {}, curve: [] }),
          stderr: "",
          exitCode: 0,
        };
      }
      throw new Error(`unmocked CLI call: ${inner.join(" ")}`);
    };
    const data = await openBacktest("main", "1y", { spawn });
    expect(data.account).toBe("main");
    expect(data.lookbackDays).toBe(365);
    expect(data.performance).toEqual(["main  2024 → 2026", "return +1.00%"]);
    expect(data.backtest.status).toBe("ok");
    const cmds = seen.map((a) => a[0]).sort();
    expect(cmds).toEqual(["backtest", "perf"]);
  });
});
