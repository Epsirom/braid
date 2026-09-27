import assert from "node:assert/strict";
import { braid } from "../src/index.js";

const result = await braid({
  goal: "Retain independent findings when one provider fails.",
  nodes: [
    { type: "execute", id: "offline", prompt: "Summarize known local facts." },
    { type: "execute", id: "remote", prompt: "Ask the unavailable provider." },
    { type: "execute", id: "join", prompt: "Combine both inputs." },
  ],
  edges: [{ from: "offline", to: "join" }, { from: "remote", to: "join" }],
}, {
  runner: async ({ node }) => {
    if (node.id === "remote") throw new Error("Demo provider unavailable");
    return { output: "Known local facts are still available." };
  },
});
assert.equal(result.status, "failed");
assert.equal(result.nodes.join!.skipReason, "upstream_failed");
// A successful node with an active outgoing edge is not an execution terminal,
// even if its successor fails. Inspect nodes to retrieve these partial findings.
assert.deepEqual(Object.keys(result.terminalOutputs), []);
console.log(`status: ${result.status}; join: ${result.nodes.join!.skipReason}`);
console.log(`partial finding: ${result.nodes.offline!.output}`);
