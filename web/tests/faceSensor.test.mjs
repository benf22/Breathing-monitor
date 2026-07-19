// Rotation-decision tests for FaceSensor (no camera needed). Run: node web/tests/faceSensor.test.mjs
import assert from "node:assert/strict";

globalThis.screen = { orientation: { type: "portrait-primary", angle: 0 } };
globalThis.window = { innerHeight: 800, innerWidth: 400 };

const { FaceSensor } = await import("../js/vision/faceSensor.js");
const s = new FaceSensor({ engine: { init() {}, detect() { return null; }, close() {} } });

// auto: portrait screen + landscape (sideways) video → rotate 90 upright
assert.equal(s._rotationDegrees({ videoWidth: 640, videoHeight: 480 }), 90);
// auto: portrait screen + portrait video (already upright) → 0
assert.equal(s._rotationDegrees({ videoWidth: 480, videoHeight: 640 }), 0);

// manual overrides
s.setRotation("180");
assert.equal(s._rotationDegrees({ videoWidth: 640, videoHeight: 480 }), 180);
s.setRotation("0");
assert.equal(s._rotationDegrees({ videoWidth: 640, videoHeight: 480 }), 0);

// auto: landscape screen + landscape video (matches) → 0
globalThis.screen = { orientation: { type: "landscape-primary", angle: 90 } };
s.setRotation("auto");
assert.equal(s._rotationDegrees({ videoWidth: 640, videoHeight: 480 }), 0);

console.log("ALL FACESENSOR TESTS PASSED");
