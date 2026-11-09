import { assert, describe, it } from "@effect/vitest";

import { phiIcon, piClient } from "./client.ts";

const BLOCK = 117.36;

const PHI_GRID = ["..X..", ".XXX.", "X.X.X", "X.X.X", ".XXX.", "..X.."];

function rasterize(d: string): string[] {
  const cells = PHI_GRID.map((row) => Array.from(row, () => "."));
  for (const rect of d.matchAll(/M([\d.]+) ([\d.]+)H([\d.]+)V([\d.]+)H[\d.]+Z/g)) {
    const [x0, y0, x1, y1] = rect.slice(1).map((value) => Math.round(Number(value) / BLOCK));
    for (let y = y0!; y < y1!; y++) {
      for (let x = x0!; x < x1!; x++) cells[y]![x] = "X";
    }
  }
  return cells.map((row) => row.join(""));
}

describe("phiIcon", () => {
  it("draws the 5x6 block phi in Pi's block size and colors", () => {
    assert.strictEqual(phiIcon.paths.length, 1);
    assert.deepStrictEqual(rasterize(phiIcon.paths[0]!.d), PHI_GRID);
    assert.deepStrictEqual(phiIcon.fill, piClient.icon.fill);
  });

  it("centres the 5-wide glyph in a square viewBox", () => {
    const [minX, minY, width, height] = phiIcon.viewBox.split(" ").map(Number);
    assert.strictEqual(width, height);
    assert.strictEqual(height, 6 * BLOCK);
    assert.closeTo(minX! * -2 + 5 * BLOCK, width!, 1e-9);
    assert.strictEqual(minY, 0);
  });

  it("leaves Pi's own icon untouched", () => {
    assert.strictEqual(piClient.icon.viewBox, "165.29 165.29 469.43 469.43");
  });
});
