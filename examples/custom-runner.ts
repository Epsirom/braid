import { setTimeout as delay } from "node:timers/promises";
import { braid, type ModelRunner } from "../src/index.js";
import { inTemporaryDirectory } from "./support.js";

// A deterministic adapter demonstrating the contract; replace this stand-in
// with a fresh provider conversation and expose decide as an actual model tool.
const runner: ModelRunner = async request => {
  request.signal.throwIfAborted();
  await delay(1, undefined, { signal: request.signal });
  if (request.node.type === "decision") {
    request.decide!("continue");
    return { output: "Continue with the analysis.", model: "offline-example" };
  }
  return {
    output: `Received direct predecessors: ${request.predecessors.map(p => p.nodeId).join(", ")}`,
    model: "offline-example",
  };
};
const result = await inTemporaryDirectory(cwd => braid({
  goal: "Demonstrate a cancellable isolated runner.",
  nodes: [
    { type: "decision", id: "route", prompt: "Choose a path.", choices: ["continue", "stop"] },
    { type: "execute", id: "answer", prompt: "List the supplied predecessor IDs." },
  ],
  edges: [{ from: "route", to: "answer", choice: "continue" }],
}, { cwd, runner, nodeTimeoutMs: 1000, graphTimeoutMs: 5000 }));
if (result.status !== "completed") throw new Error(result.error?.message);
console.log(result.terminalOutputs.answer!.output);
