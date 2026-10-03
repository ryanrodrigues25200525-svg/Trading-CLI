// Per-account portfolio panels: React port of dashboard.py `render()`.
// 8-column positions table (SYMBOL/SIDE/QTY/AVG COST/PRICE/MKT VALUE/
// UNREAL P&L/P&L %), stats grid, pending-orders line. Quote outages render
// `?` / `~cost` (never blank), matching the Rich dashboard. Gains green,
// losses red, headers/accents in trading red, labels dim grey.

import type { ReactNode } from "react";
import type { AccountPanel, PositionRow, Tickmark } from "../store";
import { fmtQty } from "../store";

export const RED = "#ff2b4a";
export const GREY = "grey35";
export const GREEN = "green";
export const YELLOW = "yellow";

/** One styled run: plain text plus an optional foreground color. */
export interface Seg {
  t: string;
  fg?: string;
}

/** Green for gains, red for losses (zero counts as a gain, like Rich). */
export function gainFg(v: number): string {
  return v >= 0 ? GREEN : RED;
}

export function sideSeg(long: boolean): Seg {
  return long ? { t: "LONG", fg: GREEN } : { t: "SHORT", fg: RED };
}

export function tickSeg(mark: Tickmark): Seg {
  if (mark === "▲") return { t: mark, fg: GREEN };
  if (mark === "▼") return { t: mark, fg: RED };
  return { t: mark, fg: GREY };
}

/** Signed `+1,234.56`, grey `?` when null (mirror of dashboard `_money`). */
export function signedSeg(v: number | null, suffix = ""): Seg {
  if (v === null) return { t: "?", fg: GREY };
  const text = `${v < 0 ? "-" : "+"}${commas(Math.abs(v))}${suffix}`;
  return { t: text, fg: gainFg(v) };
}

function commas(v: number): string {
  return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** `+1,234.56` / `-1,234.56` (mirror of dashboard `_money`). */
export function signed(v: number): string {
  return `${v < 0 ? "-" : "+"}${commas(Math.abs(v))}`;
}

function pad(text: string, width: number, right: boolean): string {
  const t = text.length > width ? text.slice(0, width) : text;
  return right ? t.padStart(width) : t.padEnd(width);
}

function seg(text: string, width: number, right: boolean, fg?: string): Seg {
  return { t: pad(text, width, right), fg };
}

const COLS: Array<[header: string, width: number, right: boolean]> = [
  ["SYMBOL", 14, false],
  ["SIDE", 6, false],
  ["QTY", 9, true],
  ["AVG COST", 10, true],
  ["PRICE", 13, true],
  ["MKT VALUE", 12, true],
  ["UNREAL P&L", 12, true],
  ["P&L %", 10, true],
];

function headerSegs(): Seg[] {
  return COLS.map(([h, w, r]) => seg(h, w, r, RED));
}

function priceSegs(row: PositionRow): Seg[] {
  if (row.outage || row.price === null) {
    return [{ t: pad("?", 13, true), fg: GREY }];
  }
  // "101.23 ▲": right-aligned number+space in 12 cols, tickmark in the last col.
  return [{ t: pad(`${row.price.toFixed(2)} `, 12, true) }, tickSeg(row.tickmark)];
}

function rowSegs(row: PositionRow): Seg[] {
  const symbol =
    row.assetClass === "future" ? `${row.symbol} x${fmtQty(row.mult)}` : row.symbol;
  const side = sideSeg(row.long);
  const unreal = signedSeg(row.unreal);
  const pct: Seg = row.pct === null ? { t: "?", fg: GREY } : signedSeg(row.pct, "%");
  return [
    seg(symbol, 14, false),
    { t: pad(side.t, 6, false), fg: side.fg },
    seg(fmtQty(row.qty), 9, true),
    seg(row.avgCost.toFixed(2), 10, true),
    ...priceSegs(row),
    row.outage
      ? { t: pad(`~${commas(row.costBasis)}`, 12, true), fg: GREY }
      : seg(commas(row.marketValue), 12, true),
    { t: pad(unreal.t, 12, true), fg: unreal.fg },
    { t: pad(pct.t, 10, true), fg: pct.fg },
  ];
}

function statSegs(label: string, value: Seg): Seg[] {
  return [{ t: `${label} `, fg: GREY }, value, { t: "  " }];
}

function line(segs: Seg[], key: number): ReactNode {
  return (
    <text key={key}>
      {segs.map((s, i) =>
        s.fg ? (
          <span key={i} fg={s.fg}>
            {s.t}
          </span>
        ) : (
          <span key={i}>{s.t}</span>
        ),
      )}
    </text>
  );
}

export function AccountPanelView({ panel }: { panel: AccountPanel }) {
  const title = panel.isDefault ? `${panel.name.toUpperCase()} ★` : panel.name.toUpperCase();
  const accent = panel.isDefault ? RED : GREY;
  const lines: ReactNode[] = [line(headerSegs(), 0)];
  if (panel.positions.length === 0) {
    lines.push(
      <text key="empty" fg={GREY}>
        no positions
      </text>,
    );
  } else {
    panel.positions.forEach((row, i) => lines.push(line(rowSegs(row), i + 1)));
  }
  lines.push(<text key="gap">{" "}</text>);
  lines.push(
    line(
      [
        ...statSegs("CASH", { t: commas(panel.cash) }),
        ...statSegs("EQUITY", { t: commas(panel.equity) }),
        ...statSegs("DAY", signedSeg(panel.day)),
      ],
      100,
    ),
  );
  lines.push(
    line(
      [
        ...statSegs("UNREAL", signedSeg(panel.unreal)),
        ...statSegs("REALIZED", signedSeg(panel.realized)),
        ...statSegs("TOTAL", {
          ...signedSeg(panel.total),
          t: `${signedSeg(panel.total).t} (${signedSeg(panel.retPct, "%").t})`,
        }),
      ],
      101,
    ),
  );
  if (panel.pending.length > 0) {
    lines.push(<text key="sep">{" "}</text>);
    lines.push(
      <text key="pending" fg={YELLOW}>
        {`◌ pending: ${panel.pending.map((o) => o.label).join(", ")}`}
      </text>,
    );
  }
  return (
    <box
      border
      borderStyle="single"
      borderColor={accent}
      title={title}
      titleColor={accent}
      titleAlignment="left"
      flexDirection="column"
      padding={1}
    >
      {lines}
    </box>
  );
}

export function PortfolioPanels({ panels }: { panels: AccountPanel[] }) {
  if (panels.length === 0) {
    return (
      <box border borderStyle="single" borderColor={GREY} padding={1}>
        <text fg={GREY}>no accounts — create one with: tradingcli new NAME</text>
      </box>
    );
  }
  return (
    <box flexDirection="column" gap={1}>
      {panels.map((p) => (
        <AccountPanelView key={p.name} panel={p} />
      ))}
    </box>
  );
}
