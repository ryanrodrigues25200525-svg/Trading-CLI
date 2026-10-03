// tui/tests/dashboard.test.ts
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { testRender } from "@opentui/react/test-utils";
import { loadSnapshot, pendingOrderLabel } from "../src/store";
import type { AccountPanel } from "../src/store";
import { parseArgs, ttyGuardMessage } from "../src/index";
import { PortfolioPanels } from "../src/views/PortfolioPanels";
import { StatusBar } from "../src/views/StatusBar";
import type { SpawnFn } from "../src/types";

/** Route one CLI argv to a canned payload (mirrors the real papertrade.py shapes). */
function mockCli(routes: {
  accounts?: unknown;
  positions?: unknown;
  orders?: unknown;
  quotes?: Record<string, unknown>;
  market?: unknown;
  onTick?: () => void;
}): SpawnFn {
  return async (argv) => {
    const cmd = argv.join(" ");
    if (/(^|\s)tick(\s|--json|$)/.test(cmd) && !cmd.includes("snapshot")) {
      routes.onTick?.();
      return { stdout: JSON.stringify({ ok: true, output: ["tick ok"] }), stderr: "", exitCode: 0 };
    }
    if (cmd.includes("accounts")) {
      return { stdout: JSON.stringify(routes.accounts ?? []), stderr: "", exitCode: 0 };
    }
    if (cmd.includes("positions")) {
      return { stdout: JSON.stringify(routes.positions ?? []), stderr: "", exitCode: 0 };
    }
    if (cmd.includes("order") && cmd.includes("list")) {
      return { stdout: JSON.stringify(routes.orders ?? []), stderr: "", exitCode: 0 };
    }
    if (cmd.includes("data") && cmd.includes("snapshot")) {
      const sym = argv[argv.indexOf("snapshot") + 1] as string;
      const hit = routes.quotes?.[sym];
      if (hit === undefined) {
        // Quote outage: engine reports failure on stderr, no usable payload.
        return {
          stdout: "",
          stderr: JSON.stringify({ ok: false, error: `no quote for ${sym}` }),
          exitCode: 1,
        };
      }
      return { stdout: JSON.stringify(hit), stderr: "", exitCode: 0 };
    }
    if (cmd.includes("market")) {
      return {
        stdout: JSON.stringify(
          routes.market ?? { is_open: false, transition: "open", next_transition: null },
        ),
        stderr: "",
        exitCode: 0,
      };
    }
    throw new Error(`unmocked CLI call: ${cmd}`);
  };
}

describe("dashboard store", () => {
  test("quote outage keeps cost basis and '?' markers", async () => {
    let ticks = 0;
    const spawn = mockCli({
      accounts: [{ name: "main", cash: 24900, default: true }],
      positions: [
        {
          account: "main",
          symbol: "MSFT",
          side: "long",
          qty: 1.0,
          signed_qty: 1.0,
          avg_entry_price: 100,
          multiplier: 1.0,
          asset_class: "spot",
          margin: 0.0,
        },
      ],
      orders: [],
      quotes: {}, // total outage: every symbol lookup fails
      onTick: () => ticks++,
    });
    const snap = await loadSnapshot({ spawn });
    expect(snap.panels).toHaveLength(1);
    const panel = snap.panels[0]!;
    expect(panel.name).toBe("main");
    expect(panel.positions).toHaveLength(1);
    const row = panel.positions[0]!;
    expect(row.outage).toBe(true);
    expect(row.price).toBeNull();
    expect(row.unreal).toBeNull();
    // Cost-basis equity retained: 24,900 cash + 1 MSFT @ 100 avg.
    expect(panel.equity).toBeCloseTo(25000, 6);
    expect(snap.quotes["MSFT"]).toBeNull();
    expect(ticks).toBe(0); // no pending, no expired OCC → no auto-tick
  });

  test("pending stop/trailing_stop trigger text renders", async () => {
    let ticks = 0;
    const spawn = mockCli({
      accounts: [{ name: "main", cash: 24900, default: true }],
      positions: [
        {
          account: "main",
          symbol: "MSFT",
          side: "long",
          qty: 1.0,
          signed_qty: 1.0,
          avg_entry_price: 100,
          multiplier: 1.0,
          asset_class: "spot",
          margin: 0.0,
        },
      ],
      orders: [
        {
          id: 1, account: "main", symbol: "MSFT", side: "sell", qty: 1.0,
          order_type: "stop", limit_price: null, stop_price: 95,
          trail_price: null, trail_percent: null, time_in_force: "gtc", status: "pending",
        },
        {
          id: 2, account: "main", symbol: "MSFT", side: "sell", qty: 1.0,
          order_type: "trailing_stop", limit_price: null, stop_price: 94,
          trail_price: null, trail_percent: 5, time_in_force: "gtc", status: "pending",
        },
      ],
      quotes: {
        MSFT: { quote: { last: 101 }, previous_close: 99 },
      },
      onTick: () => ticks++,
    });
    const snap = await loadSnapshot({ spawn });
    const panel = snap.panels[0]!;
    expect(panel.pending).toHaveLength(2);
    expect(panel.pending[0]!.label).toBe("#1 sell 1 MSFT stop 95.00 gtc");
    expect(panel.pending[1]!.label).toBe("#2 sell 1 MSFT trail 5.00% (stop 94.00) gtc");
    expect(snap.pending).toHaveLength(2);
    // Pending orders exist → auto-tick ran once before the snapshot.
    expect(ticks).toBe(1);
    // Quoted row carries tickmarks/prev-close state.
    const row = panel.positions[0]!;
    expect(row.outage).toBe(false);
    expect(row.price).toBeCloseTo(101, 6);
    expect(row.tickmark).toBe("·"); // no prev map on first load
    const second = await loadSnapshot({ spawn, prev: { MSFT: 90 } });
    expect(second.panels[0]!.positions[0]!.tickmark).toBe("▲");
    const third = await loadSnapshot({ spawn, prev: { MSFT: 200 } });
    expect(third.panels[0]!.positions[0]!.tickmark).toBe("▼");
  });

  test("pendingOrderLabel ports every dashboard._pending_order_label kind", () => {
    const base = { id: 7, side: "buy", qty: 2, symbol: "AAPL", tif: "day" };
    expect(
      pendingOrderLabel({ ...base, kind: "limit", limit: 50, stop: null, trail: null, trailPct: null }),
    ).toBe("#7 buy 2 AAPL lim 50.00 day");
    expect(
      pendingOrderLabel({ ...base, kind: "stop_limit", limit: 51, stop: 49, trail: null, trailPct: null }),
    ).toBe("#7 buy 2 AAPL stop 49.00 / lim 51.00 day");
    expect(
      pendingOrderLabel({ ...base, kind: "trailing_stop", limit: null, stop: null, trail: 94, trailPct: null }),
    ).toBe("#7 buy 2 AAPL trail 94.00 day");
    expect(
      pendingOrderLabel({ ...base, kind: "market", limit: null, stop: null, trail: null, trailPct: null }),
    ).toBe("#7 buy 2 AAPL market day");
    expect(
      pendingOrderLabel({ ...base, kind: "limit", limit: null, stop: null, trail: null, trailPct: null }),
    ).toContain("lim —");
  });

  test("non-TTY without --headless exits with TTY message", async () => {
    expect(ttyGuardMessage(false, false)).toContain("--headless");
    expect(ttyGuardMessage(false, true)).toBeNull();
    expect(ttyGuardMessage(true, false)).toBeNull();
    expect(parseArgs([])).toEqual({ account: undefined, interval: 2.0, headless: false, json: false });
    expect(parseArgs(["-a", "main", "-n", "5"])).toEqual({
      account: "main",
      interval: 5,
      headless: false,
      json: false,
    });
    expect(parseArgs(["--account", "ira", "--interval", "1.5", "--headless", "--json"])).toEqual({
      account: "ira",
      interval: 1.5,
      headless: true,
      json: true,
    });
    // End-to-end: --headless exits 2 before any engine/TTY work (Ruling 2).
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const tuiRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const proc = Bun.spawn([process.execPath, join(tuiRoot, "src/index.ts"), "--headless"], {
      cwd: tuiRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    expect(code).toBe(2);
    expect(err + out).toContain("headless mode lands in Task 3");
  });
});

describe("dashboard views", () => {
  const panel: AccountPanel = {
    name: "main",
    cash: 24900,
    deposits: 25000,
    realized: 0,
    equity: 25000,
    day: 0,
    unreal: 100,
    total: 100,
    retPct: 0.4,
    positions: [
      {
        symbol: "MSFT", long: true, qty: 1, avgCost: 100, mult: 1,
        assetClass: "spot", price: null, prevClose: null,
        marketValue: 100, costBasis: 100, unreal: null, pct: null,
        tickmark: "·", outage: true,
      },
      {
        symbol: "AAPL", long: true, qty: 10, avgCost: 150, mult: 1,
        assetClass: "spot", price: 160, prevClose: 158,
        marketValue: 1600, costBasis: 1500, unreal: 100, pct: 6.6666667,
        tickmark: "▲", outage: false,
      },
    ],
    pending: [
      {
        id: 1, side: "sell", qty: 1, symbol: "MSFT", kind: "stop",
        limit: null, stop: 95, trail: null, trailPct: null, tif: "gtc",
        label: "#1 sell 1 MSFT stop 95.00 gtc",
      },
    ],
    isDefault: true,
  };

  test("panels render 8 columns, stats grid, and pending line", async () => {
    const setup = await testRender(createElement(PortfolioPanels, { panels: [panel] }), {
      width: 150,
      height: 30,
    });
    try {
      const frame = await setup.waitForFrame((f) => f.includes("SYMBOL"));
      for (const col of ["SYMBOL", "SIDE", "QTY", "AVG COST", "PRICE", "MKT VALUE", "UNREAL P&L", "P&L %"]) {
        expect(frame).toContain(col);
      }
      for (const stat of ["CASH", "EQUITY", "DAY", "UNREAL", "REALIZED", "TOTAL"]) {
        expect(frame).toContain(stat);
      }
      // Outage row keeps cost basis with `?` markers; quoted row shows ▲.
      expect(frame).toContain("?");
      expect(frame).toContain("~100.00");
      expect(frame).toContain("▲");
      expect(frame).toContain("◌ pending:");
      expect(frame).toContain("#1 sell 1 MSFT stop 95.00 gtc");
      expect(frame).toContain("MAIN");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("status bar shows market-clock banner and key hints", async () => {
    const setup = await testRender(
      createElement(StatusBar, {
        clock: { isOpen: false, transition: "open", eastern: "2026-10-05T09:30-04:00" },
        asOf: "20:26:16",
      }),
      { width: 150, height: 10 },
    );
    try {
      const frame = await setup.waitForFrame((f) => f.includes("Market closed"));
      expect(frame).toContain("Market closed");
      expect(frame).toContain("next open 09:30 ET");
      expect(frame).toContain("as of 20:26:16");
      expect(frame).toContain("q Quit");
      expect(frame).toContain("t Tick");
    } finally {
      setup.renderer.destroy();
    }
  });
});
