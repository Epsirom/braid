import assert from "node:assert/strict";
import { startBraid, type BraidRun } from "../src/index.js";
import { inTemporaryDirectory } from "./support.js";

await inTemporaryDirectory(async cwd => {
  let run!: BraidRun;
  run = startBraid({
    goal: "Refine a proposal, then add the next step using its exact result.",
    nodes: [
      { type: "execute", id: "draft", prompt: "Refine the proposal." },
      { type: "decision", id: "review", prompt: "Review it.", choices: ["again", "done"], pauseAfter: true },
    ],
    loops: [{ id: "refinement", entry: "draft", maxIterations: 2 }],
    edges: [{ from: "draft", to: "review" }, { from: "review", to: "draft", choice: "again", feedback: "refinement" }],
  }, {
    cwd,
    runner: async request => {
      request.decide?.(request.execution.iteration === 2 ? "done" : "again");
      return { output: `${request.node.id}: iteration ${request.execution.iteration ?? "outside loop"}` };
    },
    onEvent: event => {
      if (event.type !== "execution_paused") return;
      if (event.iteration === 1) run.resume([event.executionId!], run.snapshot().revision);
      else run.update({
        expectedRevision: run.snapshot().revision,
        upsertNodes: [{ type: "execute", id: "next", prompt: "Summarize the accepted proposal." }],
        addEdges: [{ from: "review", to: "next", executionId: event.executionId! }],
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
