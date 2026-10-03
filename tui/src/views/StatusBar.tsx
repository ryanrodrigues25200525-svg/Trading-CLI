// Status bar: market-clock banner + key hints. Text port of the
// dashboard.py `render()` banner + keys footer.

import type { MarketClockInfo } from "../store";

export const LOGO = "▀█▀ █▀█ ▄▀█ █▀▄ █ █▄ █ █▀▀ █▀▀ █   █\n █  █▀▄ █▀█ █▄▀ █ █ ▀█ █▄█ █▄▄ █▄▄ █";

export function clockLine(clock: MarketClockInfo): string {
  const when =
    clock.eastern && clock.transition
      ? ` · next ${clock.transition} ${clock.eastern.slice(11, 16)} ET`
      : "";
  return clock.isOpen ? `● Market open — NYSE${when}` : `■ Market closed${when}`;
}

export const KEY_HINTS =
  "b Buy · s Sell · o Option · g Backtesting & Graphs · c Cancel · n New · e Rename · u Switch · t Tick · r Refresh · q Quit";

export function StatusBar({ clock, asOf }: { clock: MarketClockInfo; asOf: string }) {
  return (
    <box flexDirection="column">
      <box border borderStyle="single">
        <text>
          {clockLine(clock)} {"  "}as of {asOf}
        </text>
      </box>
      <text>{KEY_HINTS}</text>
    </box>
  );
}
