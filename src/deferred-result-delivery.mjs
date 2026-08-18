/**
 * Deferred result delivery buffer for exactly-once async completion
 * notification. Ported from vendored result-delivery.ts.
 *
 * Usage:
 *   const delivery = createDeferredResultDelivery();
 *   delivery.defer({ id: "task-1", output: "done" });  // buffer a result
 *   delivery.consume(["task-1"]);                       // subagent_wait preempts
 *   delivery.drain();                                    // agent_settled flushes
 *
 * A consumed result is never drained — this prevents double-delivery when
 * an explicit wait and an automatic flush race.
 */

export function createDeferredResultDelivery() {
  /** @type {Map<string, object>} */
  const pending = new Map();

  return {
    /** Buffer a result for later delivery. Replaces any prior entry for the same id. */
    defer(item) {
      pending.set(item.id, item);
    },

    /** Remove results that were already delivered via an explicit wait. */
    consume(ids) {
      for (const id of ids) pending.delete(id);
    },

    /** Flush all pending results and clear the buffer. Returns them in insertion order. */
    drain() {
      const results = [...pending.values()];
      pending.clear();
      return results;
    },

    /** Drop all pending results without delivering (used on session shutdown). */
    clear() {
      pending.clear();
    },
  };
}
