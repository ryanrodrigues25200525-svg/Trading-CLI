// tui/tests/chart.test.ts
import { describe, expect, test } from "bun:test";
import { brailleChart } from "../src/chart";
describe("brailleChart", () => {
  test("drops non-finite and renders rows", () => {
    const rows = brailleChart([1, NaN, 2, Infinity, 3], 12, 4);
    expect(rows.length).toBe(4);
  });
  test("single point returns placeholder", () => {
    expect(brailleChart([5], 12, 4)).toEqual(["(not enough history yet)"]);
  });
  test("flat series does not throw", () => {
    expect(brailleChart([7, 7, 7], 12, 4).length).toBe(4);
  });
});
