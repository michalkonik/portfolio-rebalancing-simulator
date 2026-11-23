import assert from "node:assert/strict";
import test from "node:test";
import { defaultVariant, legacyVariant, variantById, variantsFor, VARIANTS, type BookKind } from "./variants.ts";

const books: BookKind[] = ["btc-eth", "alts-stable", "btc-alts", "alts"];

test("each book keeps more than one scored rule", () => {
  for (const book of books) {
    const rows = variantsFor(book);
    assert.ok(rows.length >= 2, book);
    assert.equal(new Set(rows.map((row) => row.id)).size, rows.length);
  }
});

test("every rule says what it does, what it scored, and when to use it", () => {
  for (const variant of VARIANTS) {
    assert.equal(variant.spec.enabled, true);
    assert.match(variant.rule, /14 days/);
    assert.match(variant.results, /\d/);
    assert.match(variant.when, /bear|uptrend|euphoria/i);
    assert.equal(variantById(variant.id)?.id, variant.id);
  }
});

test("an older saved book still opens on the rule it used to run", () => {
  assert.equal(legacyVariant({ algo: "btc-eth" }), "btc-eth-stay200");
  assert.equal(legacyVariant({ algo: "alts", riskOff: "stay" }), "alts-stay");
  assert.equal(legacyVariant({ algo: "alts" }), "alts-cash");
  assert.equal(legacyVariant({ variant: "btc-eth-stay300" }), "btc-eth-stay300");
});

test("each book has one default and the pair default keeps a coin floor", () => {
  for (const book of books) {
    const chosen = defaultVariant(book);
    assert.equal(chosen.book, book);
    assert.match(chosen.when, /^Best measured/);
  }
  assert.equal(defaultVariant("btc-eth").id, "btc-eth-stay300-floor10");
  assert.equal(defaultVariant("alts").spec.riskOff, "cash");
});

test("the pair favorites are the 300-day rule and the 10 percent floor", () => {
  const floored = variantById("btc-eth-stay300-floor10");
  const open = variantById("btc-eth-stay300");
  assert.equal(floored?.spec.regime, "btc-stay");
  assert.equal(floored?.spec.regimeDays, 300);
  assert.equal(floored?.spec.floorWeight, 0.1);
  assert.equal(open?.spec.floorWeight, undefined);
  assert.equal(variantById("btc-eth-band-floor10")?.spec.regime, "cowen-band");
  assert.equal(variantById("alts-cash")?.spec.riskOff, "cash");
  assert.equal(variantById("alts-stay")?.spec.riskOff, "stay");
});
