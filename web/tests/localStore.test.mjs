// Exercises the on-device store with a fake IndexedDB. Run:
//   npm install --no-save fake-indexeddb
//   node web/tests/localStore.test.mjs
import assert from "node:assert/strict";
import "fake-indexeddb/auto";

const store = await import("../js/storage/localStore.js");

const today = Date.now();
const yesterday = today - 24 * 3600_000;

// Two sessions today, one yesterday. Rollups are cumulative → last one wins.
await store.recordRollup("s1", "dev", { totalOpenSeconds: 30, totalClosedSeconds: 90, totalChanges: 3, maxClosedSeconds: 5 }, today);
await store.recordRollup("s1", "dev", { totalOpenSeconds: 60, totalClosedSeconds: 140, totalChanges: 5, maxClosedSeconds: 12 }, today); // supersedes s1
await store.recordRollup("s2", "dev", { totalOpenSeconds: 40, totalClosedSeconds: 60, totalChanges: 2, maxClosedSeconds: 8 }, today);
await store.recordRollup("s3", "dev", { totalOpenSeconds: 10, totalClosedSeconds: 10, totalChanges: 1, maxClosedSeconds: 3 }, yesterday);

const res = await store.daily(30);

// Two days present.
assert.equal(res.days.length, 2, JSON.stringify(res.days));

const todayRow = res.days.find((d) => d.sessions === 2);
// today: open = 60+40 = 100, closed = 140+60 = 200 → 33.3%
assert.ok(Math.abs(todayRow.open_seconds - 100) < 0.01, JSON.stringify(todayRow));
assert.ok(Math.abs(todayRow.closed_seconds - 200) < 0.01, JSON.stringify(todayRow));
assert.ok(Math.abs(todayRow.open_percentage - 33.3) < 0.1, JSON.stringify(todayRow));
// today's max continuous closed = max(12, 8) = 12
assert.equal(todayRow.max_closed_seconds, 12, JSON.stringify(todayRow));
assert.equal(res.totals.max_closed_seconds, 12, JSON.stringify(res.totals));

// totals across both days: open = 100+10 = 110, closed = 200+10 = 210
assert.equal(res.totals.sessions, 3);
assert.ok(Math.abs(res.totals.total_open_seconds - 110) < 0.01, JSON.stringify(res.totals));
assert.ok(Math.abs(res.totals.open_percentage - 34.4) < 0.2, JSON.stringify(res.totals));

// Window filter: a 0-day window keeps only "today" (cutoff == today).
const narrow = await store.daily(0);
assert.ok(narrow.days.every((d) => d.sessions !== 1), "yesterday should be excluded by days=0");

await store.clearAll();
assert.equal((await store.daily(30)).days.length, 0);

console.log("ALL LOCALSTORE TESTS PASSED");
