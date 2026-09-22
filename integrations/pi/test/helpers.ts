import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export function response(output = "done"): AssistantMessage {
  return {
    role: "assistant",
    api: "fake",
    provider: "fake",
    model: "model",
    content: [{ type: "text", text: output }],
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

export function context(
  complete: (signal: AbortSignal) => Promise<AssistantMessage>,
): ExtensionContext {
  const model = { provider: "fake", id: "model", contextWindow: 100_000 };
  return {
    cwd: process.cwd(),
    model,
    mode: "tui",
    hasUI: true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    modelRegistry: {
      find: () => model,
      complete: (
        _model: unknown,
        _context: unknown,
        options: { signal: AbortSignal },
      ) => complete(options.signal),
    },
  } as unknown as ExtensionContext;
}

export const input = {
  goal: "Investigate in background",
  nodes: [{ type: "execute" as const, id: "a", prompt: "work" }],
  edges: [],
};
