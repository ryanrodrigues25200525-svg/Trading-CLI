// Status bar: market-clock banner + key hints. Text port of the
// dashboard.py `render()` banner + keys footer, in trading red/green/grey.

import type { MarketClockInfo } from "../store";

export const LOGO = "▀█▀ █▀█ ▄▀█ █▀▄ █ █▄ █ █▀▀ █▀▀ █   █\n █  █▀▄ █▀█ █▄▀ █ █ ▀█ █▄█ █▄▄ █▄▄ █";
export const RED = "#ff2b4a";
export const GREY = "grey35";
export const GREEN = "green";

export function clockLine(clock: MarketClockInfo): string {
  const when =
    clock.eastern && clock.transition
      ? ` · next ${clock.transition} ${clock.eastern.slice(11, 16)} ET`
      : "";
  return clock.isOpen ? `● Market open — NYSE${when}` : `■ Market closed${when}`;
}

const HINTS: Array<[key: string, label: string]> = [
  ["b", "Buy"],
  ["s", "Sell"],
  ["o", "Option"],
  ["g", "Backtesting & Graphs"],
  ["c", "Cancel"],
  ["n", "New"],
  ["e", "Rename"],
  ["u", "Switch"],
  ["t", "Tick"],
  ["r", "Refresh"],
  ["q", "Quit"],
];

export function StatusBar({ clock, asOf }: { clock: MarketClockInfo; asOf: string }) {
  const dot = clock.isOpen ? GREEN : GREY;
  return (
    <box flexDirection="column" gap={1}>
      <box border borderStyle="single" borderColor={RED}>
        <text>
          <span fg={dot}>{clock.isOpen ? "●" : "■"}</span>
          <span>{clockLine(clock).slice(1)} </span>
          <span fg={GREY}> as of {asOf}</span>
        </text>
      </box>
      <text>
        {HINTS.map(([k, label], i) => (
          <span key={k}>
            <span>
              <b>{k}</b>
            </span>
            <span fg={GREY}>
              {` ${label}`}
              {i < HINTS.length - 1 ? " · " : ""}
            </span>
          </span>
        ))}
      </text>
    </box>
  );
}
