import assert from "node:assert/strict";
import test from "node:test";
import { calculateTotal } from "../src/price.mjs";

test("calculates a total in integer cents", () => {
  assert.equal(
    calculateTotal([
      { unitPriceCents: 1_250, quantity: 2 },
      { unitPriceCents: 499, quantity: 1 },
    ]),
    2_999,
  );
});

test("returns zero for an empty order", () => {
  assert.equal(calculateTotal([]), 0);
});

test("rejects invalid monetary inputs", () => {
  assert.throws(
    () => calculateTotal([{ unitPriceCents: 1.5, quantity: 2 }]),
    /non-negative safe integer/,
  );
  assert.throws(
    () => calculateTotal([{ unitPriceCents: 100, quantity: -1 }]),
    /non-negative safe integer/,
  );
});
