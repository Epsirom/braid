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
  return args.includes("-z") ? stdout : stdout.trim();
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

/** Each execution owns a fresh worktree derived from immutable predecessor checkpoints. */
export class GitWorkspaces {
  private snapshots = new Map<string, Promise<Snapshot | undefined>>();
  private records = new Map<string, NodeWorkspace>();
  private locations = new Map<string, Snapshot>();
  private allocated = new Set<Snapshot>();
  private mergeParents = new Map<string, string[]>();

  constructor(
    private readonly cwd: string,
    private readonly onWorkspace?: (workspace: NodeWorkspace) => void,
  ) {}

  private report(workspace: NodeWorkspace): void {
    this.records.set(workspace.executionId ?? workspace.nodeId, workspace);
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

  private async snapshot(extraFiles: string[] = []): Promise<Snapshot | undefined> {
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
      // Include ignored files contributed by selected sources, without capturing the
      // caller's unrelated ignored build products or dependencies.
      const existing: string[] = [];
      for (const file of extraFiles) {
        try { await access(join(sourceRoot, file)); existing.push(file); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      for (let index = 0; index < existing.length; index += 256)
        await git(sourceRoot, ["add", "--force", "--all", "--", ...existing.slice(index, index + 256)], options);
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

  /** Freeze the job's root snapshot before any invocation can write to the checkout. */
  async initialize(runId: string): Promise<void> {
    if (!this.snapshots.has(runId)) this.snapshots.set(runId, this.snapshot());
    await this.snapshots.get(runId);
  }

  private id(request: ModelRequest): string {
    return request.execution.executionId ?? request.node.id;
  }

  private async inputCommit(request: ModelRequest, snapshot: Snapshot): Promise<string> {
    const commits = [...new Set(request.predecessors.map(value => value.workspace?.checkpointCommit).filter((value): value is string => !!value))];
    if (!commits.length) return snapshot.snapshotCommit;
    const trees = await Promise.all(commits.map(commit => git(snapshot.sourceRoot, ["rev-parse", `${commit}^{tree}`])));
    if (new Set(trees).size === 1) return commits[0]!;
    for (const candidate of commits) {
      let containsAll = true;
      for (const ancestor of commits) {
        try { await git(snapshot.sourceRoot, ["merge-base", "--is-ancestor", ancestor, candidate]); }
        catch (error) {
          if ((error as { code?: number }).code !== 1) throw error;
          containsAll = false;
          break;
        }
      }
      if (containsAll) return candidate;
    }
    throw new WorkspaceInputError("Multiple independent predecessor snapshots require an explicit merge node");
  }

  async prepare(request: ModelRequest, merge = false): Promise<NodeWorkspace> {
    request.signal.throwIfAborted();
    await this.initialize(request.execution.runId);
    const snapshot = await this.snapshots.get(request.execution.runId);
    const executionId = this.id(request);
    if (!snapshot) {
      const workspace: NodeWorkspace = {
        nodeId: request.node.id, executionId, mode: "read-only", workingDirectory: this.cwd, state: "ready",
      };
      this.report(workspace);
      return workspace;
    }
    const commit = merge ? snapshot.snapshotCommit : await this.inputCommit(request, snapshot);
    request.signal.throwIfAborted();
    const worktreeRoot = join(snapshot.directory, crypto.randomUUID());
    const readOnly = request.node.type !== "merge" && request.node.type !== "integrate" && request.node.workspace === "read-only";
    const workspace: NodeWorkspace = {
      nodeId: request.node.id, executionId, mode: readOnly ? "read-only" : "worktree", state: "preparing",
      sourceRoot: snapshot.sourceRoot, worktreeRoot,
      workingDirectory: resolve(worktreeRoot, snapshot.cwdSuffix),
      snapshotCommit: commit,
      ...(snapshot.baseCommit ? { baseCommit: snapshot.baseCommit } : {}),
    };
    this.locations.set(executionId, snapshot);
    this.report(workspace);
    try {
      await withWorktreeLock(snapshot.commonDirectory, async () => {
        request.signal.throwIfAborted();
        await git(snapshot.sourceRoot, ["worktree", "add", "--detach", worktreeRoot, commit], {
          hooksDirectory: snapshot.hooksDirectory,
        });
      });
      await mkdir(workspace.workingDirectory, { recursive: true });
      workspace.state = "ready";
    } catch (error) {
      workspace.state = "failed";
      throw new Error(`Cannot prepare isolated execution worktree at ${worktreeRoot}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    } finally {
      this.report(workspace);
    }
    request.signal.throwIfAborted();
    return workspace;
  }

  /** Seal before releasing any downstream execution, including failures with partial writes. */
  async seal(request: ModelRequest): Promise<void> {
    try { await this.sealCheckpoint(request); }
    catch (error) { throw new WorkspaceCheckpointError(error instanceof Error ? error.message : String(error), { cause: error }); }
  }

  private async sealCheckpoint(request: ModelRequest): Promise<void> {
    const workspace = this.records.get(this.id(request));
    if (!workspace || workspace.checkpointRef || workspace.state === "failed") return;
    if (workspace.mode === "integrate") {
      const baseline = (await this.snapshots.get(request.execution.runId))!;
      const selected = this.mergeParents.get(this.id(request)) ?? [];
      const files = new Set<string>();
      for (const commit of selected) {
        const paths = await git(baseline.sourceRoot, ["diff", "--name-only", "-z", baseline.snapshotCommit, commit, "--"]);
        for (const path of paths.split("\0").filter(Boolean)) files.add(path);
      }
      const after = await this.snapshot([...files]);
      if (!after) throw new Error("Integration checkout disappeared");
      const parents = [...new Set([after.snapshotCommit, ...selected])];
      const commit = parents.length === 1 ? after.snapshotCommit : await git(after.sourceRoot, [
        "-c", "user.name=Braid", "-c", "user.email=braid@localhost", "-c", "commit.gpgsign=false",
        "commit-tree", after.snapshotTree, ...parents.flatMap(parent => ["-p", parent]), "-m", "Braid integration checkpoint",
      ], { hooksDirectory: after.hooksDirectory });
      workspace.checkpointCommit = commit;
      workspace.checkpointRef = `refs/braid/checkpoints/${crypto.randomUUID()}`;
      await git(after.sourceRoot, ["update-ref", workspace.checkpointRef, commit]);
      this.report(workspace);
    } else if (workspace.worktreeRoot) {
      await this.checkpoint(workspace);
    }
  }

  all(): Record<string, NodeWorkspace> {
    return structuredClone(Object.fromEntries(this.records));
  }

  pending(): string[] {
    return [...this.records.values()]
      .filter(workspace => workspace.worktreeRoot && ["preparing", "ready", "failed"].includes(workspace.state))
      .map(workspace => workspace.executionId ?? workspace.nodeId);
  }

  /** Checkpoint every file, including ignored node outputs, before releasing a worktree. */
  private async checkpoint(workspace: NodeWorkspace): Promise<void> {
    if (workspace.checkpointRef) return;
    const location = this.locations.get(workspace.executionId ?? workspace.nodeId)!;
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
    const baseTree = await git(cwd, ["rev-parse", `${workspace.snapshotCommit}^{tree}`]);
    const parents = [...new Set([workspace.snapshotCommit!, ...(this.mergeParents.get(workspace.executionId ?? workspace.nodeId) ?? [])])];
    const commit = tree === baseTree && parents.length === 1 ? workspace.snapshotCommit! : await git(cwd, [
      "-c", "user.name=Braid", "-c", "user.email=braid@localhost", "-c", "commit.gpgsign=false",
      "commit-tree", tree, ...parents.flatMap(parent => ["-p", parent]), "-m", `Braid node checkpoint: ${workspace.nodeId}`,
    ], options);
    const suffix = createHash("sha256").update(cwd).digest("hex");
    const ref = `refs/braid/checkpoints/${suffix}`;
    await git(cwd, ["update-ref", ref, commit], options);
    workspace.checkpointCommit = commit;
    workspace.checkpointRef = ref;
    this.report(workspace);
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
        !!workspace.worktreeRoot && this.locations.get(workspace.executionId ?? workspace.nodeId) === snapshot &&
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
    if (!gitCommands(request.node.type === "merge" || request.node.type === "integrate").includes(command))
      throw unavailableGitCommand(command, request.node.type === "merge" || request.node.type === "integrate");
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
      : workspace.mode === "integrate" ? workspace.sourceRoot! : workspace.worktreeRoot!;
    const location = this.locations.get(this.id(request));
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
    await this.initialize(request.execution.runId);
    const baseline = await this.snapshots.get(request.execution.runId);
    const integrating = request.node.type === "integrate";
    const unlock = integrating && baseline ? await lock(baseline.sourceRoot, request.signal) : () => {};
    let finished = false;
    let resolutions: MergeDisposition[] = [];
    const ids = [...new Set(sourceIds)].filter(id => this.records.get(id)?.checkpointRef);
    try {
      request.signal.throwIfAborted();
      if (integrating && baseline) {
        const before = (await this.snapshot())!;
        const workspace: NodeWorkspace = {
          nodeId: request.node.id, executionId: this.id(request), mode: "integrate",
          workingDirectory: resolve(before.sourceRoot, before.cwdSuffix), sourceRoot: before.sourceRoot,
          snapshotCommit: before.snapshotCommit, state: "ready",
          backupRef: `refs/braid/merge-backups/${crypto.randomUUID()}`,
        };
        await git(before.sourceRoot, ["update-ref", workspace.backupRef!, before.snapshotCommit]);
        this.locations.set(this.id(request), before);
        this.report(workspace);
        request.workspace = workspace;
      } else {
        request.workspace = await this.prepare(request, true);
      }
      const target = request.workspace.worktreeRoot ?? request.workspace.sourceRoot;
      const sources: MergeSource[] = [];
      for (const id of ids) {
        const source = this.records.get(id)!;
        const diffArgs = ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", baseline!.snapshotCommit, source.checkpointRef!, "--"];
        const count = Math.max(1, ids.length);
        const files = await gitPreview(source.sourceRoot!, [...diffArgs.slice(0, -1), "--name-only", "-z", "--"], Math.floor(8_000 / count));
        const stat = await gitPreview(source.sourceRoot!, [...diffArgs.slice(0, -1), "--stat", "--"], Math.floor(4_000 / count));
        const diff = await gitPreview(source.sourceRoot!, diffArgs, Math.min(6_000, Math.floor(24_000 / count)));
        const names = files.text.slice(0, files.text.lastIndexOf("\0") + 1).split("\0").filter(Boolean);
        sources.push({ ...source, changes: { files: names, filesTruncated: files.truncated, stat, diff } });
      }
      const sourceStatus = integrating && target ? await gitPreview(target, ["status", "--porcelain=v1", "--untracked-files=all"], 4_000) : undefined;
      return {
        sources,
        ...(sourceStatus ? { sourceStatus: { ...sourceStatus, dirty: sourceStatus.text.length > 0 || sourceStatus.truncated } } : {}),
        finish: async decisions => {
          request.signal.throwIfAborted();
          if (finished) throw new Error("finish_merge must be called exactly once");
          validateMergeDispositions(ids, decisions);
          if (target && await git(target, ["ls-files", "--unmerged"])) throw new Error("Unresolved Git conflicts remain in the target workspace");
          resolutions = structuredClone(decisions);
          const workspace = this.records.get(this.id(request))!;
          workspace.dispositions = structuredClone(decisions);
          this.report(workspace);
          finished = true;
        },
        complete: async success => {
          try {
            if (target && await git(target, ["ls-files", "--unmerged"])) throw new Error("Unresolved Git conflicts remain in the target workspace");
            if (success && (!finished || resolutions.some(value => value.disposition === "archived")))
              throw new Error("Merge agent did not integrate or explicitly discard every source");
            if (success) this.mergeParents.set(this.id(request), resolutions.filter(value => value.disposition === "integrated").map(value => this.records.get(value.executionId)!.checkpointCommit!));
          } finally {
            try { await this.seal(request); } finally { unlock(); }
          }
        },
      };
    } catch (error) { unlock(); throw error; }
  }
}

export class WorkspaceInputError extends Error {}
export class WorkspaceCheckpointError extends Error {}
