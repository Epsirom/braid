/** A human message waiting for the worker's next model request. */
export interface PiPendingInput {
  text: string;
  submittedAt: number;
}

/**
 * Messages a human sent to running executions, keyed by execution ID. The
 * runner takes them before each model request; once an execution is closed,
 * further messages are rejected and anything still queued is returned as
 * undelivered.
 */
export class PiHumanInputs {
  private readonly queues = new Map<string, PiPendingInput[]>();
  private readonly closed = new Set<string>();

  constructor(private readonly onChange: () => void = () => {}) {}

  send(executionId: string, text: string): PiPendingInput {
    if (typeof text !== "string" || !text.trim()) throw new TypeError("Message must not be empty");
    if (this.closed.has(executionId)) throw new Error("This execution has finished; the message was not sent");
    const input = { text, submittedAt: Date.now() };
    const queue = this.queues.get(executionId) ?? [];
    queue.push(input);
    this.queues.set(executionId, queue);
    this.changed();
    return { ...input };
  }

  pending(executionId: string): readonly PiPendingInput[] {
    return this.queues.get(executionId) ?? [];
  }

  /** Remove and return queued messages, oldest first. */
  take(executionId: string): PiPendingInput[] {
    const queue = this.queues.get(executionId);
    if (!queue?.length) return [];
    this.queues.delete(executionId);
    this.changed();
    return queue;
  }

  /** Stop accepting messages and return those never delivered. */
  close(executionId: string): PiPendingInput[] {
    this.closed.add(executionId);
    const undelivered = this.queues.get(executionId) ?? [];
    this.queues.delete(executionId);
    if (undelivered.length) this.changed();
    return undelivered;
  }

  private changed(): void {
    try { this.onChange(); }
    catch { /* Observers cannot fail a worker. */ }
  }
}

/** How a delivered message reads to the worker, so it is never mistaken for graph input. */
export function formatHumanInput(text: string): string {
  return "Message from the human supervising this Braid execution, sent while you were running " +
    "(it may be relayed by their Braid assistant). " +
    "It is not part of the node prompt or predecessor outputs. Take it into account for your remaining work; " +
    "it does not lift tool, budget, workspace, or decision constraints.\n\n" + text;
}
