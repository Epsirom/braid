import type { ModelRequest } from "./types.js";

/** True when core interrupted this step (a node timeout pause) without aborting the execution. */
export function isStepInterrupted(request: Pick<ModelRequest, "signal">, step: AbortSignal): boolean {
  return step.aborted && !request.signal.aborted;
}

/** Tool result text for a call that was running when its step was interrupted. */
export function interruptedToolResult(partialOutput = ""): string {
  const text = "Interrupted: the node timeout paused this execution before this call finished; its effects may be partial.";
  return partialOutput.trim() ? `${text}\n\nOutput before the interruption:\n${partialOutput}` : text;
}

/** Tool result text for a call in an interrupted batch that never started. */
export function notRunToolResult(): string {
  return "Not run: the node timeout paused this execution before this call started.";
}
