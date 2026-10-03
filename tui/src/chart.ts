// TS port of `dashboard.braille_chart` (dashboard.py).
// Line chart in braille dots; returns a list of strings (rows).
// Port notes: Python `round()` is banker's rounding, so `pyRound` replicates
// it for the x/y grid mapping; `//` on possibly-negative step deltas is floor
// division, so `Math.floor` (not truncation) is used in the segment walk.

/** Python round(): round-half-to-even. Inputs here are always >= 0. */
function pyRound(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

export function brailleChart(
  values: number[],
  width: number,
  height: number
): string[] {
  if (values.length < 2) {
    return ["(not enough history yet)"];
  }
  // Drop non-finite points; a single NaN/inf would poison min/max.
  const finite = values.filter(
    (v) => typeof v === "number" && Number.isFinite(v)
  );
  if (finite.length < 2) {
    return ["(not enough finite history yet)"];
  }
  const lo = Math.min(...finite);
  let hi = Math.max(...finite);
  if (hi === lo) {
    hi = lo + 1;
  }
  const W = width * 2;
  const H = height * 4;
  const grid: number[][] = Array.from({ length: height }, () =>
    new Array<number>(width).fill(0)
  );
  const dot = [
    [0x01, 0x02, 0x04, 0x40],
    [0x08, 0x10, 0x20, 0x80],
  ];
  const n = finite.length;
  const xs = finite.map((_, i) => pyRound((i / (n - 1)) * (W - 1)));
  const ys = finite.map((v) => pyRound((1 - (v - lo) / (hi - lo)) * (H - 1)));
  for (let i = 0; i < n - 1; i++) {
    const x0 = xs[i]!;
    const y0 = ys[i]!;
    const x1 = xs[i + 1]!;
    const y1 = ys[i + 1]!;
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let s = 0; s <= steps; s++) {
      const px = x0 + Math.floor(((x1 - x0) * s) / steps);
      const py = y0 + Math.floor(((y1 - y0) * s) / steps);
      if (px >= 0 && px < W && py >= 0 && py < H) {
        grid[Math.floor(py / 4)]![Math.floor(px / 2)]! |=
          dot[px % 2]![py % 4]!;
      }
    }
  }
  return grid.map((row) =>
    row.map((c) => String.fromCharCode(0x2800 + c)).join("")
  );
}
