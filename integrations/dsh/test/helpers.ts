import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { after } from "node:test";
import type { GenerateOptions, StreamChunk, LlmRuntime, ToolCallBlock } from "@deepseek-ai/dsh-llm";

const directories: string[] = [];
after(() => { for (const directory of directories) rmSync(directory, { recursive: true, force: true }); });
export function directory(git = false): string {
  const cwd = mkdtempSync(join(tmpdir(), "braid-dsh-test-")); directories.push(cwd);
  if (git) {
    for (const args of [["init", "-b", "main"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.com"]])
      execFileSync("git", args, { cwd, stdio: "ignore" });
    writeFileSync(join(cwd, "file.txt"), "original\n");
    execFileSync("git", ["add", "."], { cwd }); execFileSync("git", ["commit", "-m", "initial"], { cwd, stdio: "ignore" });
  }
  return cwd;
}
export const input = { goal: "Test", nodes: [{ type: "execute" as const, id: "a", prompt: "Do work" }], edges: [] };
export const context = (cwd = directory()) => ({ cwd, model: "fake/model/with/slashes" });
export function answer(text = "done"): StreamChunk[] {
  return [{ type: "text-delta", index: 0, text },
    { type: "usage", usage: { inputTokens: 2, outputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 1 } },
    { type: "finish", reason: { kind: "stop" } }];
}
export function calls(...entries: { name: string; args: object }[]): StreamChunk[] {
  return [...entries.map(({ name, args }, index): StreamChunk => ({ type: "block-end", index,
    block: { type: "tool-call", id: `call-${index}` as ToolCallBlock["id"], name, arguments: JSON.stringify(args) } })),
    { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } }, { type: "finish", reason: { kind: "tool-calls" } }];
}
export function llm(respond: (options: GenerateOptions, index: number) => StreamChunk[] | Promise<StreamChunk[]> = () => answer()): Pick<LlmRuntime, "stream"> {
  let index = 0;
  return { async *stream(options) { for (const chunk of await respond(options, index++)) yield chunk; } };
}
export function payload(options: GenerateOptions) {
  return JSON.parse((options.messages[0]!.content[0] as { text: string }).text);
}
export async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Test condition timed out");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
