/**
 * Pure-logic tests for src/energy-stats-panel.js.
 *
 * No npm, no test framework. The source is evaluated in a node:vm context with
 * a stub DOM; top-level `function` declarations become properties of that
 * context, which is how the helpers get here.
 *
 * Run with:  TZ=Europe/Rome node tests/energy-stats-panel.test.js
 */
"use strict";

const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const assert = require("node:assert/strict");

if (process.env.TZ !== "Europe/Rome") {
  console.error("Run with TZ=Europe/Rome — these assertions are timezone-dependent.");
  process.exit(1);
}

const SRC = path.join(__dirname, "..", "src", "energy-stats-panel.js");
const ctx = vm.createContext({
  HTMLElement: class {},
  customElements: { define() {} },
  window: {},
  console,
});
vm.runInContext(fs.readFileSync(SRC, "utf8"), ctx);

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}
const ms = (y, m, d, h = 0) => new Date(y, m, d, h).getTime();
// Arrays built inside the vm context carry that realm's Array.prototype, which
// assert/strict's deepEqual rejects. Re-home them before comparing.
const arr = (x) => Array.from(x);

test("panelPeriodOf maps each view to a recorder period", () => {
  assert.equal(ctx.panelPeriodOf("day"), "hour");
  assert.equal(ctx.panelPeriodOf("week"), "day");
  assert.equal(ctx.panelPeriodOf("month"), "day");
  assert.equal(ctx.panelPeriodOf("year"), "month");
});

test("panelPeriodStart snaps to local midnight / Monday / 1st / Jan 1", () => {
  const anchor = ms(2026, 7, 6, 14); // Thu 6 Aug 2026, 14:00
  assert.equal(ctx.panelPeriodStart("day", anchor), ms(2026, 7, 6));
  assert.equal(ctx.panelPeriodStart("week", anchor), ms(2026, 7, 3)); // Monday
  assert.equal(ctx.panelPeriodStart("month", anchor), ms(2026, 7, 1));
  assert.equal(ctx.panelPeriodStart("year", anchor), ms(2026, 0, 1));
});

test("panelPeriodStart treats Sunday as the end of its week, not the start", () => {
  assert.equal(ctx.panelPeriodStart("week", ms(2026, 7, 9, 23)), ms(2026, 7, 3));
});

test("panelShift crosses month and year boundaries by calendar, not by 86400000", () => {
  assert.equal(ctx.panelShift("day", ms(2026, 0, 1), -1), ms(2025, 11, 31));
  assert.equal(ctx.panelShift("week", ms(2026, 7, 3), -1), ms(2026, 6, 27));
  assert.equal(ctx.panelShift("month", ms(2026, 0, 1), -1), ms(2025, 11, 1));
  assert.equal(ctx.panelShift("year", ms(2026, 0, 1), 1), ms(2027, 0, 1));
});

test("panelShift on a DST boundary still lands on local midnight", () => {
  // 29 Mar 2026 is the spring-forward day in Europe/Rome (23 hours long).
  const after = ctx.panelShift("day", ms(2026, 2, 29), 1);
  assert.equal(after, ms(2026, 2, 30));
  assert.equal(new Date(after).getHours(), 0);
});

test("panelWindow spans the previous period through the end of the current one", () => {
  const w = ctx.panelWindow("month", ms(2026, 7, 6, 14));
  assert.equal(w.period, "day");
  assert.equal(w.prevStart, ms(2026, 6, 1));
  assert.equal(w.start, ms(2026, 7, 1));
  assert.equal(w.end, ms(2026, 8, 1));
});

test("panelSlots returns one slot per hour / day / month", () => {
  assert.equal(ctx.panelSlots("day", ms(2026, 7, 6)).length, 24);
  assert.equal(ctx.panelSlots("week", ms(2026, 7, 3)).length, 7);
  assert.equal(ctx.panelSlots("month", ms(2026, 7, 1)).length, 31);
  assert.equal(ctx.panelSlots("month", ms(2026, 1, 1)).length, 28);
  assert.equal(ctx.panelSlots("year", ms(2026, 0, 1)).length, 12);
});

test("panelSlots yields 23 slots on the spring-forward day and 25 in autumn", () => {
  assert.equal(ctx.panelSlots("day", ms(2026, 2, 29)).length, 23);
  assert.equal(ctx.panelSlots("day", ms(2026, 9, 25)).length, 25);
});

test("panelBucketMs accepts epoch milliseconds and ISO strings", () => {
  assert.equal(ctx.panelBucketMs(1754431200000), 1754431200000);
  assert.equal(ctx.panelBucketMs("2026-08-06T00:00:00+02:00"), ms(2026, 7, 6));
  assert.equal(ctx.panelBucketMs("not a date"), null);
  assert.equal(ctx.panelBucketMs(undefined), null);
});

test("panelFill puts each bucket in its own slot and zero-fills the gaps", () => {
  const slots = ctx.panelSlots("day", ms(2026, 7, 6));
  const end = ms(2026, 7, 7);
  const out = ctx.panelFill(slots, [
    { start: ms(2026, 7, 6, 0), change: 0.5 },
    { start: ms(2026, 7, 6, 3), change: 1.25 },
    { start: ms(2026, 7, 6, 23), change: 0.25 },
  ], end);
  assert.equal(out.length, 24);
  assert.equal(out[0], 0.5);
  assert.equal(out[1], 0);
  assert.equal(out[2], 0);
  assert.equal(out[3], 1.25);
  assert.equal(out[23], 0.25);
});

test("panelFill ignores buckets outside [slots[0], endMs)", () => {
  const slots = ctx.panelSlots("day", ms(2026, 7, 6));
  const out = ctx.panelFill(slots, [
    { start: ms(2026, 7, 5, 12), change: 99 }, // previous day
    { start: ms(2026, 7, 7, 1), change: 99 },  // next day
    { start: ms(2026, 7, 6, 5), change: 2 },
  ], ms(2026, 7, 7));
  assert.equal(out.reduce((a, b) => a + b, 0), 2);
});

test("panelFill survives a missing or malformed bucket list", () => {
  const slots = ctx.panelSlots("week", ms(2026, 7, 3));
  assert.deepEqual(arr(ctx.panelFill(slots, undefined, ms(2026, 7, 10))), [0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(arr(ctx.panelFill(slots, [{ start: null }], ms(2026, 7, 10))), [0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(arr(ctx.panelFill([], [{ start: ms(2026, 7, 3), change: 1 }], 0)), []);
});

test("panelDelta returns a percentage, or null when there is no baseline", () => {
  // Values chosen to divide exactly in binary floating point: (11-10)/10*100
  // is 10.000000000000002, which would make a strict assertion misleading.
  assert.equal(ctx.panelDelta(15, 10), 50);
  assert.equal(ctx.panelDelta(5, 10), -50);
  assert.equal(ctx.panelDelta(5, 0), null);
  assert.equal(ctx.panelDelta(5, undefined), null);
});

test("panelIsCurrent is true only for the period containing now", () => {
  const now = ms(2026, 7, 6, 14);
  assert.equal(ctx.panelIsCurrent("day", ms(2026, 7, 6), now), true);
  assert.equal(ctx.panelIsCurrent("day", ms(2026, 7, 5), now), false);
  assert.equal(ctx.panelIsCurrent("month", ms(2026, 7, 1), now), true);
  assert.equal(ctx.panelIsCurrent("year", ms(2026, 0, 1), now), true);
});

test("panelSlotLabel formats an hour, a day and a month", () => {
  assert.equal(ctx.panelSlotLabel("day", ms(2026, 7, 6, 14), "it"), "14:00");
  assert.equal(ctx.panelSlotLabel("day", ms(2026, 7, 6, 0), "it"), "00:00");
  assert.match(ctx.panelSlotLabel("week", ms(2026, 7, 6), "it"), /6/);
  assert.match(ctx.panelSlotLabel("year", ms(2026, 7, 1), "it"), /2026/);
});

test("panelPeriodLabel captions each view", () => {
  assert.match(ctx.panelPeriodLabel("day", ms(2026, 7, 6), "it"), /6.*2026/);
  assert.match(ctx.panelPeriodLabel("week", ms(2026, 7, 3), "it"), /3.*9/);
  assert.match(ctx.panelPeriodLabel("month", ms(2026, 7, 1), "it"), /2026/);
  assert.equal(ctx.panelPeriodLabel("year", ms(2026, 0, 1), "it"), "2026");
});

test("panelAxis ticks every 6 hours, every day of the week, every month", () => {
  const day = ctx.panelAxis("day", ctx.panelSlots("day", ms(2026, 7, 6)), "it");
  assert.deepEqual(arr(day).map((t) => t.i), [0, 6, 12, 18]);
  assert.equal(ctx.panelAxis("week", ctx.panelSlots("week", ms(2026, 7, 3)), "it").length, 7);
  assert.equal(ctx.panelAxis("year", ctx.panelSlots("year", ms(2026, 0, 1)), "it").length, 12);
});

test("panelAxis marks first, middle and last day of a month", () => {
  const month = ctx.panelAxis("month", ctx.panelSlots("month", ms(2026, 7, 1)), "it");
  assert.deepEqual(arr(month).map((t) => t.i), [0, 15, 30]);
  assert.deepEqual(arr(month).map((t) => t.text), ["1", "16", "31"]);
});

console.log(failures ? `\n${failures} failing` : "\nall passing");
process.exit(failures ? 1 : 0);
