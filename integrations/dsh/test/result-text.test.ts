import assert from "node:assert/strict";
import test from "node:test";
import { newCycles } from "@chrok/braid";
import { formatGitResult } from "../runner.js";
import { formatCycles } from "../status-text.js";

test("git results read like DSH's bash output and keep output byte-exact", () => {
  assert.equal(formatGitResult({ exitCode: 0, stdout: "diff --git a/x b/x\n", stderr: "" }), "diff --git a/x b/x\n");
  assert.equal(formatGitResult({ exitCode: 0, stdout: "", stderr: "" }), "(no output)");
  assert.equal(formatGitResult({ exitCode: 0, stdout: "out", stderr: "warning\n" }), "out\n[stderr]\nwarning\n");
  assert.equal(formatGitResult({ exitCode: 128, stdout: "", stderr: "fatal: bad revision\n" }), "[stderr]\nfatal: bad revision\n[exit code: 128]");
});

test("cycle notices name a node that runs only after a choice and how to start rounds there", () => {
  const node = (id: string) => ({ id, type: "execute" as const, prompt: id });
  const graph = (closesCycle?: boolean) => ({ nodes: [{ ...node("impl"), maxRuns: 3 }, node("tests"), { id: "merge", type: "merge" as const },
    { id: "review", type: "decision" as const, prompt: "review", choices: ["again", "done"] }], edges: [
    { from: "impl", to: "merge" }, { from: "tests", to: "merge" }, { from: "merge", to: "review" },
    { from: "review", to: "impl", choice: "again", ...(closesCycle ? { closesCycle } : {}) },
  ] });
  assert.equal(formatCycles(newCycles(graph())),
    "New cycles (accepted; each round runs new executions, starting at the first node listed):\n" +
    "- merge -> review -> impl -> merge: can stop at review -> impl [choice=again]; bounded by maxRuns on impl. " +
    "impl runs only after review chooses again, not before it in the first round; if each round should start at impl, set closesCycle: true on review -> impl [choice=again].");
  assert.equal(formatCycles(newCycles(graph(true))),
    "New cycles (accepted; each round runs new executions, starting at the first node listed):\n" +
    "- impl -> merge -> review -> impl: can stop at review -> impl [choice=again]; bounded by maxRuns on impl.");
});
