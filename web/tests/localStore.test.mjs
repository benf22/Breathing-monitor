// Exercises the on-device hour-bucket store with a fake IndexedDB. Run:
//   npm install --no-save fake-indexeddb
//   node web/tests/localStore.test.mjs
import assert from "node:assert/strict";
import "fake-indexeddb/auto";

const store = await import("../js/storage/localStore.js");

const now = Date.now();
const thisHour = store.hourKey(now);
const twoHoursAgo = store.hourKey(now - 2 * 3600_000);
assert.notEqual(thisHour, twoHoursAgo);

await store.startSession();
await store.startSession();
await store.startSession();

// Base data is recorded per hour; open/closed accumulate, maxClosed is a max.
await store.addHourly(thisHour, 60, 140, 12);
await store.addHourly(thisHour, 40, 60, 8); // same hour → adds (100/200), max stays 12
await store.addHourly(twoHoursAgo, 10, 10, 9);

// Hour resolution shows the base buckets directly.
const hr = await store.aggregate("hour");
assert.equal(hr.resolution, "hour");
assert.equal(hr.days.length, 2, JSON.stringify(hr.days.map((d) => d.label)));
const busy = hr.days.find((d) => d.open_seconds === 100);
assert.equal(busy.closed_seconds, 200, JSON.stringify(busy));
assert.equal(busy.max_closed_seconds, 12, JSON.stringify(busy));
assert.ok(Math.abs(busy.open_percentage - 33.3) < 0.1, JSON.stringify(busy));
assert.ok(busy.label.includes(":"), "hour label shows a time");

// Day resolution rolls the two hours up (same day unless the 2h step crossed
// midnight); totals are resolution-independent.
const day = await store.aggregate("day");
assert.equal(day.totals.sessions, 3);
assert.ok(Math.abs(day.totals.total_open_seconds - 110) < 0.01, JSON.stringify(day.totals));
assert.ok(Math.abs(day.totals.total_closed_seconds - 210) < 0.01, JSON.stringify(day.totals));
assert.equal(day.totals.max_closed_seconds, 12);

// Month resolution collapses everything into one (or two around a boundary) —
// but never more buckets than day.
const mo = await store.aggregate("month");
assert.ok(mo.days.length <= day.days.length);
assert.equal(mo.totals.sessions, 3);

await store.clearAll();

// Retroactive correction: a negative open increment (talking-onset rollback)
// clamps the bucket at zero rather than going negative.
const nowKey = store.hourKey(Date.now());
await store.addHourly(nowKey, 30, 0, 0);
await store.addHourly(nowKey, -50, 0, 0);
const adj = await store.aggregate("hour");
assert.equal(adj.days[0].open_seconds, 0, "open clamped at 0 after over-subtraction");

await store.clearAll();

// Biofeedback periods store.
await store.addPeriod({ start: 1000, end: 2000, kind: "on", openS: 10, closedS: 50, spanSum: 40, spanCount: 4 });
await store.addPeriod({ start: 2000, end: 3000, kind: "baseline", openS: 20, closedS: 40, spanSum: 30, spanCount: 3 });
const ps = await store.periods();
assert.equal(ps.length, 2);
assert.equal(ps[0].kind, "on");
assert.equal(ps[1].kind, "baseline");
assert.equal(ps[1].spanSum / ps[1].spanCount, 10); // baseline avg span

await store.clearAll();
assert.equal((await store.periods()).length, 0);
const empty = await store.aggregate("day");
assert.equal(empty.days.length, 0);
assert.equal(empty.totals.sessions, 0);

console.log("ALL LOCALSTORE TESTS PASSED");
