import assert from "node:assert/strict";
import { braid } from "../src/index.js";
import { inTemporaryDirectory } from "./support.js";

const result = await inTemporaryDirectory(cwd => braid({
  goal: "Retain independent findings when one provider fails.",
  nodes: [
    { type: "execute", id: "offline", prompt: "Summarize known local facts." },
    { type: "execute", id: "remote", prompt: "Ask the unavailable provider." },
    { type: "execute", id: "join", prompt: "Combine both inputs." },
  ],
  edges: [{ from: "offline", to: "join" }, { from: "remote", to: "join" }],
}, {
  cwd,
  runner: async ({ node, predecessors }) => {
    if (node.id === "remote") throw new Error("Demo provider unavailable");
    if (node.id === "join") return {
      output: predecessors.map(p => `${p.nodeId}: ${p.error ? `unavailable (${p.error.code})` : p.output}`).join("\n"),
    };
    return { output: "Known local facts are still available." };
  },
}));
assert.equal(result.status, "failed");
assert.equal(result.nodes.join!.status, "completed");
assert.match(result.terminalOutputs.join!.output, /remote: unavailable \(MODEL_ERROR\)/);
// Unconditional successors receive failed predecessors as explicit error context.
// A recovered answer does not erase the graph's original failure status.
console.log(`status: ${result.status}; join: ${result.nodes.join!.status}`);
console.log(result.terminalOutputs.join!.output);
