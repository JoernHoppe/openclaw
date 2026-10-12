import { performance } from "node:perf_hooks";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { measureEmbeddedAgentPreparation } from "./preparation-timing.js";

let nextPreparationStart = Promise.resolve();
const MAX_PREPARATION_STARTS_PER_SLICE = 16;
const PREPARATION_SLICE_MS = 4;
let preparationStarts = MAX_PREPARATION_STARTS_PER_SLICE;
let preparationSliceStartedAt = 0;

/** Dispatches attempt stages without letting concurrent starts monopolize the event loop. */
export function createEmbeddedAttemptPreparation(options: {
  config?: OpenClawConfig;
  assertCurrent: () => void;
}) {
  return async <T>(stage: string, run: () => Promise<T> | T): Promise<T> => {
    // Only start turns are serialized. Async work overlaps, and a failed or cancelled
    // attempt cannot reject the shared tail or inherit another caller's async context.
    nextPreparationStart = nextPreparationStart.then(async () => {
      // Elapsed slices include CPU work in async continuations. A completed I/O wait
      // can cause an extra yield; counting only initial dispatch misses that work.
      if (
        preparationStarts >= MAX_PREPARATION_STARTS_PER_SLICE ||
        performance.now() - preparationSliceStartedAt >= PREPARATION_SLICE_MS
      ) {
        await yieldToEventLoop();
        preparationStarts = 0;
        preparationSliceStartedAt = performance.now();
      }
      preparationStarts++;
    });
    await nextPreparationStart;
    // Check before acquisition; the caller must receive each result before another
    // checkpoint can throw so its existing finally blocks own every acquired resource.
    options.assertCurrent();
    return measureEmbeddedAgentPreparation(stage, run, { config: options.config });
  };
}
