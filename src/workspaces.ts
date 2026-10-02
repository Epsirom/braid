import { execFile } from "node:child_process";
import { access, copyFile, mkdtemp, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import type { GitPreview, GitResult, MergeDisposition, MergeSource, ModelRequest, NodeWorkspace, SourceCheckoutStatus } from "./types.js";
import { gitCommands, unavailableGitCommand, validateMergeDispositions } from "./merge-tools.js";

const exec = promisify(execFile);

const mergeLocks = new Map<string, Promise<void>>();
const worktreeLocks = new Map<string, Promise<void>>();

/** Git worktree add/remove expose intermediate shared registration files. */
async function withWorktreeLock<T>(commonDirectory: string, operation: () => Promise<T>): Promise<T> {
  const previous = worktreeLocks.get(commonDirectory) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.then(() => gate);
  worktreeLocks.set(commonDirectory, tail);
  await previous;
  try { return await operation(); }
  finally {
    release();
    if (worktreeLocks.get(commonDirectory) === tail) worktreeLocks.delete(commonDirectory);
  }
}

async function lock(root: string, signal: AbortSignal): Promise<() => void> {
  const previous = mergeLocks.get(root) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  // A cancelled waiter must not let later callers bypass the current owner.
  const next = previous.then(() => gate);
  mergeLocks.set(root, next);
  void next.then(() => {
    if (mergeLocks.get(root) === next) mergeLocks.delete(root);
  });
  let onAbort!: () => void;
  try {
    await Promise.race([previous, new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    })]);
    signal.throwIfAborted();
    return release;
  } catch (error) { release(); throw error; }
  finally { signal.removeEventListener("abort", onAbort); }
}

interface Snapshot {
  directory: string;
  commonDirectory: string;
  sourceRoot: string;
  cwdSuffix: string;
  baseCommit?: string;
  snapshotTree: string;
  snapshotCommit: string;
  hooksDirectory: string;
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"])
    delete env[key];
  return env;
}

async function git(
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal; hooksDirectory?: string } = {},
): Promise<string> {
  const { stdout } = await exec("git", [
    ...(options.hooksDirectory ? ["-c", `core.hooksPath=${options.hooksDirectory}`] : []),
    "-C", cwd, ...args,
  ], {
    env: { ...gitEnvironment(), ...options.env },
    ...(options.signal ? { signal: options.signal } : {}),
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim();
}

/** Read-only, bounded output. A large diff cannot fail workspace preparation or flood the model. */
async function gitPreview(cwd: string, args: string[], limit: number): Promise<GitPreview> {
  let output: string;
  let overflow = false;
  try {
    const result = await exec("git", ["-c", "core.fsmonitor=false", "--no-optional-locks", "--no-pager", "-C", cwd, ...args], {
      env: gitEnvironment(), maxBuffer: Math.max(64 * 1024, limit * 4), encoding: "utf8",
    });
    output = result.stdout;
  } catch (error) {
    const failure = error as { code?: string; stdout?: string };
    if (failure.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || typeof failure.stdout !== "string") throw error;
    output = failure.stdout;
    overflow = true;
  }
  return { text: output.slice(0, limit), truncated: overflow || output.length > limit };
}

/** Writable workers share a snapshot; explicit read-only workers inspect the live cwd. */
export class GitWorkspaces {
  private snapshots = new Map<string, Promise<Snapshot | undefined>>();
  private records = new Map<string, NodeWorkspace>();
  private locations = new Map<string, Snapshot>();
  private allocated = new Set<Snapshot>();

  constructor(
    private readonly cwd: string,
    private readonly onWorkspace?: (workspace: NodeWorkspace) => void,
  ) {}

  private report(workspace: NodeWorkspace): void {
    this.records.set(workspace.nodeId, workspace);
    try {
      this.onWorkspace?.({ ...workspace });
    } catch {
      // Observers cannot change permissions or fail node execution.
    }
  }

  private async sourceRoot(): Promise<string | undefined> {
    let ancestor = resolve(this.cwd);
    while (true) {
      try { await access(join(ancestor, ".git")); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = dirname(ancestor);
        if (parent === ancestor) return undefined;
        ancestor = parent;
      }
    }
    let sourceRoot: string;
    try {
      sourceRoot = await git(this.cwd, ["rev-parse", "--show-toplevel"]);
    } catch (error) {
      const failure = error as { code?: string | number; stderr?: string };
      if (failure.code === "ENOENT" || /not a git repository|must be run in a work tree/i.test(failure.stderr ?? ""))
        return undefined;
      throw error;
    }
    return realpath(sourceRoot);
  }

  private async snapshot(): Promise<Snapshot | undefined> {
    const sourceRoot = await this.sourceRoot();
    if (!sourceRoot) return undefined;
    const commonDirectory = await realpath(resolve(sourceRoot, await git(sourceRoot, ["rev-parse", "--git-common-dir"])));
    const cwdSuffix = relative(sourceRoot, await realpath(this.cwd));
    // Git records canonical worktree paths. In particular, Windows tmpdir()
    // can contain an 8.3 alias that Git later rejects for lock/remove commands.
    const directory = await realpath(await mkdtemp(join(tmpdir(), "braid-workspaces-")));
    const hooksDirectory = join(directory, "hooks");
    await mkdir(hooksDirectory);
    const index = join(directory, "snapshot-index");
    const options = { env: { GIT_INDEX_FILE: index }, hooksDirectory };
    try {
      let baseCommit: string | undefined;
      try {
        baseCommit = await git(sourceRoot, ["rev-parse", "--verify", "HEAD^{commit}"]);
      } catch {
        // An initialized repository without commits can still supply a snapshot.
        const head = await git(sourceRoot, ["symbolic-ref", "HEAD"]);
        const refs = await git(sourceRoot, ["for-each-ref", "--format=%(refname)", head]);
        if (refs) throw new Error("Cannot resolve the Git repository's HEAD");
      }
      const sourceIndex = resolve(sourceRoot, await git(sourceRoot, ["rev-parse", "--git-path", "index"]));
      try {
        // Preserve staged additions, including files explicitly tracked despite
        // ignore rules. Starting from HEAD would silently omit those files.
        await copyFile(sourceIndex, index);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await git(sourceRoot, ["read-tree", "--empty"], options);
      }
      // A temporary index captures tracked edits/deletions and non-ignored new files
      // without changing the parent's real index, branch, or working files.
      await git(sourceRoot, ["add", "--all", "--", "."], options);
      const tree = await git(sourceRoot, ["write-tree"], options);
      const baseTree = baseCommit ? await git(sourceRoot, ["rev-parse", `${baseCommit}^{tree}`]) : undefined;
      const snapshotCommit = tree === baseTree ? baseCommit! : await git(sourceRoot, [
        "-c", "user.name=Braid", "-c", "user.email=braid@localhost",
        "-c", "commit.gpgsign=false", "commit-tree", tree,
        ...(baseCommit ? ["-p", baseCommit] : []),
        "-m", "Braid isolated workspace snapshot",
      ], options);
      const snapshot: Snapshot = {
        directory, commonDirectory, sourceRoot, cwdSuffix, snapshotTree: tree, snapshotCommit, hooksDirectory,
        ...(baseCommit ? { baseCommit } : {}),
      };
      this.allocated.add(snapshot);
      return snapshot;
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    } finally {
      await rm(index, { force: true });
      await rm(`${index}.lock`, { force: true });
    }
  }

  async prepare(request: ModelRequest): Promise<NodeWorkspace> {
    request.signal.throwIfAborted();
    if (request.node.type !== "merge" && request.node.workspace === "read-only") {
      const sourceRoot = await this.sourceRoot();
      request.signal.throwIfAborted();
      const workspace: NodeWorkspace = {
        nodeId: request.node.id, mode: "read-only", workingDirectory: this.cwd, state: "ready",
        ...(sourceRoot ? { sourceRoot } : {}),
      };
      this.report(workspace);
      return workspace;
    }
    let pending = this.snapshots.get(request.execution.runId);
    if (!pending) {
      // Do not bind the shared snapshot to one node's cancellation signal.
      pending = this.snapshot();
      this.snapshots.set(request.execution.runId, pending);
    }
    const snapshot = await pending;
    request.signal.throwIfAborted();
    if (!snapshot) {
      const workspace: NodeWorkspace = {
        nodeId: request.node.id, mode: "read-only", workingDirectory: this.cwd, state: "ready",
      };
      this.report(workspace);
      return workspace;
    }
    const worktreeRoot = join(snapshot.directory, crypto.randomUUID());
    const workspace: NodeWorkspace = {
      nodeId: request.node.id, mode: "worktree", state: "preparing",
      sourceRoot: snapshot.sourceRoot, worktreeRoot,
      workingDirectory: resolve(worktreeRoot, snapshot.cwdSuffix),
      snapshotCommit: snapshot.snapshotCommit,
      ...(snapshot.baseCommit ? { baseCommit: snapshot.baseCommit } : {}),
    };
    this.locations.set(request.node.id, snapshot);
    this.report(workspace);
    try {
      // Finish registration even if cancellation arrives during creation. Report
      // the retained path before observing cancellation, so it can be recovered.
      await withWorktreeLock(snapshot.commonDirectory, async () => {
        request.signal.throwIfAborted();
        await git(snapshot.sourceRoot, ["worktree", "add", "--detach", worktreeRoot, snapshot.snapshotCommit], {
          hooksDirectory: snapshot.hooksDirectory,
        });
      });
      // The original cwd may be an empty or ignored directory absent from Git.
      await mkdir(workspace.workingDirectory, { recursive: true });
      workspace.state = "ready";
    } catch (error) {
      workspace.state = "failed";
      throw new Error(`Cannot prepare isolated node worktree at ${worktreeRoot}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    } finally {
      this.report(workspace);
    }
    request.signal.throwIfAborted();
    return workspace;
  }

  all(): Record<string, NodeWorkspace> {
    return Object.fromEntries([...this.records].map(([id, workspace]) => [id, { ...workspace }]));
  }

  pending(): string[] {
    return [...this.records.values()]
      .filter(workspace => workspace.mode === "worktree" && ["preparing", "ready", "failed"].includes(workspace.state))
      .map(workspace => workspace.nodeId);
  }

  /** Checkpoint every file, including ignored node outputs, before releasing a worktree. */
  private async checkpoint(workspace: NodeWorkspace): Promise<void> {
    if (workspace.checkpointRef) return;
    const location = this.locations.get(workspace.nodeId)!;
    const cwd = workspace.worktreeRoot!;
    const options = { hooksDirectory: location.hooksDirectory };
    // A Git tree stores only a submodule commit, never files written inside it.
    // Refuse destructive cleanup if an external/custom runner populated one.
    const entries = (await git(cwd, ["ls-files", "--stage", "-z"])).split("\0");
    for (const entry of entries.filter(entry => entry.startsWith("160000 "))) {
      const path = entry.slice(entry.indexOf("\t") + 1);
      try {
        if ((await readdir(join(cwd, path))).length)
          throw new Error(`Cannot checkpoint populated submodule '${path}'; worktree retained at ${cwd}`);
      } catch (error) {
        if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
    }
    await git(cwd, ["add", "--force", "--all", "--", "."], options);
    const tree = await git(cwd, ["write-tree"], options);
    const commit = tree === location.snapshotTree ? workspace.snapshotCommit! : await git(cwd, [
      "-c", "user.name=Braid", "-c", "user.email=braid@localhost", "-c", "commit.gpgsign=false",
      "commit-tree", tree, "-p", workspace.snapshotCommit!, "-m", `Braid node checkpoint: ${workspace.nodeId}`,
    ], options);
    const suffix = createHash("sha256").update(cwd).digest("hex");
    const ref = `refs/braid/checkpoints/${suffix}`;
    await git(cwd, ["update-ref", ref, commit], options);
    workspace.checkpointCommit = commit;
    workspace.checkpointRef = ref;
    this.report(workspace);
  }

  /** Run only after declared nodes settle, so consumers retain their source paths. */
  async discardUnchanged(): Promise<void> {
    const errors: unknown[] = [];
    for (const id of this.pending()) {
      const workspace = this.records.get(id)!;
      // Incomplete preparation must follow the existing failure/recovery path.
      // A failed invocation with a successfully prepared workspace is still ready.
      if (workspace.state !== "ready") continue;
      try {
        await this.checkpoint(workspace);
        if (workspace.checkpointCommit === workspace.snapshotCommit)
          await this.release(id, "discarded", "No changes from snapshot");
      } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Some workspaces could not be checked or removed; their paths are retained in workspaces");
  }

  private async release(id: string, disposition: MergeDisposition["disposition"], reason: string): Promise<void> {
    const workspace = this.records.get(id)!;
    const location = this.locations.get(id)!;
    if (workspace.state === "failed") {
      try { await access(workspace.worktreeRoot!); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await withWorktreeLock(location.commonDirectory, async () => {
          const registrations = await git(location.sourceRoot, ["worktree", "list", "--porcelain", "-z"]);
          if (registrations.split("\0").some(field => field.startsWith("worktree ") &&
            relative(field.slice("worktree ".length), workspace.worktreeRoot!) === ""))
            await git(location.sourceRoot, ["worktree", "remove", "--force", workspace.worktreeRoot!]);
        });
        workspace.state = "archived";
        workspace.reason = "Worktree creation failed before a directory was available; no node changes to archive";
        this.report(workspace);
        return;
      }
    }
    await this.checkpoint(workspace);
    await withWorktreeLock(location.commonDirectory, () => git(location.sourceRoot, ["worktree", "remove", "--force", workspace.worktreeRoot!], {
      hooksDirectory: location.hooksDirectory,
    }));
    workspace.state = disposition;
    workspace.reason = reason;
    this.report(workspace);
  }

  /** Only archive/remove here. Choosing merge/cherry-pick/apply always belongs to the agent. */
  async archivePending(reason: string): Promise<void> {
    const errors: unknown[] = [];
    for (const id of this.pending()) {
      try { await this.release(id, "archived", reason); }
      catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Some workspaces could not be archived and removed; their paths are retained in workspaces");
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.snapshots.values());
    const errors: unknown[] = [];
    for (const snapshot of this.allocated) {
      // Ownership is explicit; a POSIX path prefix would miss retained Windows
      // worktrees and recursively delete data after checkpoint/cleanup failure.
      const live = [...this.records.values()].some(workspace =>
        workspace.mode === "worktree" && this.locations.get(workspace.nodeId) === snapshot &&
        ["ready", "preparing", "failed"].includes(workspace.state));
      if (!live) {
        try { await rm(snapshot.directory, { recursive: true, force: true }); }
        catch (error) { errors.push(error); }
      }
    }
    if (errors.length) throw new AggregateError(errors, "Some workspace temporary directories could not be removed");
  }

  async git(request: ModelRequest, args: string[], input?: string): Promise<GitResult> {
    request.signal.throwIfAborted();
    if (!Array.isArray(args) || args.length === 0 || args.some(arg => typeof arg !== "string" || arg.includes("\0")))
      throw new Error("git requires a nonempty array of string arguments");
    if (input !== undefined && typeof input !== "string") throw new Error("Git input must be a string");
    const mutate = ["add", "commit", "merge", "cherry-pick", "apply", "restore"];
    const command = args[0]!;
    if (!gitCommands(request.node.type === "merge").includes(command))
      throw unavailableGitCommand(command, request.node.type === "merge");
    const blockedOptions = ["--output", "--ext-diff", "--textconv", "--unsafe-paths", "--directory", "--strategy", "--gpg-sign", "--work-tree", "--git-dir"];
    // Git accepts abbreviated long options (e.g. --out) and attached short
    // values (-scustom). Apply the same boundary to those spellings.
    if (args.some(arg => {
      const option = arg.split("=")[0]!;
      return /^-[sSC]/.test(arg) ||
        (option.length > 2 && option.startsWith("--") && blockedOptions.some(blocked => blocked.startsWith(option)));
    }))
      throw new Error("Git arguments cannot override filesystem boundaries, execute external helpers, or select external strategies");
    const workspace = request.workspace!;
    const cwd = workspace.mode === "read-only" ? workspace.workingDirectory
      : workspace.mode === "merge" ? workspace.sourceRoot! : workspace.worktreeRoot!;
    const location = this.locations.get(request.node.id);
    const actualArgs = [command,
      ...(["diff", "show", "log"].includes(command) ? ["--no-ext-diff", "--no-textconv"] : []),
      ...args.slice(1),
    ];
    const execute = () => new Promise<GitResult>((resolve, reject) => {
      const child = execFile("git", [
        ...(location ? ["-c", `core.hooksPath=${location.hooksDirectory}`] : []),
        ...(workspace.mode === "read-only" ? ["--no-optional-locks"] : []),
        "-c", "commit.gpgsign=false",
        "-c", "core.fsmonitor=false", "--no-pager", "-C", cwd, ...actualArgs,
      ], {
        env: { ...gitEnvironment(), GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true", GIT_MERGE_AUTOEDIT: "no" },
        maxBuffer: 8 * 1024 * 1024,
      }, (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") reject(error);
        else resolve({ exitCode: error?.code as number ?? 0, stdout, stderr });
      });
      child.stdin?.end(input);
    });
    return mutate.includes(command) ? request.withWorkspaceWrite!(execute) : execute();
  }

  async beginMerge(request: ModelRequest, sourceIds: string[]): Promise<{
    sources: MergeSource[];
    sourceStatus?: SourceCheckoutStatus;
    finish: (dispositions: MergeDisposition[]) => Promise<void>;
    complete: (success: boolean) => Promise<void>;
  }> {
    // Discover the source without allocating a merge worktree: agents integrate
    // directly in the caller's checkout, under a repository-scoped mutex.
    let pending = this.snapshots.get(request.execution.runId);
    if (!pending) { pending = this.snapshot(); this.snapshots.set(request.execution.runId, pending); }
    let snapshot = await pending;
    const unlock = snapshot ? await lock(snapshot.sourceRoot, request.signal) : () => {};
    let finished = false;
    let resolutions: MergeDisposition[] | undefined;
    const ids = sourceIds.filter(id => this.pending().includes(id));
    try {
      request.signal.throwIfAborted();
      if (snapshot) {
        snapshot = await this.snapshot();
        this.snapshots.set(request.execution.runId, Promise.resolve(snapshot));
      }
      for (const id of ids) await this.checkpoint(this.records.get(id)!);
      const workspace: NodeWorkspace = snapshot ? {
        nodeId: request.node.id, mode: "merge", workingDirectory: snapshot.sourceRoot,
        sourceRoot: snapshot.sourceRoot, snapshotCommit: snapshot.snapshotCommit, state: "ready",
      } : { nodeId: request.node.id, mode: "read-only", workingDirectory: this.cwd, state: "ready" };
      if (snapshot) {
        workspace.backupRef = `refs/braid/merge-backups/${crypto.randomUUID()}`;
        await git(snapshot.sourceRoot, ["update-ref", workspace.backupRef, snapshot.snapshotCommit], { hooksDirectory: snapshot.hooksDirectory });
      }
      request.workspace = workspace;
      if (snapshot) this.locations.set(request.node.id, snapshot);
      this.report(workspace);
      const sourceStatus = snapshot ? await gitPreview(snapshot.sourceRoot, ["status", "--porcelain=v1", "--untracked-files=all"], 4_000) : undefined;
      const sources: MergeSource[] = [];
      for (const id of ids) {
        const source = this.records.get(id)!;
        const diffArgs = ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", source.snapshotCommit!, source.checkpointRef!, "--"];
        const count = Math.max(1, ids.length);
        const files = await gitPreview(source.sourceRoot!, [...diffArgs.slice(0, -1), "--name-only", "-z", "--"], Math.floor(8_000 / count));
        const stat = await gitPreview(source.sourceRoot!, [...diffArgs.slice(0, -1), "--stat", "--"], Math.floor(4_000 / count));
        const diff = await gitPreview(source.sourceRoot!, diffArgs, Math.min(6_000, Math.floor(24_000 / count)));
        // Truncated NUL output must not invent a partial filename.
        const names = files.text.slice(0, files.text.lastIndexOf("\0") + 1).split("\0").filter(Boolean);
        sources.push({ ...source, changes: { files: names, filesTruncated: files.truncated, stat, diff } });
      }
      return {
        sources,
        ...(sourceStatus ? { sourceStatus: { ...sourceStatus, dirty: sourceStatus.text.length > 0 || sourceStatus.truncated } } : {}),
        finish: async decisions => {
          request.signal.throwIfAborted();
          if (finished) throw new Error("finish_merge must be called exactly once");
          validateMergeDispositions(ids, decisions);
          if (snapshot && await git(snapshot.sourceRoot, ["ls-files", "--unmerged"]))
            throw new Error("Unresolved Git conflicts remain in the source checkout");
          resolutions = structuredClone(decisions);
          finished = true;
        },
        complete: async success => {
          try {
            const errors: unknown[] = [];
            // Check again after all tracked writes have drained: an adapter can
            // invoke more tools after finish_merge in the same model response.
            if (success && snapshot && await git(snapshot.sourceRoot, ["ls-files", "--unmerged"])) {
              success = false;
              errors.push(new Error("Unresolved Git conflicts remain in the source checkout"));
            }
            for (const id of ids) {
              const decision = success && finished ? resolutions!.find(value => value.nodeId === id)! : undefined;
              try {
                await this.release(id, decision?.disposition ?? "archived", decision?.reason ?? "Merge agent did not complete; changes preserved in checkpointRef");
              } catch (error) { errors.push(error); }
            }
            this.snapshots.delete(request.execution.runId);
            if (errors.length) throw new AggregateError(errors, "Some merge sources could not be cleaned up; their paths are retained in workspaces");
            if (success && (!finished || resolutions!.some(value => value.disposition === "archived")))
              throw new Error("Merge agent did not integrate or explicitly discard every source; remaining changes were archived");
          } finally { unlock(); }
        },
      };
    } catch (error) { unlock(); throw error; }
  }
}
