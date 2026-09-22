import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BraidResult } from "../../../dist/index.js";
import { createBraidTools } from "../index.js";
import { BraidJobs } from "../jobs.js";

for (const scenario of [
  {
    name: "omitted timeouts are unlimited",
    options: undefined,
    error: undefined,
  },
  {
    name: "explicit node timeout applies",
    options: { nodeTimeoutMs: 10 },
    error: "NODE_TIMEOUT",
  },
  {
    name: "explicit graph timeout applies",
    options: { graphTimeoutMs: 10 },
    error: "GRAPH_TIMEOUT",
  },
]) {
  test(`Pi tool: ${scenario.name}`, { timeout: 2_000 }, async (t) => {
    let now = 0;
    t.mock.method(performance, "now", () => now);
    const model = { provider: "fake", id: "model" };
    const ctx = {
      cwd: process.cwd(),
      model,
      modelRegistry: {
        find: () => model,
        complete: async () => {
          now += 600_000;
          await delay(20);
          return {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            provider: "fake",
            model: "model",
            stopReason: "stop",
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
          };
        },
      },
    } as unknown as ExtensionContext;
    const jobs = new BraidJobs();
    t.after(() => jobs.dispose());
    const { braidTool } = createBraidTools(jobs);
    const result = await braidTool.execute(
      "test",
      {
        goal: "test deadlines",
        nodes: [{ type: "execute", id: "a", prompt: "work" }],
        edges: [],
        ...(scenario.options ? { options: scenario.options } : {}),
      },
      undefined,
      undefined,
      ctx,
    );
    await jobs.wait(result.details!.jobId);
    const details = jobs.get(result.details!.jobId)!.result as BraidResult;
    assert.equal(details.status, scenario.error ? "failed" : "completed");
    assert.equal(details.nodes.a!.error?.code, scenario.error);
  });
}
