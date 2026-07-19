// Signal-suppression rules — situations where the current frame is unreliable
// and must be IGNORED: not aggregated into statistics/metrics, and no alerts.
//
// This is intentionally a simple, growable list. To add a new situation, append
// a rule with a stable `id`, a human `label`, and a `test(result)` predicate.
// `result` is a pipeline FrameResult ({ face, lips, state, ... }) or null.

export const IGNORE_RULES = [
  {
    id: "no-face",
    label: "No face detected",
    test: (r) => !r || !r.face,
  },
  {
    id: "no-mar",
    label: "No MAR signal",
    test: (r) => !r || !r.lips,
  },
  // Add further situations here, e.g.:
  // { id: "low-light", label: "Too dark", test: (r) => r?.brightness != null && r.brightness < 0.1 },
];

/** Ids of every rule currently matching (empty = signal is usable). */
export function ignoreReasons(result) {
  return IGNORE_RULES.filter((rule) => rule.test(result)).map((r) => r.id);
}

/** Human labels for the matching rules. */
export function ignoreLabels(result) {
  return IGNORE_RULES.filter((rule) => rule.test(result)).map((r) => r.label);
}

/** True if this frame should be ignored (any rule matches). */
export function isIgnored(result) {
  return IGNORE_RULES.some((rule) => rule.test(result));
}
