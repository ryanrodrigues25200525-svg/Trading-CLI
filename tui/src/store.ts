// Dashboard store: read-only snapshot assembly over the Task 1 engine bridge.
// Mirrors dashboard.py `snapshot`/`fetch_quotes`/`render` inputs. Every number
// is computed locally from CLI payloads (never SQLite); the TUI renders `?`
// and `~cost` on quote outage instead of blanking the frame.

import { marketClock, runCli, snapshot, tick } from "./engine";
import type { EngineOpts, SpawnFn } from "./types";

export const OCC_RE = /^([A-Z]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;

export type Tickmark = "▲" | "▼" | "·";

/** One position row with locally computed P&L (mirror of dashboard.render). */
export interface PositionRow {
  symbol: string;
  long: boolean;
  qty: number;
  avgCost: number;
  mult: number;
  assetClass: string;
  /** Last quote; null on outage (renders `?`). */
  price: number | null;
  prevClose: number | null;
  /** Liquidation value; cost-basis fallback (`~cost`) on outage. */
  marketValue: number;
  costBasis: number;
  /** Null on outage (renders `?`). */
  unreal: number | null;
  pct: number | null;
  tickmark: Tickmark;
  outage: boolean;
}

export interface PendingOrderInput {
  id: number;
  side: string;
  qty: number;
  symbol: string;
  kind: string;
  limit: number | null;
  stop: number | null;
  trail: number | null;
  trailPct: number | null;
  tif: string;
}

export interface PendingOrder extends PendingOrderInput {
  label: string;
}

export interface AccountPanel {
  name: string;
  cash: number;
  deposits: number;
  realized: number;
  equity: number;
  day: number;
  unreal: number;
  total: number;
  retPct: number;
  positions: PositionRow[];
  pending: PendingOrder[];
  isDefault: boolean;
}

export interface MarketClockInfo {
  isOpen: boolean;
  transition: string;
  eastern: string;
}

export interface DashboardSnapshot {
  panels: AccountPanel[];
  /** `{symbol: [last, prevClose] | null}` — null marks a quote outage. */
  quotes: Record<string, [number, number | null] | null>;
  clock: MarketClockInfo;
  /** Flat pending list across all panels. */
  pending: PendingOrder[];
  asOf: string;
}

export interface LoadSnapshotOpts {
  account?: string;
  /** Previous refresh's last prices, for ▲/▼/· tickmarks. */
  prev?: Record<string, number>;
  spawn?: SpawnFn;
  timeoutMs?: number;
  /** `YYYY-MM-DD` override (tests); defaults to today. */
  today?: string;
  /** Display-quote TTL override in ms (tests); defaults to QUOTE_TTL_MS. */
  quoteTtlMs?: number;
  /** Clock override in ms (tests); defaults to Date.now(). */
  nowMs?: number;
  /** Bypass the quote cache (post-tick re-snapshot always sets this). */
  freshQuotes?: boolean;
}

/** Display-quote TTL: Yahoo marks are cached this long to avoid rate-limiting.
 * Fills/ticks always use live prices server-side; only the display path reads here. */
export const QUOTE_TTL_MS = 15_000;

type CachedQuote = { quote: [number, number | null] | null; atMs: number };
// Per-spawn caches: the live TUI reuses one spawn (one cache per process),
// while tests with distinct stubs stay isolated from each other.
const quoteCaches = new WeakMap<object, Map<string, CachedQuote>>();
const defaultQuoteCache = new Map<string, CachedQuote>();

function cacheFor(spawn: SpawnFn | undefined): Map<string, CachedQuote> {
  if (!spawn) return defaultQuoteCache;
  let m = quoteCaches.get(spawn);
  if (!m) {
    m = new Map<string, CachedQuote>();
    quoteCaches.set(spawn, m);
  }
  return m;
}

/** Python `{qty:g}` — drops the `.0` but keeps up to 6 significant digits. */
export function fmtQty(qty: number): string {
  if (Number.isInteger(qty)) return String(qty);
  return String(parseFloat(qty.toPrecision(6)));
}

/** Port of dashboard `_num`: NULL numerics render as `—`, never blank. */
export function fmtNum(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toFixed(2);
}

/** Port of dashboard `_pending_order_label` (tuple order → CLI object shape). */
export function pendingOrderLabel(o: PendingOrderInput): string {
  let trigger: string;
  if (o.kind === "limit") {
    trigger = `lim ${fmtNum(o.limit)}`;
  } else if (o.kind === "stop") {
    trigger = `stop ${fmtNum(o.stop)}`;
  } else if (o.kind === "stop_limit") {
    trigger = `stop ${fmtNum(o.stop)} / lim ${fmtNum(o.limit)}`;
  } else if (o.kind === "trailing_stop") {
    const configured =
      o.trail !== null && o.trail !== undefined
        ? o.trail.toFixed(2)
        : o.trailPct !== null && o.trailPct !== undefined
          ? `${o.trailPct.toFixed(2)}%`
          : "unset";
    trigger = `trail ${configured}`;
    if (o.stop !== null && o.stop !== undefined) {
      trigger += ` (stop ${o.stop.toFixed(2)})`;
    }
  } else {
    trigger = o.kind;
  }
  return `#${o.id} ${o.side} ${fmtQty(o.qty)} ${o.symbol} ${trigger} ${o.tif}`;
}

/** Tickmark from the previous refresh's price map (mirror of render). */
export function tickmarkFor(px: number, lastPx: number | undefined): Tickmark {
  if (lastPx === undefined || px === lastPx) return "·";
  return px > lastPx ? "▲" : "▼";
}

/** True when an OCC symbol expired before `today` (mirror of run_dashboard). */
export function isExpiredOcc(symbol: string, today: string): boolean {
  const m = OCC_RE.exec(symbol.toUpperCase());
  if (!m) return false;
  return `20${m[2]}-${m[3]}-${m[4]}` < today;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function nullableNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function todayStr(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function clockTime(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

interface AccountRecord {
  name: string;
  cash: number;
  deposits: number;
  realized: number;
  isDefault: boolean;
}

function asAccounts(payload: unknown): AccountRecord[] {
  if (!Array.isArray(payload)) return [];
  return payload
    .filter((a): a is Record<string, unknown> => typeof a === "object" && a !== null)
    .map((a) => ({
      name: String(a["name"] ?? ""),
      cash: num(a["cash"]),
      // `accounts --detail --json` carries these; plain `accounts --json`
      // reports cash only, so the 0-fallbacks stay for that shape.
      deposits: num(a["deposits"]),
      realized: num(a["realized"]),
      isDefault: a["default"] === true,
    }))
    .filter((a) => a.name !== "");
}

interface RawPosition {
  symbol: string;
  signedQty: number;
  avgCost: number;
  mult: number;
  assetClass: string;
  margin: number;
}

function asPositions(payload: unknown): RawPosition[] {
  if (!Array.isArray(payload)) return [];
  const rows: RawPosition[] = [];
  for (const p of payload) {
    if (typeof p !== "object" || p === null) continue;
    const r = p as Record<string, unknown>;
    const symbol = String(r["symbol"] ?? "");
    if (!symbol) continue;
    // CLI shape: signed_qty + avg_entry_price; tolerate legacy qty/side too.
    const signedRaw = r["signed_qty"];
    const qtyRaw = r["qty"];
    let signedQty: number;
    if (typeof signedRaw === "number" && Number.isFinite(signedRaw)) {
      signedQty = signedRaw;
    } else if (typeof qtyRaw === "number" && Number.isFinite(qtyRaw)) {
      signedQty = r["side"] === "short" ? -Math.abs(qtyRaw) : Math.abs(qtyRaw);
    } else {
      continue;
    }
    rows.push({
      symbol,
      signedQty,
      avgCost: num(r["avg_entry_price"] ?? r["avg_cost"]),
      mult: num(r["multiplier"] ?? r["mult"], 1),
      assetClass: String(r["asset_class"] ?? "spot"),
      margin: num(r["margin"]),
    });
  }
  return rows;
}

function asPending(payload: unknown): PendingOrder[] {
  if (!Array.isArray(payload)) return [];
  const orders: PendingOrder[] = [];
  for (const o of payload) {
    if (typeof o !== "object" || o === null) continue;
    const r = o as Record<string, unknown>;
    if (r["status"] !== undefined && r["status"] !== "pending") continue;
    const id = num(r["id"]);
    const symbol = String(r["symbol"] ?? "");
    if (!symbol) continue;
    const input: PendingOrderInput = {
      id,
      side: String(r["side"] ?? ""),
      qty: num(r["qty"]),
      symbol,
      kind: String(r["order_type"] ?? r["kind"] ?? "market"),
      limit: nullableNum(r["limit_price"] ?? r["limit"]),
      stop: nullableNum(r["stop_price"] ?? r["stop"]),
      trail: nullableNum(r["trail_price"] ?? r["trail"]),
      trailPct: nullableNum(r["trail_percent"] ?? r["trail_pct"]),
      tif: String(r["time_in_force"] ?? r["tif"] ?? "gtc"),
    };
    orders.push({ ...input, label: pendingOrderLabel(input) });
  }
  return orders.sort((a, b) => a.id - b.id);
}

function asClock(payload: unknown): MarketClockInfo {
  const c =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)
      : {};
  const next =
    typeof c["next_transition"] === "object" && c["next_transition"] !== null
      ? (c["next_transition"] as Record<string, unknown>)
      : null;
  return {
    isOpen: c["is_open"] === true,
    transition: String(c["transition"] ?? ""),
    eastern: next ? String(next["eastern"] ?? "") : "",
  };
}

/** One `data snapshot SYM` call → `[last, prevClose]`, or null on outage.
 * Display reads are TTL-cached per spawn (see QUOTE_TTL_MS); pass fresh:true
 * after a tick so the post-fill re-snapshot shows live marks. */
async function fetchQuote(
  symbol: string,
  opts: EngineOpts,
  cache: Map<string, CachedQuote>,
  ttlMs: number,
  nowMs: number,
  fresh: boolean,
): Promise<[number, number | null] | null> {
  const key = symbol.toUpperCase();
  if (!fresh) {
    const hit = cache.get(key);
    if (hit && nowMs - hit.atMs < ttlMs) return hit.quote;
  }
  let payload: unknown;
  try {
    payload = await runCli(["data", "snapshot", symbol], opts);
  } catch {
    const quote = null;
    cache.set(key, { quote, atMs: nowMs });
    return quote;
  }
  let quote: [number, number | null] | null = null;
  if (typeof payload === "object" && payload !== null) {
    const p = payload as Record<string, unknown>;
    const q =
      typeof p["quote"] === "object" && p["quote"] !== null
        ? (p["quote"] as Record<string, unknown>)
        : p;
    const last = nullableNum(q["last"] ?? p["last"]);
    if (last !== null) quote = [last, nullableNum(p["previous_close"] ?? q["previous_close"])];
  }
  cache.set(key, { quote, atMs: nowMs });
  return quote;
}

/**
 * Read-only dashboard refresh. Returns per-account panels, the quotes map
 * (null on outage), the market clock, and the flat pending list.
 * Mirrors run_dashboard: when any pending orders exist or any OCC position
 * expired, runs `tick()` once, then re-snapshots once.
 */
export async function loadSnapshot(opts: LoadSnapshotOpts = {}): Promise<DashboardSnapshot> {
  const engineOpts: EngineOpts = { spawn: opts.spawn, timeoutMs: opts.timeoutMs };
  const prev = opts.prev ?? {};
  const today = opts.today ?? todayStr();
  const ttlMs = opts.quoteTtlMs ?? QUOTE_TTL_MS;
  const nowMs = opts.nowMs ?? Date.now();
  const cache = cacheFor(opts.spawn);

  const fetchAll = async (fresh: boolean) => {
    // `--detail` carries deposits/realized/created so TOTAL/return match Rich.
    const accounts = asAccounts(await runCli(["accounts", "--detail"], engineOpts)).filter(
      (a) => !opts.account || a.name === opts.account,
    );
    const perAccount = await Promise.all(
      accounts.map(async (a) => ({
        account: a,
        positions: asPositions(await snapshot(a.name, engineOpts)),
        pending: asPending(await runCli(["order", "list", "-a", a.name], engineOpts)),
      })),
    );
    const symbols = new Set<string>();
    for (const { positions, pending } of perAccount) {
      for (const p of positions) symbols.add(p.symbol);
      for (const o of pending) symbols.add(o.symbol);
    }
    const quotes = Object.fromEntries(
      await Promise.all(
        [...symbols].map(async (s): Promise<[string, [number, number | null] | null]> => [
          s,
          await fetchQuote(s, engineOpts, cache, ttlMs, nowMs, fresh || opts.freshQuotes === true),
        ]),
      ),
    );
    return { accounts, perAccount, quotes };
  };

  let { perAccount, quotes } = await fetchAll(false);
  const needsTick =
    perAccount.some(({ pending }) => pending.length > 0) ||
    perAccount.some(({ positions }) =>
      positions.some((p) => isExpiredOcc(p.symbol, today)),
    );
  if (needsTick) {
    await tick(engineOpts);
    ({ perAccount, quotes } = await fetchAll(true));
  }

  const clock = asClock(await marketClock(engineOpts));
  const panels: AccountPanel[] = perAccount.map(({ account, positions, pending }) => {
    let equity = account.cash;
    let upnlSum = 0;
    let daySum = 0;
    const rows: PositionRow[] = [...positions]
      .sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0))
      .map((p) => {
        const qty = Math.abs(p.signedQty);
        const long = p.signedQty > 0;
        // Futures fall back to margin; everything else to qty*mult*avg.
        const costBasis = p.assetClass === "future" ? p.margin : qty * p.mult * p.avgCost;
        const q = quotes[p.symbol] ?? null;
        if (q === null) {
          equity += costBasis;
          return {
            symbol: p.symbol, long, qty, avgCost: p.avgCost, mult: p.mult,
            assetClass: p.assetClass, price: null, prevClose: null,
            marketValue: costBasis, costBasis, unreal: null, pct: null,
            tickmark: "·" as Tickmark, outage: true,
          };
        }
        const [px, prevClose] = q;
        const upnl = p.signedQty * p.mult * (px - p.avgCost);
        // Liquidation value, same as dashboard.render.
        const mv = p.assetClass === "future" ? upnl + p.margin : p.signedQty * p.mult * px;
        const pct =
          p.avgCost !== 0
            ? (px / p.avgCost - 1) * 100 * (long ? 1 : -1)
            : 0;
        equity += mv;
        upnlSum += upnl;
        if (prevClose !== null) daySum += p.signedQty * p.mult * (px - prevClose);
        return {
          symbol: p.symbol, long, qty, avgCost: p.avgCost, mult: p.mult,
          assetClass: p.assetClass, price: px, prevClose,
          marketValue: mv, costBasis, unreal: upnl, pct,
          tickmark: tickmarkFor(px, prev[p.symbol]), outage: false,
        };
      });
    const total = account.realized + upnlSum;
    return {
      name: account.name,
      cash: account.cash,
      deposits: account.deposits,
      realized: account.realized,
      equity,
      day: daySum,
      unreal: upnlSum,
      total,
      retPct: account.deposits !== 0 ? (total / account.deposits) * 100 : 0,
      positions: rows,
      pending,
      isDefault: account.isDefault,
    };
  });

  return {
    panels,
    quotes,
    clock,
    pending: panels.flatMap((p) => p.pending),
    asOf: clockTime(),
  };
}
