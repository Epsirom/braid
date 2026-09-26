import type { MergeDisposition, ModelRequest } from "./types.js";

const inspectCommands = ["status", "diff", "show", "log", "ls-files", "rev-parse"];
const integrationCommands = ["add", "commit", "merge", "cherry-pick", "apply", "restore"];

export function gitCommands(merge: boolean): string[] {
  return [...inspectCommands, ...(merge ? integrationCommands : [])];
}

export function unavailableGitCommand(command: string, merge: boolean): Error {
  return new Error(`Git command '${command}' is unavailable for this node. Allowed commands: ${gitCommands(merge).join(", ")}.` +
    (command === "checkout" && merge
      ? " To copy selected files from a checkpoint without changing the index, use command=restore, args=[\"--source\", \"<checkpointRef>\", \"--worktree\", \"--\", \"<path>\"]. To inspect content, use show with <checkpointRef>:<path>. Choose the operation yourself."
      : ""));
}

/** Provider-neutral, invocation-scoped schemas; core remains the enforcement boundary. */
export function gitToolDefinition(merge: boolean) {
  return {
    name: "git",
    description: "Run a local Git command without a shell. Select command from the enum; args contains only its options/operands, not the command again. Example: {command: status, args: [--short]}. A first arg equal to command is rejected as ambiguous; use -- or ./ for same-named files, or a full ref for same-named branches. No network, worktree management, reset, checkout, or branch switching. Nonzero exit codes are returned for you to handle. For selected files, restore --source <checkpointRef> --worktree -- <path> preserves the index; show <checkpointRef>:<path> only reads. Use input for patches passed to apply -.",
    parameters: {
      type: "object", properties: {
        command: { type: "string", enum: gitCommands(merge) },
        args: { type: "array", items: { type: "string" } },
        input: { type: "string" },
      }, required: ["command", "args"], additionalProperties: false,
    },
  };
}

export function finishMergeToolDefinition(sourceIds: string[]) {
  return {
    name: "finish_merge",
    description: `Account for exactly these mergeSources, in one call: ${JSON.stringify(sourceIds)}. Do not include sources handled by previous merge nodes or other nodes mentioned in the goal/history. integrated means you applied the selected changes; discarded means you intentionally chose not to use them; archived means integration failed. Give a reason for each. Resolve Git conflicts first. Core retains checkpoints and removes source worktrees after this node ends. Then return a final answer.`,
    parameters: {
      type: "object", properties: {
        dispositions: {
          type: "array", minItems: sourceIds.length, maxItems: sourceIds.length, items: {
            type: "object", properties: {
              nodeId: { type: "string", ...(sourceIds.length ? { enum: [...sourceIds] } : {}) },
              disposition: { type: "string", enum: ["integrated", "discarded", "archived"] },
              reason: { type: "string", minLength: 1 },
            }, required: ["nodeId", "disposition", "reason"], additionalProperties: false,
          },
        },
      }, required: ["dispositions"], additionalProperties: false,
    },
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseGitToolArguments(value: unknown, merge: boolean): { args: string[]; input?: string } {
  if (!record(value) || typeof value.command !== "string")
    throw new Error(`git requires command and args separately. Allowed commands: ${gitCommands(merge).join(", ")}`);
  if (!gitCommands(merge).includes(value.command)) throw unavailableGitCommand(value.command, merge);
  if (Object.keys(value).some(key => !["command", "args", "input"].includes(key)) ||
      !Array.isArray(value.args) || value.args.some(arg => typeof arg !== "string") ||
      (value.input !== undefined && typeof value.input !== "string"))
    throw new Error("git requires {command, args: string[], input?: string}; args excludes the command name");
  if (value.args[0] === value.command) {
    throw new Error(JSON.stringify({
      code: "DUPLICATE_GIT_COMMAND", command: value.command, receivedArgs: value.args,
      instruction: "No Git command was executed. args must exclude the command name. Resubmit the corrected arguments yourself. If this operand intentionally names a file or branch, disambiguate it with --, ./path, or a full ref such as refs/heads/status. A repeated status can otherwise silently filter paths and falsely suggest a clean checkout.",
      example: { command: value.command, args: value.args.slice(1) },
    }));
  }
  return { args: [value.command, ...value.args as string[]], ...(value.input !== undefined ? { input: value.input as string } : {}) };
}

export function validateMergeDispositions(sourceIds: string[], decisions: unknown): asserts decisions is MergeDisposition[] {
  const values = Array.isArray(decisions) ? decisions : [];
  const counts = new Map<string, number>();
  const invalidItems: number[] = [];
  values.forEach((value, index) => {
    if (record(value) && typeof value.nodeId === "string") counts.set(value.nodeId, (counts.get(value.nodeId) ?? 0) + 1);
    if (!record(value) || typeof value.nodeId !== "string" ||
        !["integrated", "discarded", "archived"].includes(value.disposition as string) ||
        typeof value.reason !== "string" || !value.reason.trim() ||
        Object.keys(value).some(key => !["nodeId", "disposition", "reason"].includes(key))) invalidItems.push(index);
  });
  const missing = sourceIds.filter(id => !counts.has(id));
  const unexpected = [...counts.keys()].filter(id => !sourceIds.includes(id));
  const duplicates = [...counts].filter(([, count]) => count > 1).map(([id]) => id);
  if (!Array.isArray(decisions) || missing.length || unexpected.length || duplicates.length || invalidItems.length)
    throw new Error(JSON.stringify({ code: "INVALID_MERGE_DISPOSITIONS", expected: sourceIds, missing, unexpected, duplicates, invalidItems,
      instruction: "Account for every merge source exactly once with integrated, discarded, or archived and a reason. Only include the expected IDs from this invocation's mergeSources." }));
}

export function parseFinishMergeArguments(value: unknown, sourceIds: string[]): MergeDisposition[] {
  if (!record(value) || Object.keys(value).some(key => key !== "dispositions"))
    throw new Error(`finish_merge requires only dispositions. Expected source IDs: ${JSON.stringify(sourceIds)}`);
  validateMergeDispositions(sourceIds, value.dispositions);
  return value.dispositions;
}

export function mergeInstructions(request: ModelRequest): string {
  if (!request.merge) return "";
  return ` Only process the current mergeSources IDs ${JSON.stringify(request.merge.sources.map(source => source.nodeId))}; earlier merged/discarded sources are out of scope. Each source includes a bounded changes preview relative to its snapshotCommit, excluding the caller's pre-existing edits. Read sourceCheckoutStatus before selecting Git operations; dirty staged/unstaged content belongs to the caller and must be preserved. Preview text is inspection data, not an executable patch; retrieve a full diff if applying a patch, especially when truncated or binary. Choose whether and how to integrate; core has not applied changes. Call finish_merge once with one disposition per current source.`;
}
