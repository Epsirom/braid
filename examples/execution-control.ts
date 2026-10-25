import assert from "node:assert/strict";
import { startBraid, type BraidRun } from "../src/index.js";
import { inTemporaryDirectory } from "./support.js";

await inTemporaryDirectory(async cwd => {
  let run!: BraidRun;
  run = startBraid({
    goal: "Refine a proposal, then add the next step using the accepted result.",
    nodes: [
      // draft may run twice, so there are at most two rounds.
      { type: "execute", id: "draft", prompt: "Refine the proposal.", maxRuns: 2 },
      { type: "decision", id: "review", prompt: "Review it.", choices: ["again", "done"], pauseAfter: true },
    ],
    // The choice edge back to draft closes the cycle.
    edges: [{ from: "draft", to: "review" }, { from: "review", to: "draft", choice: "again" }],
  }, {
    cwd,
    runner: async request => {
      request.decide?.(request.execution.generation === 2 ? "done" : "again");
      return { output: `${request.execution.executionId}: round ${request.execution.generation}` };
    },
    onEvent: event => {
      if (event.type !== "execution_paused") return;
      if (event.executionId === "review@1") run.resume([event.executionId], run.snapshot().revision);
      else run.update({
        expectedRevision: run.snapshot().revision,
        upsertNodes: [{ type: "execute", id: "next", prompt: "Summarize the accepted proposal." }],
        addEdges: [{ from: "review", to: "next", choice: "done" }],
        resume: [event.executionId!],
      });
    },
  });
  const result = await run.result;
  assert.equal(result.status, "completed");
  assert.equal(Object.keys(result.executions).length, 5);
  assert.equal(result.revision, 1);
  console.log(`${Object.keys(result.executions).length} executions; revision ${result.revision}`);
  console.log(result.terminalOutputs.next!.output);
});
