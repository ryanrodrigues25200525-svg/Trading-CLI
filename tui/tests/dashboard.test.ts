// tui/tests/dashboard.test.ts
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { testRender } from "@opentui/react/test-utils";
import { loadSnapshot, pendingOrderLabel } from "../src/store";
import { App, shortError } from "../src/views/App";
import { gainFg, sideSeg, signedSeg, tickSeg } from "../src/views/PortfolioPanels";
import type { AccountPanel, DashboardSnapshot } from "../src/store";
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
  tickFails?: boolean;
  onTick?: () => void;
}): SpawnFn {
  return async (argv) => {
    const cmd = argv.join(" ");
    if (/(^|\s)tick(\s|--json|$)/.test(cmd) && !cmd.includes("snapshot")) {
      if (routes.tickFails) {
        return {
          stdout: "",
          stderr: JSON.stringify({ ok: false, error: "YFRateLimitError: Too Many Requests. Rate limited. Try after a while." }),
          exitCode: 1,
        };
      }
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
    expect(parseArgs([])).toEqual({
      account: undefined,
      interval: 2.0,
      headless: false,
      json: false,
      command: undefined,
      lookbackDays: 1825,
    });
    expect(parseArgs(["-a", "main", "-n", "5"])).toEqual({
      account: "main",
      interval: 5,
      headless: false,
      json: false,
      command: undefined,
      lookbackDays: 1825,
    });
    expect(parseArgs(["--account", "ira", "--interval", "1.5", "--headless", "--json"])).toEqual({
      account: "ira",
      interval: 1.5,
      headless: true,
      json: true,
      command: undefined,
      lookbackDays: 1825,
    });
    expect(parseArgs(["--headless", "--json", "snapshot", "-a", "ira"])).toEqual({
      account: "ira",
      interval: 2.0,
      headless: true,
      json: true,
      command: "snapshot",
      lookbackDays: 1825,
    });
    expect(parseArgs(["--headless", "backtest", "--lookback-days", "365"])).toEqual({
      account: undefined,
      interval: 2.0,
      headless: true,
      json: false,
      command: "backtest",
      lookbackDays: 365,
    });
    expect(() => parseArgs(["bogus"])).toThrow("unknown argument");
    expect(() => parseArgs(["--lookback-days", "fortnight"])).toThrow("--lookback-days");
    // End-to-end: --headless prints one {ok,…} envelope to stdout and exits
    // 0 (Task 3 replaced the stub with the real headless implementation).
    // Fresh temp DB → zero accounts, fully offline (market clock is local).
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const tuiRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const dbPath = join(mkdtempSync(join(tmpdir(), "tui-headless-")), "test.db");
    const proc = Bun.spawn(
      [process.execPath, join(tuiRoot, "src/index.ts"), "--headless", "--json", "snapshot"],
      {
        cwd: tuiRoot,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PAPERTRADE_DB: dbPath },
      },
    );
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    expect(err).not.toContain("headless mode lands in Task 3");
    expect(code).toBe(0);
    const envelope = JSON.parse(out.trim().split("\n").at(-1)!);
    expect(envelope.ok).toBe(true);
    expect(envelope.data.panels).toEqual([]);
    expect(out).not.toContain("\u001b");
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

describe("shortError (engine error display)", () => {
  test("single-line errors pass through untouched", () => {
    expect(shortError("no account 'ghost'")).toBe("no account 'ghost'");
    expect(shortError("risk rejected: short positions are disabled")).toBe(
      "risk rejected: short positions are disabled",
    );
  });

  test("traceback dumps collapse to the informative last line", () => {
    const dump = [
      "papertrade.py tick --json: engine failed (exit 1: *args, **kwargs)",
      '  File "pt.py", line 506, in _make_request',
      "    raise CustomError()",
      "pt.CustomError: something specific broke at the end",
    ].join("\n");
    expect(shortError(dump)).toBe("pt.CustomError: something specific broke at the end");
  });

  test("rate-limit maps to a human sentence", () => {
    expect(shortError("YFRateLimitError: Too Many Requests. Rate limited.")).toMatch(
      /rate-limiting quotes/i,
    );
    expect(shortError("database is locked")).toMatch(/retrying/i);
  });

  test("very long lines are capped", () => {
    expect(shortError(`x: ${"y".repeat(500)}`).length).toBeLessThanOrEqual(210);
  });
});

describe("panel structure", () => {
  test("header rule spans the table width", async () => {
    const { tableWidth } = await import("../src/views/PortfolioPanels");
    expect(tableWidth()).toBe(14 + 6 + 9 + 10 + 13 + 12 + 12 + 10 + 7);
  });

  test("stat cells align label and value columns", async () => {
    const { statCell } = await import("../src/views/PortfolioPanels");
    const text = (segs: Array<{ t: string }>) => segs.map((s) => s.t).join("");
    const a = text(statCell("CASH", { t: "100,000.00" }, 30));
    const b = text(statCell("EQUITY", { t: "99,999.99" }, 30));
    expect(a.length).toBe(30);
    expect(b.length).toBe(30);
    expect(a).toBe(`CASH${" ".repeat(16)}100,000.00`);
    expect(b).toBe(`EQUITY${" ".repeat(15)}99,999.99`);
  });
});

describe("panel colors", () => {
  test("gains green, losses red, zero counts as gain", () => {
    expect(gainFg(1.5)).toBe("green");
    expect(gainFg(-0.01)).toBe("#ff2b4a");
    expect(gainFg(0)).toBe("green");
  });

  test("side and tickmark colors", () => {
    expect(sideSeg(true)).toEqual({ t: "LONG", fg: "green" });
    expect(sideSeg(false)).toEqual({ t: "SHORT", fg: "#ff2b4a" });
    expect(tickSeg("▲")).toEqual({ t: "▲", fg: "green" });
    expect(tickSeg("▼")).toEqual({ t: "▼", fg: "#ff2b4a" });
    expect(tickSeg("·")).toEqual({ t: "·", fg: "#808080" });
  });

  test("signed segments carry color, nulls are grey ?", () => {
    expect(signedSeg(12.5)).toEqual({ t: "+12.50", fg: "green" });
    expect(signedSeg(-3)).toEqual({ t: "-3.00", fg: "#ff2b4a" });
    expect(signedSeg(null)).toEqual({ t: "?", fg: "#808080" });
    expect(signedSeg(8, "%")).toEqual({ t: "+8.00%", fg: "green" });
  });
});

describe("quote cache (Yahoo rate-limit)", () => {
  // Display quotes are 15-minute delayed (QUOTE_TTL_MS); tests pin it
  // with literals plus nowMs control so no real waiting is involved.
  const QUARTER_HOUR = 900_000;
  const CACHE_BOOK = {
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
    quotes: { MSFT: { quote: { last: 101 }, previous_close: 99 } },
  };

  function countingSpawn(base: SpawnFn) {
    const counts = { quotes: 0, ticks: 0 };
    const spawn: SpawnFn = async (argv, opts) => {
      const cmd = argv.join(" ");
      if (cmd.includes("data") && cmd.includes("snapshot")) counts.quotes++;
      if (/(^|\s)tick(\s|--json|$)/.test(cmd) && !cmd.includes("snapshot")) counts.ticks++;
      return base(argv, opts);
    };
    return { spawn, counts };
  }

  test("second refresh within TTL spawns no new quote calls", async () => {
    const { spawn, counts } = countingSpawn(mockCli(CACHE_BOOK));
    const first = await loadSnapshot({ spawn, nowMs: 1_000_000 });
    expect(first.quotes["MSFT"]?.[0]).toBeCloseTo(101, 6);
    expect(counts.quotes).toBe(1);
    const second = await loadSnapshot({ spawn, nowMs: 1_000_000 });
    expect(second.quotes["MSFT"]?.[0]).toBeCloseTo(101, 6);
    expect(counts.quotes).toBe(1);
  });

  test("expired TTL refetches quotes", async () => {
    const { spawn, counts } = countingSpawn(mockCli(CACHE_BOOK));
    await loadSnapshot({ spawn, nowMs: 1_000_000 });
    expect(counts.quotes).toBe(1);
    const later = await loadSnapshot({ spawn, nowMs: 1_000_000 + QUARTER_HOUR + 1 });
    expect(later.quotes["MSFT"]?.[0]).toBeCloseTo(101, 6);
    expect(counts.quotes).toBe(2);
  });

  test("freshQuotes bypasses the cache", async () => {
    const { spawn, counts } = countingSpawn(mockCli(CACHE_BOOK));
    await loadSnapshot({ spawn, nowMs: 1_000_000 });
    await loadSnapshot({ spawn, nowMs: 1_000_000, freshQuotes: true });
    expect(counts.quotes).toBe(2);
  });

  test("outage nulls are cached, not re-fetched", async () => {
    const { spawn, counts } = countingSpawn(mockCli({ ...CACHE_BOOK, quotes: {} }));
    const first = await loadSnapshot({ spawn, nowMs: 1_000_000 });
    expect(first.quotes["MSFT"]).toBeNull();
    expect(counts.quotes).toBe(1);
    const second = await loadSnapshot({ spawn, nowMs: 1_000_000 });
    expect(second.quotes["MSFT"]).toBeNull();
    expect(counts.quotes).toBe(1);
  });

  test("post-tick re-snapshot is fresh even within TTL", async () => {    let ticks = 0;
    const { spawn, counts } = countingSpawn(
      mockCli({
        ...CACHE_BOOK,
        orders: [
          {
            id: 1, account: "main", symbol: "MSFT", side: "sell", qty: 1.0,
            order_type: "stop", limit_price: null, stop_price: 95,
            trail_price: null, trail_percent: null, time_in_force: "gtc", status: "pending",
          },
        ],
        onTick: () => ticks++,
      }),
    );
    const snap = await loadSnapshot({ spawn, nowMs: 1_000_000 });
    expect(ticks).toBe(1);
    // Pre-tick fetchAll + post-tick fresh re-snapshot: one quote call each.
    expect(counts.quotes).toBe(2);
    expect(snap.quotes["MSFT"]?.[0]).toBeCloseTo(101, 6);
  });

  test("tick failure still returns panels with tickError set", async () => {
    const spawn = mockCli({
      ...CACHE_BOOK,
      orders: [
        {
          id: 9, account: "main", symbol: "MSFT", side: "buy", qty: 1.0,
          order_type: "limit", limit_price: 350, stop_price: null,
          trail_price: null, trail_percent: null, time_in_force: "gtc", status: "pending",
        },
      ],
      tickFails: true,
    });
    const snap = await loadSnapshot({ spawn, nowMs: 1_000_000 });
    expect(snap.panels).toHaveLength(1);
    expect(snap.panels[0]!.name).toBe("main");
    expect(snap.tickError).toMatch(/rate limit/i);
  });

  test("tick failure keeps pre-tick pending list", async () => {
    const spawn = mockCli({
      ...CACHE_BOOK,
      orders: [
        {
          id: 9, account: "main", symbol: "MSFT", side: "buy", qty: 1.0,
          order_type: "limit", limit_price: 350, stop_price: null,
          trail_price: null, trail_percent: null, time_in_force: "gtc", status: "pending",
        },
      ],
      tickFails: true,
    });
    const snap = await loadSnapshot({ spawn, nowMs: 1_000_000 });
    expect(snap.pending).toHaveLength(1);
    expect(snap.pending[0]!.label).toContain("#9");
    expect(snap.tickError).not.toBeNull();
  });

  test("failed auto-tick backs off for a minute", async () => {
    const base = mockCli({
      ...CACHE_BOOK,
      orders: [
        {
          id: 9, account: "main", symbol: "MSFT", side: "buy", qty: 1.0,
          order_type: "limit", limit_price: 350, stop_price: null,
          trail_price: null, trail_percent: null, time_in_force: "gtc", status: "pending",
        },
      ],
      tickFails: true,
    });
    const { spawn, counts } = countingSpawn(base);
    const first = await loadSnapshot({ spawn, nowMs: 1_000_000 });
    expect(counts.ticks).toBe(1);
    expect(first.tickError).not.toBeNull();
    expect(counts.quotes).toBe(2); // pre-tick fetch + post-failure fresh re-snapshot
    // 30s later: no new tick attempt, no new quote calls, error retained.
    const second = await loadSnapshot({ spawn, nowMs: 1_000_000 + 30_000 });
    expect(counts.ticks).toBe(1);
    expect(second.panels).toHaveLength(1);
    expect(second.tickError).not.toBeNull();
    expect(counts.quotes).toBe(2);
  });

  test("auto-tick retries after the cooldown", async () => {
    const { spawn, counts } = countingSpawn(
      mockCli({
        ...CACHE_BOOK,
        orders: [
          {
            id: 9, account: "main", symbol: "MSFT", side: "buy", qty: 1.0,
            order_type: "limit", limit_price: 350, stop_price: null,
            trail_price: null, trail_percent: null, time_in_force: "gtc", status: "pending",
          },
        ],
        tickFails: true,
      }),
    );
    await loadSnapshot({ spawn, nowMs: 1_000_000 });
    expect(counts.ticks).toBe(1);
    await loadSnapshot({ spawn, nowMs: 1_000_000 + 61_000 });
    expect(counts.ticks).toBe(2);
  });
});

describe("app error display", () => {
  const emptySnap = (tickError: string | null): DashboardSnapshot => ({
    panels: [],
    quotes: {},
    clock: { isOpen: false, transition: "open", eastern: "" },
    pending: [],
    asOf: "00:00:00",
    tickError,
  });

  test("transient tick notice renders subtle, without the red error box", async () => {
    const setup = await testRender(
      createElement(App, {
        loader: async () =>
          emptySnap("YFRateLimitError: Too Many Requests. Rate limited."),
        checkFirstRun: async () => false,
      }),
      { width: 120, height: 20 },
    );
    try {
      const frame = await setup.waitForFrame((f) => f.includes("rate-limiting"));
      expect(frame).not.toContain("engine error");
      expect(frame).toContain("◌");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("hard refresh failure still shows the red error box", async () => {
    const setup = await testRender(
      createElement(App, {
        loader: async () => {
          throw new Error("no account 'ghost'");
        },
        checkFirstRun: async () => false,
      }),
      { width: 120, height: 20 },
    );
    try {
      const frame = await setup.waitForFrame((f) => f.includes("engine error"));
      expect(frame).toContain("no account");
    } finally {
      setup.renderer.destroy();
    }
  });
});
