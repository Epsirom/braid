import assert from "node:assert/strict";
import test from "node:test";
import { formatGitResult } from "../runner.js";

test("git results read like DSH's bash output and keep output byte-exact", () => {
  assert.equal(formatGitResult({ exitCode: 0, stdout: "diff --git a/x b/x\n", stderr: "" }), "diff --git a/x b/x\n");
  assert.equal(formatGitResult({ exitCode: 0, stdout: "", stderr: "" }), "(no output)");
  assert.equal(formatGitResult({ exitCode: 0, stdout: "out", stderr: "warning\n" }), "out\n[stderr]\nwarning\n");
  assert.equal(formatGitResult({ exitCode: 128, stdout: "", stderr: "fatal: bad revision\n" }), "[stderr]\nfatal: bad revision\n[exit code: 128]");
});
