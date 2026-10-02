import assert from "node:assert/strict";
import test from "node:test";
import { mockClock } from "../../../test/clock.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Context } from "@earendil-works/pi-ai";
import type { BraidResult } from "@chrok/braid";
import { createBraidTools } from "../index.js";
import { BraidJobs } from "../jobs.js";
import { readOnlyCwd } from "./helpers.js";

for (const scenario of [
  {
    name: "omitted timeouts are unlimited",
    options: undefined,
    error: undefined,
  },
  {
    name: "explicit node timeout applies",
    options: { nodeTimeoutMs: 1_000 },
    error: "NODE_TIMEOUT",
  },
  {
    name: "explicit graph timeout applies",
    options: { graphTimeoutMs: 1_000 },
    error: "GRAPH_TIMEOUT",
  },
]) {
  test(`Pi tool: ${scenario.name}`, { timeout: 2_000 }, async (t) => {
    const clock = mockClock(t);
    const model = { provider: "fake", id: "model" };
    const ctx = {
      cwd: readOnlyCwd,
      model,
      modelRegistry: {
        find: () => model,
        complete: async (_model: unknown, context: Context) => {
          if (!scenario.error) assert.doesNotMatch(context.systemPrompt!, /system-reminder/);
          else assert.match(context.systemPrompt!, new RegExp(`${scenario.error === "NODE_TIMEOUT" ? "Node" : "Graph"} time budget: 1000 ms remaining`));
          clock.advanceWithoutTimers(600_000);
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
    assert.equal(details.status, scenario.error === "GRAPH_TIMEOUT" ? "failed" : "completed");
    assert.equal(details.nodes.a!.error?.code, scenario.error);
  });
}
