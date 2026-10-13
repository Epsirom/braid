import { Context } from "@deepseek-ai/cordis";
import type { ContentBlock, ToolCallId, ToolSchema } from "@deepseek-ai/dsh-llm";
import SystemPrompt, { renderPrompt } from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import { FsError, type FsEditRequest, type FsTarget, type FsVersion, type FsWriteIntent } from "@deepseek-ai/dsh-fs";
import { LocalFileSystem } from "@deepseek-ai/dsh-fs-local";
import type { ShellExecSpec, ShellExecution } from "@deepseek-ai/dsh-shell";
import { LocalBashExecutor } from "@deepseek-ai/dsh-bash-local";
import { PwshLocalExecutor } from "@deepseek-ai/dsh-pwsh-local";
import LocalSubprocessRuntime from "@deepseek-ai/dsh-subprocess-local";
import * as ShellEnv from "@deepseek-ai/dsh-shell-env";
import * as ObservationPolicy from "@deepseek-ai/dsh-fs-observation-policy";
import * as ToolFs from "@deepseek-ai/dsh-tool-fs";
import * as ToolFsSearch from "@deepseek-ai/dsh-tool-fs-search";
import * as ToolBash from "@deepseek-ai/dsh-tool-bash";
import * as ToolPwsh from "@deepseek-ai/dsh-tool-pwsh";
import type { ModelRequest, NodeWorkspace } from "@chrok/braid";
import { createWriteBoundary } from "./write-tools.js";

/** Tools that change the workspace and therefore run under the core write lock. */
const WRITE_TOOLS = new Set(["write", "edit", "bash", "pwsh"]);
const OUTPUT_POLL_MS = 100;

export interface WorkerToolCall {
  id: ToolCallId;
  name: string;
  arguments: unknown;
}

export interface WorkerToolResult {
  content: ContentBlock[];
  isError: boolean;
}

export interface WorkerTools {
  /** Model-facing schemas, exactly as DSH declares its native tools. */
  definitions: ToolSchema[];
  /** DSH's own guidance sections for the offered tools. */
  guidance: string;
  writes(name: string): boolean;
  /** onOutput receives incremental shell output while a command runs. */
  execute(call: WorkerToolCall, signal: AbortSignal, onOutput?: (output: string) => void): Promise<WorkerToolResult>;
  /** Stops any processes the tools left behind before the workspace is checkpointed. */
  dispose(): Promise<void>;
}

/**
 * Run DSH's native read/write/edit/glob/grep/bash tools for one Braid execution.
 * Each execution gets a private Cordis context rooted at its workspace: Braid
 * supplies the filesystem write boundary and live output, DSH owns the tool
 * schemas, validation, execution, and model-facing results.
 */
export async function createWorkerTools(request: ModelRequest, workspace: NodeWorkspace): Promise<WorkerTools> {
  const cwd = workspace.workingDirectory;
  const root = workspace.mode === "read-only" ? undefined : workspace.mode === "integrate" ? workspace.sourceRoot : workspace.worktreeRoot;
  const check = root ? await createWriteBoundary(root, request.signal, async () => {
    if (!request.git) return [];
    const result = await request.git(["ls-files", "--stage", "-z"]);
    if (result.exitCode !== 0) throw new Error("Cannot validate submodule write boundaries");
    return result.stdout.split("\0").filter(entry => entry.startsWith("160000 ")).map(entry => entry.slice(entry.indexOf("\t") + 1));
  }) : undefined;
  const guard = async (target: FsTarget): Promise<void> => {
    try {
      if (!check) throw new Error("This Braid node is read-only");
      await check(target.displayPath);
    } catch (error) {
      if (error instanceof FsError) throw error;
      throw new FsError(error instanceof Error ? error.message : String(error), "FS_PERMISSION_DENIED", { cause: error });
    }
  };
  class WorkspaceFileSystem extends LocalFileSystem {
    override async writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal) {
      await guard(target);
      return super.writeText(target, content, expected, signal);
    }
    override async editText(target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion }, signal?: AbortSignal) {
      await guard(target);
      return super.editText(target, edit, expected, signal);
    }
  }

  // Calls run one at a time, so the active call owns the live output stream.
  let onOutput: ((output: string) => void) | undefined;
  const forwarding: Promise<void>[] = [];
  const observe = (execution: ShellExecution): ShellExecution => {
    if (onOutput) forwarding.push(forward(execution, onOutput));
    return execution;
  };
  class ObservedBash extends LocalBashExecutor {
    override async execute(spec: ShellExecSpec) { return observe(await super.execute(spec)); }
  }
  class ObservedPwsh extends PwshLocalExecutor {
    override async execute(spec: ShellExecSpec) { return observe(await super.execute(spec)); }
  }

  const ctx = new Context();
  try {
    await ctx.plugin(LocalSubprocessRuntime);
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(ToolRuntime, { mode: "native" });
    await ctx.plugin(WorkspaceFileSystem, { cwd });
    await ctx.plugin(ObservationPolicy);
    await ctx.plugin(ToolFs);
    await ctx.plugin(ToolFsSearch, { sampleOverCapGlobResults: true });
    if (root) {
      await ctx.plugin(ShellEnv);
      await ctx.plugin(ObservedBash, { cwd });
      await ctx.plugin(ToolBash);
      if (process.platform === "win32") {
        // Each shell tool talks to its own executor.
        const pwsh = ctx.isolate("shell");
        await pwsh.plugin(ObservedPwsh, { cwd });
        await pwsh.plugin(ToolPwsh);
      }
    }
  } catch (error) {
    await ctx.fiber.dispose();
    throw error;
  }

  const offered = (name: string) => root !== undefined || !WRITE_TOOLS.has(name);
  const definitions = ctx.tools.schemas().filter(tool => offered(tool.name));
  const assembly = await ctx.systemPrompt.assemble();
  const guidance = renderPrompt({ ...assembly, contexts: [], sections: assembly.sections.filter(section =>
    section.name.startsWith("tool:") && offered(section.name.slice("tool:".length))) });
  // The worker's own model-facing identity: tool cwd follows the agent session.
  const agent = { id: `braid-${request.execution.executionId}`, session: { header: { cwd } } } as never;

  return {
    definitions, guidance,
    writes: name => WRITE_TOOLS.has(name),
    async execute(call, signal, output) {
      if (!offered(call.name) || !definitions.some(tool => tool.name === call.name))
        return { isError: true, content: [{ type: "text", text: `Unavailable tool '${call.name}'. Available: ${definitions.map(tool => tool.name).join(", ")}` }] };
      onOutput = output;
      try {
        const result = await ctx.tools.execute({ callId: call.id, name: call.name, arguments: call.arguments, agent, signal });
        // Deliver the command's last output before its result.
        await Promise.all(forwarding.splice(0));
        return { content: result.content, isError: result.isError };
      } finally { onOutput = undefined; forwarding.length = 0; }
    },
    dispose: () => ctx.fiber.dispose(),
  };
}

/** Mirror a running command's stdout/stderr into Braid's live activity. */
async function forward(execution: ShellExecution, emit: (output: string) => void): Promise<void> {
  const offsets = { stdout: 0, stderr: 0 };
  let done = false;
  const finished = execution.done.then(() => { done = true; }, () => { done = true; });
  const drain = () => {
    for (const stream of ["stdout", "stderr"] as const) {
      const read = execution.observed[stream].readFrom(offsets[stream]);
      offsets[stream] = read.nextOffset;
      if (read.text) { try { emit(read.text); } catch { /* Observers cannot affect the command. */ } }
    }
  };
  while (!done) {
    drain();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([finished, new Promise(resolve => { timer = setTimeout(resolve, OUTPUT_POLL_MS); })]);
    clearTimeout(timer);
  }
  drain();
}
