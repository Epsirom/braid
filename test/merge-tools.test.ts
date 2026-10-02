import assert from "node:assert/strict";
import test from "node:test";
import { finishMergeToolDefinition, gitToolDefinition, parseFinishMergeArguments, parseGitToolArguments } from "../src/merge-tools.js";

test("Git tool enums and validation follow node permissions with useful checkout guidance", () => {
  assert.ok(gitToolDefinition(true).parameters.properties.command.enum.includes("restore"));
  assert.ok(!gitToolDefinition(false).parameters.properties.command.enum.includes("restore"));
  assert.ok(!gitToolDefinition(true).parameters.properties.command.enum.includes("checkout"));
  assert.throws(() => parseGitToolArguments({ command: "restore", args: [] }, false), /unavailable/);
  assert.throws(() => parseGitToolArguments({ command: "checkout", args: ["ref", "--", "file"] }, true), /--worktree/);
  assert.throws(() => parseGitToolArguments({ args: ["status"] }, true), /separately/);
  assert.throws(() => parseGitToolArguments({ command: "status", args: [], shell: "sh" }, true), /requires/);
  assert.deepEqual(parseGitToolArguments({ command: "restore", args: ["--source", "ref", "--worktree", "--", "file"] }, true),
    { args: ["restore", "--source", "ref", "--worktree", "--", "file"] });
});

test("finish_merge schema and errors identify only this invocation's exact sources", () => {
  const schema = finishMergeToolDefinition(["docs"]).parameters.properties.dispositions;
  assert.deepEqual(schema.items.properties.executionId.enum, ["docs"]);
  assert.equal(schema.minItems, 1);
  assert.equal(schema.maxItems, 1);
  const item = (executionId: string) => ({ executionId, disposition: "integrated", reason: "Reviewed" });
  assert.throws(() => parseFinishMergeArguments({ dispositions: [item("previous"), item("previous"), null] }, ["docs"]), error => {
    const details = JSON.parse((error as Error).message);
    assert.deepEqual(details.expected, ["docs"]);
    assert.deepEqual(details.missing, ["docs"]);
    assert.deepEqual(details.unexpected, ["previous"]);
    assert.deepEqual(details.duplicates, ["previous"]);
    assert.deepEqual(details.invalidItems, [2]);
    return true;
  });
  assert.deepEqual(parseFinishMergeArguments({ dispositions: [item("docs")] }, ["docs"]), [item("docs")]);
  assert.deepEqual(parseFinishMergeArguments({ dispositions: [] }, []), []);
  assert.equal(finishMergeToolDefinition([]).parameters.properties.dispositions.maxItems, 0);
  assert.equal(finishMergeToolDefinition([]).parameters.properties.dispositions.items.properties.executionId.enum, undefined);
});

test("Git tool rejects repeated commands without rewriting legitimate explicit operands", () => {
  for (const args of [["status"], ["status", "--short"], ["status", "--ignored", "--short"]]) {
    assert.throws(() => parseGitToolArguments({ command: "status", args }, false), error => {
      const details = JSON.parse((error as Error).message);
      assert.equal(details.code, "DUPLICATE_GIT_COMMAND");
      assert.deepEqual(details.receivedArgs, args);
      assert.match(details.instruction, /No Git command was executed/);
      return true;
    });
  }
  assert.throws(() => parseGitToolArguments({ command: "diff", args: ["diff", "--stat"] }, false), /DUPLICATE_GIT_COMMAND/);
  for (const [command, args] of [
    ["status", ["--", "status"]], ["status", ["./status"]],
    ["diff", ["refs/heads/diff"]], ["log", ["--format", "log"]],
  ] as [string, string[]][]) {
    assert.deepEqual(parseGitToolArguments({ command, args }, false), { args: [command, ...args] });
  }
});
