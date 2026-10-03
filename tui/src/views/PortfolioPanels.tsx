// Per-account portfolio panels: React port of dashboard.py `render()`.
// 8-column positions table (SYMBOL/SIDE/QTY/AVG COST/PRICE/MKT VALUE/
// UNREAL P&L/P&L %), stats grid, pending-orders line. Quote outages render
// `?` / `~cost` (never blank), matching the Rich dashboard.

import type { AccountPanel, PositionRow } from "../store";
import { fmtQty } from "../store";

export const RED = "#ff2b4a";
export const GREY = "grey35";
export const GREEN = "green";
export const YELLOW = "yellow";

function commas(v: number): string {
  return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** `+1,234.56` / `-1,234.56` (mirror of dashboard `_money`). */
export function signed(v: number): string {
  return `${v < 0 ? "-" : "+"}${commas(Math.abs(v))}`;
}

function priceCell(row: PositionRow): string {
  if (row.outage || row.price === null) return "?";
  return `${row.price.toFixed(2)} ${row.tickmark}`;
}

function marketCell(row: PositionRow): string {
  if (row.outage) return `~${commas(row.costBasis)}`;
  return commas(row.marketValue);
}

function unrealCell(row: PositionRow): string {
  return row.unreal === null ? "?" : signed(row.unreal);
}

function pctCell(row: PositionRow): string {
  return row.pct === null ? "?" : `${signed(row.pct)}%`;
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

function cell(text: string, width: number, right: boolean): string {
  const t = text.length > width ? text.slice(0, width) : text;
  return right ? t.padStart(width) : t.padEnd(width);
}

function headerLine(): string {
  return COLS.map(([h, w, r]) => cell(h, w, r)).join(" ");
}

function rowLine(row: PositionRow): string {
  const side = row.long ? "LONG" : "SHORT";
  const symbol = row.assetClass === "future" ? `${row.symbol} x${fmtQty(row.mult)}` : row.symbol;
  return [
    cell(symbol, 14, false),
    cell(side, 6, false),
    cell(fmtQty(row.qty), 9, true),
    cell(row.avgCost.toFixed(2), 10, true),
    cell(priceCell(row), 13, true),
    cell(marketCell(row), 12, true),
    cell(unrealCell(row), 12, true),
    cell(pctCell(row), 10, true),
  ].join(" ");
}

function statLine(label: string, value: string): string {
  return `${label} ${value}`;
}

export function AccountPanelView({ panel }: { panel: AccountPanel }) {
  const title = panel.isDefault ? `${panel.name.toUpperCase()} ★` : panel.name.toUpperCase();
  const lines: string[] = [headerLine()];
  if (panel.positions.length === 0) {
    lines.push("no positions");
  } else {
    for (const row of panel.positions) lines.push(rowLine(row));
  }
  lines.push("");
  lines.push(
    [
      statLine("CASH", commas(panel.cash)),
      statLine("EQUITY", commas(panel.equity)),
      statLine("DAY", signed(panel.day)),
    ].join("  "),
  );
  lines.push(
    [
      statLine("UNREAL", signed(panel.unreal)),
      statLine("REALIZED", signed(panel.realized)),
      statLine("TOTAL", `${signed(panel.total)} (${signed(panel.retPct)}%)`),
    ].join("  "),
  );
  if (panel.pending.length > 0) {
    lines.push(`◌ pending: ${panel.pending.map((o) => o.label).join(", ")}`);
  }
  return (
    <box border borderStyle="single" title={title} titleAlignment="left" flexDirection="column">
      <text>{lines.join("\n")}</text>
    </box>
  );
}

export function PortfolioPanels({ panels }: { panels: AccountPanel[] }) {
  if (panels.length === 0) {
    return (
      <box border borderStyle="single">
        <text>no accounts — create one with: tradingcli new NAME</text>
      </box>
    );
  }
  return (
    <box flexDirection="column">
      {panels.map((p) => (
        <AccountPanelView key={p.name} panel={p} />
      ))}
    </box>
  );
}
