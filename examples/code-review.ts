import { braid, type BraidInput, type ModelRunner } from "../src/index.js";

// Supply an actual diff as graph data. Core workers have no filesystem access.
const diff = "- return cache[key];\n+ return cache[key] ?? await load(key);";
const graph: BraidInput = {
  goal: `Review this proposed cache change:\n${diff}`,
  nodes: [
    { type: "execute", id: "correctness", prompt: "Review cache semantics and concurrent misses." },
    { type: "execute", id: "tests", prompt: "Identify regression cases worth testing." },
    { type: "execute", id: "review", prompt: "Synthesize actionable findings from both reviews." },
  ],
  edges: [{ from: "correctness", to: "review" }, { from: "tests", to: "review" }],
};
const runner: ModelRunner = async ({ node, predecessors }) => ({
  output: node.id === "correctness"
    ? "Concurrent cache misses can call load twice. Confirm whether null is a cached value."
    : node.id === "tests"
      ? "Test an existing value, null, concurrent misses, and a rejected load."
      : predecessors.map(p => `${p.nodeId}: ${p.output}`).join("\n"),
});
const result = await braid(graph, { runner, maxConcurrency: 2 });
if (result.status !== "completed") throw new Error(result.error?.message);
console.log(result.terminalOutputs.review!.output);
