// Central direction allowlist for all signal creation and delivery paths.
// SHORT-only mode intentionally leaves the SHORT strategy/scoring unchanged.
export function isAllowedSignalDirection(signal) {
  return signal?.side === "SHORT";
}

export function filterAllowedSignals(signals) {
  return Array.isArray(signals) ? signals.filter(isAllowedSignalDirection) : [];
}
