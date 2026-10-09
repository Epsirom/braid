import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { BraidInput } from "@chrok/braid";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { BraidJobs } from "../jobs.js";
import { registerReviewCommand } from "../review.js";

const exec = promisify(execFile);

// This command is prompt-driven. Lock down its attribution contract, using real
// diffs to demonstrate why restricting baseline-to-snapshot by filename fails.
for (const mode of ["historical range", "latest commit"] as const) {
  test(`/braid:review separates ${mode} from same-file caller changes`, async t => {
    const root = await mkdtemp(join(tmpdir(), "braid-attribution-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const git = async (...args: string[]) => (await exec("git", ["-C", root, ...args])).stdout.trim();
    await git("init", "-b", "main");
    await git("config", "user.name", "Braid test");
    await git("config", "user.email", "test@localhost");
    await git("config", "commit.gpgsign", "false");
    await writeFile(join(root, "code.txt"), "target original\ncaller original\n");
    await git("add", ".");
    await git("commit", "-m", "baseline");
    const baseline = await git("rev-parse", "HEAD");
    await writeFile(join(root, "code.txt"), "target defect\ncaller original\n");
    await git("commit", "-am", "target");
    const endpoint = await git("rev-parse", "HEAD");
    if (mode === "historical range") {
      await writeFile(join(root, "code.txt"), "target defect\nlater unrelated defect\n");
      await git("commit", "-am", "outside target");
    }
    const callerHead = await git("rev-parse", "HEAD");
    await writeFile(join(root, "code.txt"), "target defect\ndirty unrelated defect\n");
    // Stand in for captureWorkspace's commit containing dirty caller files.
    await git("commit", "-am", "initial job snapshot");
    const initialSnapshot = await git("rev-parse", "HEAD");
    const originalDiff = await git("diff", baseline, endpoint, "--", "code.txt");
    assert.match(originalDiff, /\+target defect/);
    assert.doesNotMatch(originalDiff, /unrelated defect/);
    assert.match(await git("diff", baseline, initialSnapshot, "--", "code.txt"), /\+dirty unrelated defect/);
    await writeFile(join(root, "code.txt"), "target fixed\ndirty unrelated defect\n");
    await git("commit", "-am", "loop fix");
    const fixDiff = await git("diff", initialSnapshot, "HEAD", "--", "code.txt");
    assert.match(fixDiff, /\+target fixed/);
    assert.doesNotMatch(fixDiff, /^[+-]dirty unrelated defect/m);
    assert.equal(await git("rev-parse", mode === "historical range" ? `${callerHead}~1` : callerHead), endpoint);

    let handler!: Parameters<ExtensionAPI["registerCommand"]>[1]["handler"];
    let input!: BraidInput;
    registerReviewCommand({
      registerCommand(_name: string, options: { handler: typeof handler }) { handler = options.handler; },
      sendMessage() {},
    } as never, {
      start(value: BraidInput) { input = value; return { jobId: "test", handle: "test" }; },
    } as unknown as BraidJobs);
    await handler(mode === "historical range" ? "HEAD~2..HEAD~1" : "latest commit", {} as ExtensionCommandContext);
    const scope = input.nodes.find(node => node.id === "scope")!;
    const check = input.nodes.find(node => node.id === "check")!;
    assert.equal(typeof scope.prompt, "string");
    assert.match(scope.prompt as string, /resolve HEAD against workspace.baseCommit/);
    assert.match(scope.prompt as string, /original baseline commit, original target endpoint commit, initial job snapshot commit/);
    assert.match(scope.prompt as string, /retain all these exact values/);
    assert.match(scope.prompt as string, /original baseline to original target endpoint, and initial job snapshot to current workspace.snapshotCommit/);
    assert.match(scope.prompt as string, /Preserve those out-of-target edits and do not fix their defects/);
    const reviewer = input.promptTemplates!.reviewer!;
    assert.match(reviewer, /pinned original baseline and target endpoint/);
    assert.match(reviewer, /initial job snapshot to YOUR workspace.snapshotCommit/);
    assert.match(reviewer, /attribute findings only to the original target diff or cumulative fix diff/);
    assert.match(check.prompt as string, /original baseline, original target endpoint, initial job snapshot, and target\/file scope unchanged/);
  });
}
