import assert from "node:assert/strict";
import { cpus, tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { braid } from "../dist/index.js";

const quick = process.argv.includes("--quick");
const rounds = quick ? 3 : 7;
const sizes = quick ? [10, 100] : [10, 100, 1000];
const measurements = [];
const cwd = mkdtempSync(join(tmpdir(), "braid-benchmark-"));
try {
for (const shape of ["chain", "fan-out/join"]) {
  for (const count of sizes) {
    for (const concurrency of [1, 4, 16]) {
      const nodes = Array.from({ length: count }, (_, index) => ({ type: "execute", id: String(index), prompt: "Return a short result." }));
      const edges = shape === "chain"
        ? nodes.slice(1).map((node, i) => ({ from: String(i), to: node.id }))
        : nodes.slice(1, -1).flatMap(node => [{ from: "0", to: node.id }, { from: node.id, to: String(count - 1) }]);
      const graph = { goal: "Measure local scheduler overhead", nodes, edges };
      const elapsed = [];
      const heapDeltas = [];
      let events = 0;
      for (let round = -1; round < rounds; round++) {
        globalThis.gc?.();
        const before = process.memoryUsage().heapUsed;
        const started = performance.now();
        const result = await braid(graph, {
          cwd,
          runner: async () => ({ output: "ok" }),
          maxConcurrency: concurrency,
          nodeTimeoutMs: Infinity,
          graphTimeoutMs: Infinity,
        });
        const duration = performance.now() - started;
        const heapDelta = process.memoryUsage().heapUsed - before;
        assert.equal(result.status, "completed");
        assert.equal(Object.keys(result.nodes).length, count);
        events = result.events.length;
        if (round >= 0) { elapsed.push(duration); heapDeltas.push(heapDelta); }
      }
      elapsed.sort((a, b) => a - b);
      measurements.push({ shape, nodes: count, edges: edges.length, concurrency,
        medianMs: +elapsed[Math.floor(rounds / 2)].toFixed(3),
        maxMs: +elapsed.at(-1).toFixed(3),
        maxHeapDeltaMiB: +(Math.max(...heapDeltas) / 1024 / 1024).toFixed(3), events });
    }
  }
}
} finally { rmSync(cwd, { recursive: true, force: true }); }
console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch,
  cpu: cpus()[0]?.model, rounds, outputBytesPerNode: 2, gcBeforeEachRun: typeof globalThis.gc === "function",
  note: "One warm-up per case in a temporary non-Git directory. Heap deltas are allocation observations, not peak RSS. No network or model cost.", measurements }, null, 2));
