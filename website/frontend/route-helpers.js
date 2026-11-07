// Route helpers for Phase 2 client actions. Uses String.match to classify actions.

// Boundary guard for request bodies: only a plain object literal is JSON-safe.
// React SyntheticEvents, DOM nodes, FormData entries, and class instances all
// fail this check, so an event leaking into a service call fails loudly instead
// of producing a circular-structure serialization error.
export function plainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

export function matchReceipt(action) {
  const receipt = String(action || '').match(/^receipt:(\d+)$/);
  return receipt ? receipt[1] : null;
}

export function matchArrangement(action) {
  const arrangement = String(action || '').match(/^arrangement:(\d+)$/);
  return arrangement ? arrangement[1] : null;
}

export function matchArrangementAck(action) {
  const ack = String(action || '').match(/^arrangement-ack:(\d+)$/);
  return ack ? ack[1] : null;
}

export function matchCancellation(action) {
  const cancellation = String(action || '').match(/^cancel-request:(\d+)(?::(agree|decline|withdraw))?$/);
  return cancellation ? [cancellation[1], cancellation[2]] : null;
}
