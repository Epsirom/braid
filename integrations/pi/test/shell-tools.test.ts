import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createWorkspaceShellTools } from "../shell-tools.js";

async function fixture(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "braid-shell-test-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return { cwd, tools: createWorkspaceShellTools(cwd) };
}

test("Pi shell tools execute in the assigned cwd and retain output/error semantics", async t => {
  const { cwd, tools } = await fixture(t);
  for (const tool of tools) {
    const command = tool.name === "powershell"
      ? "Set-Content -Path result.txt -Value done; Write-Output shell-output; exit 7"
      : "printf done > result.txt; printf shell-output; printf shell-error >&2; exit 7";
    const result = await tool.execute("run", { command });
    assert.match(await readFile(join(cwd, "result.txt"), "utf8"), /done/);
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /shell-output/);
    assert.match(JSON.stringify(result.content), /exited with code 7/);
  }
});

for (const end of ["abort", "timeout"] as const) {
  test(`shell ${end} waits for the command to stop`, { timeout: 10_000 }, async t => {
    const { tools } = await fixture(t);
    for (const tool of tools) {
      const controller = new AbortController();
      const command = tool.name === "powershell"
        ? "Write-Output ready; Start-Sleep -Seconds 30"
        : "printf ready; sleep 30";
      const call = tool.execute("run", { command, ...(end === "timeout" ? { timeout: 0.5 } : {}) }, controller.signal,
        update => {
          if (end === "abort" && JSON.stringify(update.content).includes("ready")) controller.abort();
        });
      await assert.rejects(call, end === "abort" ? /aborted/ : /timed out/);
    }
  });
}

test("successful shell commands stop background children before returning", {
  skip: process.platform === "win32", timeout: 10_000,
}, async t => {
  const { cwd, tools } = await fixture(t);
  const result = await tools[0]!.execute("background", {
    command: "sleep 30 > /dev/null 2>&1 & child=$!; printf '%s' \"$child\" > child.pid; printf done",
  });
  assert.match(JSON.stringify(result.content), /done/);
  const pid = Number(await readFile(join(cwd, "child.pid"), "utf8"));
  // A killed child can briefly remain a zombie until the host reaps it. Poll its
  // existence instead of relying on a scheduling delay or the shell's exit alone.
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch (error) { assert.equal((error as NodeJS.ErrnoException).code, "ESRCH"); return; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`Background process ${pid} survived shell completion`);
});
