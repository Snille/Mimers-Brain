// Recall reporting uses trace_id. Keep request_id as a compatibility alias for
// clients that implemented the original search/fetch response contract.
export function recallReference(traceId) {
  return { trace_id: traceId, request_id: traceId };
}
