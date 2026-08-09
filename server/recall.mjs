// Recall reporting uses trace_id. Keep request_id as a compatibility alias for
// clients that implemented the original search/fetch response contract.
export function recallReference(traceId) {
  return {
    trace_id: traceId,
    request_id: traceId,
    receipt_required: Boolean(traceId),
    receipt_instruction: traceId
      ? "Before the final answer, call report_memory_usage exactly once for this trace_id. Report every search separately, even when every result was ignored."
      : null,
  };
}
