import assert from "node:assert/strict";
import test from "node:test";
import { formatGitResult } from "../runner.js";
import { formatGraph } from "../status-text.js";

test("git results read like Pi's bash output and keep output byte-exact", () => {
  assert.equal(formatGitResult({ exitCode: 0, stdout: "diff --git a/x b/x\n", stderr: "" }), "diff --git a/x b/x\n");
  assert.equal(formatGitResult({ exitCode: 0, stdout: "", stderr: "" }), "(no output)");
  assert.equal(formatGitResult({ exitCode: 0, stdout: "out", stderr: "warning\n" }), "out\nwarning\n");
  assert.equal(formatGitResult({ exitCode: 128, stdout: "", stderr: "fatal: bad revision\n" }), "fatal: bad revision\n\nCommand exited with code 128");
});

test("graphs list node settings and labelled edges, including the edge that closes a cycle, without prompts", () => {
  assert.equal(formatGraph({
    nodes: [
      { type: "execute", id: "work", prompt: { template: "task", variables: {} }, workspace: "read-only", model: "p/m", requireSuccess: true },
      { type: "decision", id: "check", prompt: "secret prompt", choices: ["retry", "done"], pauseAfter: true },
      { type: "merge", id: "join" },
    ],
    edges: [{ from: "work", to: "check" }, { from: "check", to: "work", choice: "retry", limit: 2 }, { from: "check", to: "join", choice: "done" }],
  }), [
    "Nodes:",
    "- work: execute, workspace=read-only, model=p/m, template=task, requireSuccess",
    "- check: decision, choices=retry|done, pauseAfter",
    "- join: merge",
    "Edges:",
    "- work -> check",
    "- check -> work [choice=retry, closes a cycle, limit=2]",
    "- check -> join [choice=done]",
  ].join("\n"));
});
