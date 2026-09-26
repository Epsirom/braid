import assert from "node:assert/strict";
import test from "node:test";
import type { Context } from "@earendil-works/pi-ai";
import { BraidJobs } from "../jobs.js";
import { createBraidTools } from "../index.js";
import { context, input, response } from "./helpers.js";

test("Pi tool options reach the worker and rejected calls consume the budget", async (t) => {
  const ctx = context(async () => response());
  const prompts: string[] = [];
  t.mock.method(ctx.modelRegistry, "complete", async (_model: unknown, worker: Context) => {
    prompts.push(worker.systemPrompt!);
    if (prompts.length === 1) {
      return {
        ...response(),
        stopReason: "toolUse" as const,
        content: [{ type: "toolCall" as const, id: "unavailable", name: "write", arguments: {} }],
      };
    }
    const result = worker.messages.at(-1)!;
    assert.equal(result.role, "toolResult");
    if (result.role === "toolResult") assert.equal(result.isError, true);
    return response("Finished within budget");
  });
  const jobs = new BraidJobs();
  t.after(() => jobs.dispose());
  const { braidTool } = createBraidTools(jobs);
  const submitted = await braidTool.execute("budget", {
    ...input,
    options: { maxToolRounds: 1, maxToolCalls: 1 },
  }, undefined, undefined, ctx);
  await jobs.wait(submitted.details!.jobId);
  assert.equal(jobs.get(submitted.details!.jobId)!.result!.status, "completed");
  assert.match(prompts[0]!, /Tool round budget: 0\/1 used; 1 remaining/);
  assert.match(prompts[0]!, /Tool call budget: 0\/1 used; 1 remaining/);
  assert.match(prompts[1]!, /Tool round budget: 1\/1 used; 0 remaining/);
  assert.match(prompts[1]!, /Tool call budget: 1\/1 used; 0 remaining/);
});
