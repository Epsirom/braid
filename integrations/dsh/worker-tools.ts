import { readdir, open } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { Type, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { ModelRequest, NodeWorkspace } from "@chrok/braid";
import { createWriteOperations } from "./write-tools.js";
import { runCommand } from "./shell-tools.js";

export interface WorkerTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  writes: boolean;
  /** onOutput receives incremental command output where a tool produces it. */
  execute(args: unknown, onOutput?: (output: string) => void): Promise<string>;
}

export async function createWorkerTools(request: ModelRequest, workspace: NodeWorkspace): Promise<WorkerTool[]> {
  const cwd = workspace.workingDirectory, signal = request.signal;
  const tools: WorkerTool[] = [];
  function add<S extends TSchema>(name: string, description: string, parameters: S, writes: boolean, execute: (args: import("@sinclair/typebox").Static<S>, onOutput?: (output: string) => void) => Promise<string>) {
    tools.push({ name, description, parameters, writes, async execute(args, onOutput) {
      signal.throwIfAborted();
      if (!Value.Check(parameters, args)) throw new Error(`Invalid ${name} arguments: ${[...Value.Errors(parameters, args)].map(error => `${error.path} ${error.message}`).join("; ")}`);
      const result = await execute(args, onOutput);
      signal.throwIfAborted();
      return result;
    } });
  }
  const path = Type.String({ minLength: 1 });
  add("read", "Read a UTF-8 file, with optional byte offset. Returns at most 50 KB; use the next offset for more.", Type.Object({
    path, offset: Type.Optional(Type.Integer({ minimum: 0 })),
  }, { additionalProperties: false }), false, async args => {
    // Do not block opening a FIFO before the regular-file check can reject it.
    const file = await open(resolve(cwd, args.path), constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!(await file.stat()).isFile()) throw new Error("read requires a regular file");
      const buffer = Buffer.alloc(50_000);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, args.offset ?? 0);
      // Leave incomplete UTF-8 characters for the next window instead of corrupting them.
      const text = new TextDecoder().decode(buffer.subarray(0, bytesRead), { stream: bytesRead === buffer.length });
      const consumed = bytesRead === buffer.length ? Math.min(bytesRead, Buffer.byteLength(text)) : bytesRead;
      return JSON.stringify({ text, nextOffset: (args.offset ?? 0) + consumed, eof: bytesRead < buffer.length });
    } finally { await file.close(); }
  });
  add("ls", "List a directory (up to 1000 entries).", Type.Object({ path: Type.Optional(path) }, { additionalProperties: false }), false, async args => {
    const entries = await readdir(resolve(cwd, args.path ?? "."), { withFileTypes: true });
    return JSON.stringify({ entries: entries.slice(0, 1000).map(entry => entry.name + (entry.isDirectory() ? "/" : "")), truncated: entries.length > 1000 });
  });
  // Search is exposed only when rg is installed. No automatic downloads.
  try {
    execFileSync("rg", ["--version"], { stdio: "ignore", timeout: 2000 });
    add("grep", "Search file content using ripgrep. Output is bounded to the last 50 KB.", Type.Object({ pattern: Type.String(), path: Type.Optional(path) }, { additionalProperties: false }), false,
      args => runCommand("rg", ["--no-config", "-n", "--", args.pattern, args.path ?? "."], cwd, signal));
    add("find", "Find file paths by glob using ripgrep; respects ignore rules. Output is bounded to the last 50 KB.", Type.Object({ pattern: path }, { additionalProperties: false }), false,
      args => runCommand("rg", ["--no-config", "--files", "--glob", args.pattern], cwd, signal));
  } catch { /* ls and read remain available without rg. */ }
  const root = workspace.mode === "read-only" ? undefined : workspace.mode === "integrate" ? workspace.sourceRoot : workspace.worktreeRoot;
  if (root) {
    const writes = await createWriteOperations(cwd, root, signal, async () => {
      if (!request.git) return [];
      const result = await request.git(["ls-files", "--stage", "-z"]);
      if (result.exitCode !== 0) throw new Error("Cannot validate submodule write boundaries");
      return result.stdout.split("\0").filter(entry => entry.startsWith("160000 ")).map(entry => entry.slice(entry.indexOf("\t") + 1));
    });
    add("write", "Write a UTF-8 file inside the assigned workspace; create parent directories as needed.", Type.Object({ path, content: Type.String() }, { additionalProperties: false }), true, async args => {
      await writes.write(args.path, args.content); return "File written.";
    });
    add("edit", "Replace exactly one occurrence of oldText with newText in a workspace file.", Type.Object({ path, oldText: Type.String({ minLength: 1 }), newText: Type.String() }, { additionalProperties: false }), true, async args => {
      const content = await writes.read(args.path);
      const first = content.indexOf(args.oldText);
      if (first < 0 || content.indexOf(args.oldText, first + 1) >= 0) throw new Error("oldText must match exactly once");
      await writes.write(args.path, content.slice(0, first) + args.newText + content.slice(first + args.oldText.length));
      return "File edited.";
    });
    const shellParameters = Type.Object({ command: path, timeout: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 2_147_483.647 })) }, { additionalProperties: false });
    add("bash", "Run a foreground shell command in the assigned workspace. timeout is seconds. Output retains the last 50 KB. Host permissions apply; do not daemonize.", shellParameters, true,
      (args, onOutput) => runCommand("bash", ["-c", args.command], cwd, signal, args.timeout, onOutput));
    if (process.platform === "win32") add("powershell", "Run a foreground PowerShell command in the assigned workspace. timeout is seconds.", shellParameters, true,
      (args, onOutput) => runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", args.command], cwd, signal, args.timeout, onOutput));
  }
  return tools;
}
