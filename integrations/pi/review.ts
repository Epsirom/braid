import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BraidInput } from "@chrok/braid";
import type { BraidJobs } from "./jobs.js";

const maxRounds = 3;

export function registerReviewCommand(pi: ExtensionAPI, jobs: BraidJobs): void {
  pi.registerCommand("braid:review", {
    description: "Parallel review/fix loop, at most 3 review rounds: /braid:review [target or focus]",
    handler: async (args, ctx) => {
      const target = args.trim() || "Current uncommitted changes; if there are none, the latest commit.";
      const input: BraidInput = {
        goal: `Review the following target, fix concrete in-scope defects, and re-review material fixes. Stop after at most ${maxRounds} review rounds. Respect an explicit review-only request.\n\nTarget or focus:\n${target}`,
        promptTemplates: {
          reviewer: `You are reviewer {{slot}}. Use the distinct angle assigned to you by scope.
Inspect the repository instructions, actual files, and target diff in your assigned snapshot. Do not rely on conversation history or edit files. Use scope's pinned original baseline and target endpoint for the original target diff, and separately compare its pinned initial job snapshot to YOUR workspace.snapshotCommit for cumulative loop fixes. Never substitute the current snapshot for the original target endpoint: historical ranges and latest-commit reviews exclude later commits and unrelated caller edits, even within target files. Inspect current files for fix validity, but attribute findings only to the original target diff or cumulative fix diff. Plain git diff may be empty because caller edits were captured in a commit.
Report only concrete current issues within the target, supported by source proof, a test/repro, or a contract contradiction. For diff reviews, require that the issue is caused or made reachable by the diff. Include file/line references, evidence, a suggested fix, and P0/P1/P2: P0 blocks merge, P1 should be fixed before release, P2 is report-only. Do not filter the first pass to blockers only or invent findings to fill your angle.
On follow-up rounds check whether earlier findings were resolved, whether the fixes introduced defects in their blast radius, and whether deferred notes still stand. You cannot run tests here; distinguish source inspection from executed validation.
If nothing qualifies, say exactly "No issues found." End with "Merge verdict: BLOCK", "Merge verdict: OK", or "Merge verdict: OK with notes".`,
        },
        nodes: [
          {
            type: "execute", id: "scope", workspace: "worktree", requireSuccess: true,
            prompt: `Prepare this review round by inspecting the requested target and relevant repository instructions. You are the only fix writer.
On the FIRST round only, resolve the target without editing files. For the default target, compare workspace.baseCommit (the caller's original HEAD) to workspace.snapshotCommit, including captured staged/unstaged/non-ignored new files. If identical, review the latest original commit against its parent; for an initial/unborn commit inspect all captured files. Do not mistake a clean isolated worktree for an empty target. For an explicit commit/range target, resolve HEAD against workspace.baseCommit, not the detached snapshot HEAD, and pin all endpoints as commit hashes.
Pin the original baseline commit, original target endpoint commit, initial job snapshot commit (first-round workspace.snapshotCommit), and original target/file scope in the first handoff. For captured uncommitted changes the original target endpoint is the initial job snapshot; for latest-commit review it is workspace.baseCommit; for an explicit range it is the resolved upper endpoint. On later rounds retain all these exact values from the previous check handoff; never re-resolve HEAD-relative refs or switch target modes. Inspect two separate diffs: original baseline to original target endpoint, and initial job snapshot to current workspace.snapshotCommit for cumulative loop fixes. Do not review baseline-to-current-snapshot as the target: file filtering cannot exclude later commits or unrelated dirty edits in the same target file. Preserve those out-of-target edits and do not fix their defects.
On RETRY rounds, apply only the concrete, evidenced in-scope P0/P1 fixes synthesized by the previous check. Preserve all user edits and any review-only constraint. No optional polish, scope expansion, architecture decisions, or recursive agents. Use only your own worktree. Run focused validation, repair failures within scope, and report commands with exit codes, evidence, and limitations. If validation remains unsuccessful or no material fix was possible, say so explicitly; do not claim success.
Choose three distinct, concrete review angles for this change (usually correctness/regressions, tests/contracts, and simplicity; adapt for security, performance, UI/accessibility, or docs when relevant). Assign them to reviewers 1, 2, and 3. Carry forward cumulative fixes, changed files, validation results, unresolved/deferred findings, and current execution.iteration. If a requested target cannot be read with your tools, report that limitation instead of substituting another target. Outside Git, report findings without attempting fixes.`,
          },
          ...[1, 2, 3].map(slot => ({
            type: "execute" as const, id: `review-${slot}`, workspace: "read-only" as const, requireSuccess: true,
            prompt: { template: "reviewer", variables: { slot: String(slot) } },
          })),
          {
            type: "decision", id: "check", workspace: "read-only", requireSuccess: true, choices: ["retry", "done"],
            prompt: `Synthesize scope and all three reviews. Verify and deduplicate findings against actual files in YOUR workspace.snapshotCommit, which includes scope's completed fixes; separate valid P0/P1 fixes worth doing now, P2 report-only notes, and feedback to ignore/defer with reasons. Do not blindly apply suggestions or add optional polish.
You are read-only and cannot edit files or run tests. If the target is unavailable, review-only was requested, nothing actionable remains, fixes are unavailable outside Git, or a fix requires an unapproved product/scope/architecture decision, call decide with done. Report the exact stop reason and unresolved findings.
If the previous fix pass failed validation or made no material progress, stop with done and prohibit integration of unvalidated or unreviewed fixes; do not repeatedly retry the same findings.
There are at most ${maxRounds} review rounds, including the first. If execution.iteration >= ${maxRounds}, call decide with done; distinguish round-limit exhaustion from a clean review. Never choose retry in the final round.
Otherwise choose retry only when concrete in-scope P0/P1 fixes are worth doing now. Give scope a narrow, deduplicated fix list with evidence so the next writer pass addresses only those findings before fresh reviewers inspect its checkpoint.
Your final handoff must retain the pinned original baseline, original target endpoint, initial job snapshot, and target/file scope unchanged, cumulative fixes and changed files from scope, commands and exit codes, validation evidence/limitations, unresolved and deferred findings, whether the cumulative fixes passed review and validation and may be integrated, rounds run, and stop reason. Prohibit integration when unresolved findings invalidate those fixes. Call decide exactly once, then give this handoff.`,
          },
          {
            type: "integrate", id: "apply", requireSuccess: true,
            prompt: `Read the final check handoff and inspect the cumulative diff in the merge source. Apply only fixes that passed follow-up review and focused validation; do not implement new fixes here. If review-only, no fixes exist, validation failed, or the handoff prohibits integration, leave the source files unchanged and mark the source discarded or archived as appropriate.
Use mergeSources.changes.baseCommit (the initial job snapshot, including caller edits) to checkpointRef as the patch baseline. Do not diff from original HEAD or replay pre-existing caller changes. Preserve staged, unstaged, untracked, and concurrent user edits. If new checkout edits conflict, archive the checkpoint and report the conflict; do not create an unreviewed resolution or overwrite user work. Call finish_merge exactly once with the source executionId and an accurate disposition after applying or archiving the changes.
Inspect the final diff and run or confirm focused validation without changing code. Summarize rounds run, fixes actually applied, validation, remaining/deferred findings, integration outcome, and why the loop stopped. Report round-limit or needs-decision exits honestly; never claim they are clean.`,
          },
        ],
        edges: [
          ...[1, 2, 3].flatMap(slot => [
            { from: "scope", to: `review-${slot}` },
            { from: `review-${slot}`, to: "check" },
          ]),
          { from: "scope", to: "check" },
          { from: "check", to: "scope", choice: "retry", feedback: "review-loop" },
          { from: "check", to: "apply", choice: "done" },
        ],
        loops: [{ id: "review-loop", entry: "scope", maxIterations: maxRounds }],
      };
      const job = jobs.start(input, { maxConcurrency: 3, maxExecutions: maxRounds * 5 + 1 }, ctx);
      pi.sendMessage({
        customType: "braid-review-started", display: true,
        content: `Review started as Braid ${job.handle}: ${target}\nUp to ${maxRounds} parallel review rounds and ${maxRounds - 1} fix passes. Only reviewed fixes are integrated. Open /braid ${job.handle} for progress, or braid_cancel to stop. Wait for the completion reminder, then retrieve braid_status({"jobId":"${job.handle}"}) and summarize; do not start a replacement review loop.`,
        details: { jobId: job.jobId, handle: job.handle },
      }, { triggerTurn: false });
    },
  });
}
