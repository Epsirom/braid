import type {
  BraidInput,
  BraidLimits,
  BraidOptions,
  BraidResult,
  BraidRun,
  BraidSnapshot,
  GraphUpdate,
  NodeExecution,
  Edge,
  ExecutionError,
  ExecutionEvent,
  ExecutionSuspension,
  ModelRequest,
  ModelResponse,
  NodeOutput,
  NodeResult,
  NodeWorkspace,
  PauseOptions,
  PredecessorOutput,
  ReplanInput,
  ReplanSuggestion,
  ResumeOptions,
  CancelExecutionsOptions,
  BraidNode,
  WaitReason,
} from "./types.js";
import { compileGraph, edgeIdentity, type Graph } from "./validate.js";
import { GitWorkspaces, WorkspaceInputError, WorkspaceCheckpointError } from "./workspaces.js";
import { resolve } from "node:path";

class RunError extends Error {
  constructor(
    readonly code: ExecutionError["code"],
    message: string,
  ) {
    super(message);
    this.name = "BraidExecutionError";
  }
}

function describeError(error: unknown): ExecutionError {
  return {
    code: error instanceof RunError ? error.code : error instanceof WorkspaceInputError ? "WORKSPACE_MERGE_REQUIRED" : "MODEL_ERROR",
    message:
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "Model runner threw a non-Error value",
  };
}

function validateOptions(options: BraidOptions): void {
  if (!options || typeof options.runner !== "function")
    throw new TypeError("A model runner is required");
  if (options.cwd !== undefined && (typeof options.cwd !== "string" || !options.cwd.trim()))
    throw new TypeError("cwd must be a non-empty directory path");
  if (
    options.defaultModel !== undefined &&
    (typeof options.defaultModel !== "string" || !options.defaultModel.trim())
  ) {
    throw new TypeError("defaultModel must be a non-empty string");
  }
  if (
    options.signal !== undefined &&
    !(options.signal instanceof AbortSignal)
  ) {
    throw new TypeError("signal must be an AbortSignal");
  }
  if (options.onEvent !== undefined && typeof options.onEvent !== "function") {
    throw new TypeError("onEvent must be a function");
  }
  const concurrency =
    options.maxConcurrency === undefined ? 4 : options.maxConcurrency;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new TypeError("maxConcurrency must be a positive integer");
  }
  if (options.onNodeTimeout !== undefined && options.onNodeTimeout !== "pause" && options.onNodeTimeout !== "fail")
    throw new TypeError('onNodeTimeout must be "pause" or "fail"');
  if (options.onLimit !== undefined && options.onLimit !== "pause" && options.onLimit !== "fail")
    throw new TypeError('onLimit must be "pause" or "fail"');
  const value = options.nodeTimeoutMs;
  if (value !== undefined && value !== Infinity && (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647))
    throw new TypeError("nodeTimeoutMs must be Infinity or a positive number no greater than 2147483647");
  validateLimits(options);
}

const limitKeys = ["maxExecutions", "graphTimeoutMs", "maxTokens"] as const;

function validateLimits(limits: BraidLimits): void {
  for (const key of ["maxExecutions", "maxTokens"] as const) {
    const value = limits[key];
    if (value !== undefined && value !== Infinity && (!Number.isSafeInteger(value) || value < 1))
      throw new TypeError(`${key} must be Infinity or a positive integer`);
  }
  const value = limits.graphTimeoutMs;
  if (value !== undefined && value !== Infinity && (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 2_147_483_647))
    throw new TypeError("graphTimeoutMs must be Infinity or a positive number no greater than 2147483647");
}

type EdgeState = "unresolved" | "active" | "inactive" | "blocked";

type EventPayload = {
  [Type in ExecutionEvent["type"]]: Omit<
    Extract<ExecutionEvent, { type: Type }>,
    "sequence" | "timestamp"
  >;
}[ExecutionEvent["type"]];

interface EventLog {
  events: ExecutionEvent[];
  emit(payload: EventPayload): void;
}

function createEventLog(onEvent?: BraidOptions["onEvent"]): EventLog {
  const events: ExecutionEvent[] = [];
  let sequence = 0;
  return {
    events,
    emit(payload) {
      const event = Object.freeze({
        ...structuredClone(payload),
        sequence: ++sequence,
        timestamp: Date.now(),
      }) as ExecutionEvent;
      const nested: unknown[] = [event];
      while (nested.length) {
        const value = nested.pop();
        if (value && typeof value === "object") {
          Object.freeze(value);
          nested.push(...Object.values(value));
        }
      }
      if ("error" in event) Object.freeze(event.error);
      if ("usage" in event && event.usage) Object.freeze(event.usage);
      if ("terminalNodeIds" in event) Object.freeze(event.terminalNodeIds);
      if ("workspace" in event) Object.freeze(event.workspace);
      events.push(event);
      if (onEvent) {
        try {
          // Observe rejections too if a caller supplies an async callback; never await it.
          void Promise.resolve(onEvent(event)).catch(() => {});
        } catch {
          // Observers are diagnostic only and must never fail node execution.
        }
      }
    },
  };
}

function edgeState(edge: Edge, source?: NodeResult): EdgeState {
  if (!source) return "unresolved";
  switch (source.status) {
    case "completed": return edge.choice === undefined || edge.choice === source.decision ? "active" : "inactive";
    case "failed": return edge.choice === undefined ? "active" : "blocked";
    case "skipped": return source.skipReason === "inactive" ? "inactive" : "blocked";
    default: return "unresolved";
  }
}

function nodeOutput(result: NodeResult): NodeOutput {
  // Failed predecessors can have no valid response; preserve their error separately.
  const output: NodeOutput = { output: result.output ?? "" };
  if (result.decision !== undefined) output.decision = result.decision;
  if (result.model !== undefined) output.model = result.model;
  return output;
}

function checkResponse(response: ModelResponse): void {
  if (
    !response ||
    typeof response.output !== "string" ||
    (response.model !== undefined &&
      (typeof response.model !== "string" || !response.model.trim()))
  ) {
    throw new RunError(
      "INVALID_RESPONSE",
      "Runner must return a textual output and an optional model name",
    );
  }
  if (
    response.usage !== undefined &&
    (!response.usage ||
      !Number.isSafeInteger(response.usage.inputTokens) ||
      response.usage.inputTokens < 0 ||
      !Number.isSafeInteger(response.usage.outputTokens) ||
      response.usage.outputTokens < 0)
  ) {
    throw new RunError(
      "INVALID_RESPONSE",
      "Token usage must contain non-negative integer inputTokens/outputTokens",
    );
  }
}

/** How long an interrupted runner has to reach its next checkpoint before the execution fails. */
const INTERRUPT_GRACE_MS = 10_000;

/** What the scheduler can do to one running invocation. */
interface InvocationHandle {
  /** Replace the remaining node time budget, starting when the execution next passes a checkpoint. */
  renew(nodeTimeoutMs: number): void;
  /** Fail this execution only. */
  abort(error: RunError): void;
  /** The run's graph deadline changed; update the request's deadlines in place. */
  setGraphDeadline(deadline: number): void;
}

/** Scheduler hooks for one execution's suspension. */
interface SuspensionControl {
  /** Called once the invocation can be controlled. */
  attach(handle: InvocationHandle): void;
  /** At a checkpoint: undefined to continue, or a promise that resolves once resumed with a slot. */
  suspend(): Promise<void> | undefined;
  /** The node timeout ran out under the pause policy: request a timeout pause. */
  timedOut(timeout: NonNullable<ExecutionSuspension["timeout"]>): void;
  /** The runner has returned or thrown; drop any suspension state. */
  finished(): void;
}

async function runNode(
  request: Omit<ModelRequest, "signal" | "decide">,
  result: NodeResult,
  runner: BraidOptions["runner"],
  timeoutMs: number,
  graphSignal: AbortSignal,
  /** The current graph deadline; setLimits can move it. */
  graphDeadline: () => number,
  /** False when the scheduler pauses the run at the graph deadline instead of failing it. */
  enforceGraphDeadline: boolean,
  log: EventLog,
  workspaces: GitWorkspaces,
  fail: (error: ExecutionError, infrastructure?: boolean) => void,
  suspension: SuspensionControl,
  onNodeTimeout: "pause" | "fail",
  requestReplan: ((request: ReplanInput) => void) | undefined,
): Promise<void> {
  result.status = "running";
  result.startedAt = Date.now();
  const started = performance.now();
  // Time spent suspended does not count toward the node timeout.
  let suspendedMs = 0;
  const activeMs = () => performance.now() - started - suspendedMs;
  // The node budget in active time; a resume may renew it.
  let windowMs = timeoutMs;
  let limitMs = timeoutMs;
  let renewal: number | undefined;
  const controller = new AbortController();
  const signal = AbortSignal.any([graphSignal, controller.signal]);
  const pauseOnTimeout = onNodeTimeout === "pause" && runner.interruptible === true;
  const nodeTimeout = () => new RunError("NODE_TIMEOUT", `Node '${result.id}' exceeded ${windowMs}ms`);
  const startTimer = (ms: number) => Number.isFinite(ms)
    ? setTimeout(() => {
      if (pauseOnTimeout) requestTimeoutPause();
      else controller.abort(nodeTimeout());
    }, Math.max(0, ms))
    : undefined;
  let timer = startTimer(timeoutMs);
  // Aborted to interrupt the current step; replaced once the runner reaches a checkpoint.
  let step = new AbortController();
  let interrupted = false;
  let grace: ReturnType<typeof setTimeout> | undefined;
  suspension.attach({
    renew(ms) { renewal = ms; },
    abort(error) { controller.abort(error); },
    setGraphDeadline(deadline) {
      // Mutate in place: runners may hold a reference to the request's deadlines.
      if (Number.isFinite(deadline)) (invocation.deadlines ??= {}).graph = deadline;
      else if (invocation.deadlines) delete invocation.deadlines.graph;
    },
  });
  let onAbort: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  void aborted.catch(() => {});
  let acceptingWrites = true;
  let runnerStarted = false;
  let writableWorkspace = false;
  const writes = new Set<Promise<unknown>>();
  let merge: Awaited<ReturnType<GitWorkspaces["beginMerge"]>> | undefined;
  let acceptingDecisions = true;
  let acceptingHumanInput = true;
  let acceptingReplans = true;
  let decision: string | undefined;
  let decisionError: RunError | undefined;
  // Capture choices separately: the runner cannot change the declared tool enum.
  const choices =
    request.node.type === "decision" ? [...request.node.choices] : undefined;
  const invocation: ModelRequest = { ...request, signal };
  invocation.withWorkspaceWrite = async operation => {
    signal.throwIfAborted();
    if (!acceptingWrites) throw new Error("Node has finished; further writes are unavailable");
    if (!writableWorkspace) throw new Error("Node workspace is read-only; writes are unavailable");
    const pending = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return operation();
    });
    writes.add(pending);
    try { return await pending; }
    finally { writes.delete(pending); }
  };
  invocation.recordHumanInput = text => {
    if (typeof text !== "string" || !text.trim()) throw new TypeError("Human input must be a non-empty string");
    if (!acceptingHumanInput || signal.aborted) throw new Error("Node has finished; human input can no longer be delivered");
    (result.humanInputs ??= []).push({ text, timestamp: Date.now() });
    log.emit({ type: "human_input", nodeId: result.id, text });
  };
  if (requestReplan) {
    invocation.requestReplan = request => {
      if (!acceptingReplans || signal.aborted) throw new Error("Node has finished; a replan can no longer be requested");
      requestReplan(request);
    };
  }
  if (Number.isFinite(timeoutMs) || Number.isFinite(graphDeadline())) {
    invocation.deadlines = {
      ...(Number.isFinite(timeoutMs) ? { node: started + timeoutMs } : {}),
      ...(Number.isFinite(graphDeadline()) ? { graph: graphDeadline() } : {}),
    };
  }
  let acceptingCheckpoints = true;
  invocation.stepSignal = () => AbortSignal.any([signal, step.signal]);
  invocation.checkpoint = async () => {
    checkDeadline();
    if (interrupted) {
      // The runner recorded the interrupted step; later steps get a fresh signal.
      interrupted = false;
      clearTimeout(grace);
      step = new AbortController();
    }
    if (writes.size) await Promise.allSettled([...writes]);
    const resumed = acceptingCheckpoints ? suspension.suspend() : undefined;
    if (resumed) {
      clearTimeout(timer);
      const since = performance.now();
      try { await Promise.race([aborted, resumed]); }
      finally { suspendedMs += performance.now() - since; }
    }
    if (renewal !== undefined) {
      windowMs = renewal;
      limitMs = activeMs() + renewal;
      renewal = undefined;
    } else if (!resumed) return;
    // Mutate in place: runners may hold a reference to the request's deadlines.
    if (Number.isFinite(limitMs)) (invocation.deadlines ??= {}).node = started + suspendedMs + limitMs;
    else if (invocation.deadlines) delete invocation.deadlines.node;
    clearTimeout(timer);
    timer = signal.aborted ? undefined : startTimer(limitMs - activeMs());
    checkDeadline();
  };
  if (choices) {
    invocation.decide = (...values: string[]) => {
      if (!acceptingDecisions || signal.aborted) {
        throw new RunError(
          "INVALID_DECISION",
          "decide called after invocation ended",
        );
      }
      const choice = values[0];
      if (
        values.length !== 1 ||
        typeof choice !== "string" ||
        !choices.includes(choice) ||
        decision !== undefined
      ) {
        decisionError = new RunError(
          "INVALID_DECISION",
          "decide must be called exactly once with one declared choice",
        );
        throw decisionError;
      }
      decision = choice;
    };
  }

  function checkDeadline(): void {
    signal.throwIfAborted();
    const now = performance.now();
    let error: RunError | undefined;
    if (enforceGraphDeadline && now >= graphDeadline()) error = new RunError("GRAPH_TIMEOUT", "Graph deadline exceeded");
    else if (now - started - suspendedMs >= limitMs) {
      // Under the pause policy a finished runner keeps its result.
      if (!pauseOnTimeout) error = nodeTimeout();
      else requestTimeoutPause();
    }
    if (error) {
      controller.abort(error);
      throw error;
    }
  }

  /** Interrupt the current step and suspend at the runner's next checkpoint. */
  function requestTimeoutPause(): void {
    if (interrupted || !acceptingCheckpoints || signal.aborted) return;
    interrupted = true;
    clearTimeout(timer);
    timer = undefined;
    suspension.timedOut({ nodeTimeoutMs: windowMs, activeMs: Math.round(activeMs()) });
    step.abort(new RunError("NODE_TIMEOUT", `Node '${result.id}' exceeded ${windowMs}ms; pausing`));
    // A timeout is always enforced: a runner that never reaches a checkpoint fails.
    grace = setTimeout(() => controller.abort(nodeTimeout()), INTERRUPT_GRACE_MS);
  }

  try {
    checkDeadline();
    if (request.node.type === "merge" || request.node.type === "integrate") {
      merge = await workspaces.beginMerge(invocation, request.predecessors.map(value => value.executionId!));
      invocation.merge = { sources: structuredClone(merge.sources),
        ...(merge.sourceStatus ? { sourceStatus: structuredClone(merge.sourceStatus) } : {}), finish: merge.finish };
    } else {
      invocation.workspace = await workspaces.prepare(invocation);
    }
    invocation.workspace = structuredClone(invocation.workspace!);
    writableWorkspace = invocation.workspace.mode !== "read-only";
    if (invocation.workspace?.sourceRoot) {
      const gitRequest = { ...invocation, node: structuredClone(invocation.node), workspace: structuredClone(invocation.workspace) };
      invocation.git = (args, input) => workspaces.git(gitRequest, args, input);
    }
    // The rejection handler remains attached if a non-cooperative runner finishes late.
    const response = await Promise.race([
      aborted,
      Promise.resolve().then(() => {
        // Timer callbacks can be starved. Never start a provider call after its deadline.
        checkDeadline();
        log.emit({
          type: "node_started",
          nodeId: result.id,
          ...(result.model !== undefined ? { model: result.model } : {}),
        });
        for (const predecessor of request.predecessors) {
          log.emit({
            type: "handoff",
            from: predecessor.nodeId,
            ...(predecessor.executionId ? { fromExecutionId: predecessor.executionId } : {}),
            to: result.id,
            output: predecessor.output,
            ...(predecessor.decision !== undefined
              ? { decision: predecessor.decision }
              : {}),
          });
        }
        checkDeadline();
        runnerStarted = true;
        return runner(invocation);
      }),
    ]);
    acceptingDecisions = false;
    acceptingHumanInput = false;
    acceptingReplans = false;
    acceptingCheckpoints = false;
    checkDeadline();
    checkResponse(response);
    result.output = response.output;
    if (response.model !== undefined) result.model = response.model;
    if (response.usage !== undefined) result.usage = { ...response.usage };
    if (decisionError) throw decisionError;
    if (choices && decision === undefined) {
      throw new RunError(
        "DECISION_REQUIRED",
        `Decision node '${result.id}' did not call decide`,
      );
    }
    result.status = "completed";
  } catch (error) {
    result.status = "failed";
    result.error = describeError(error);
    fail(result.error, !runnerStarted && !(error instanceof WorkspaceInputError) && !signal.aborted);
  } finally {
    acceptingDecisions = false;
    acceptingHumanInput = false;
    acceptingReplans = false;
    acceptingWrites = false;
    acceptingCheckpoints = false;
    suspension.finished();
    await Promise.allSettled(writes);
    if (result.status === "completed") {
      try { checkDeadline(); }
      catch (error) { result.status = "failed"; result.error = describeError(error); fail(result.error); }
    }
    if (merge) {
      try { await merge.complete(result.status === "completed"); }
      catch (error) {
        result.status = "failed";
        result.error = { code: error instanceof WorkspaceCheckpointError ? "CHECKPOINT_FAILED" : "MERGE_FAILED", message: error instanceof Error ? error.message : String(error) };
        fail(result.error, error instanceof WorkspaceCheckpointError);
      }
    }
    try { await workspaces.seal(invocation); }
    catch (error) {
      result.status = "failed";
      result.error = { code: "CHECKPOINT_FAILED", message: error instanceof Error ? error.message : String(error) };
      fail(result.error, true);
    }
    if (decision !== undefined) result.decision = decision;
    clearTimeout(timer);
    clearTimeout(grace);
    signal.removeEventListener("abort", onAbort!);
    result.finishedAt = Date.now();
    result.latencyMs = performance.now() - started;
    const details = {
      nodeId: result.id,
      latencyMs: result.latencyMs,
      ...(result.output !== undefined ? { output: result.output } : {}),
      ...(result.decision !== undefined ? { decision: result.decision } : {}),
      ...(result.model !== undefined ? { model: result.model } : {}),
      ...(result.usage !== undefined ? { usage: result.usage } : {}),
    };
    log.emit(
      result.error
        ? { type: "node_failed", ...details, error: result.error }
        : { type: "node_completed", ...details, output: result.output! },
    );
  }
}

/** A cycle-closing edge that fired: its source becomes an input of the target lineage's next instance. */
interface Firing {
  edge: Edge;
  source: NodeExecution;
}

/** The instances of one node, oldest first; the last is the head. */
interface Lineage {
  instances: NodeExecution[];
  /** Firings that reached the started head; they attach to its clone once it settles and is released. */
  queued: Firing[];
}

/** Why a lineage's head cannot be used as an input yet; undefined when it is current. */
type Dirt = "predecessors" | "stale" | "hold" | undefined;
const dirtRank = { hold: 3, predecessors: 2, stale: 1 } as const;
const worse = (a: Dirt, b: Dirt): Dirt => !a ? b : !b ? a : dirtRank[a] >= dirtRank[b] ? a : b;

const settled = (record: NodeResult) => ["completed", "failed", "skipped"].includes(record.status);

/** Execute a graph to completion. Use startBraid for live edits and pause/resume. */
export async function braid(input: BraidInput, options: BraidOptions): Promise<BraidResult> {
  // Nothing can resume a paused execution without the run handle.
  if (options?.onNodeTimeout === "pause") throw new TypeError('braid() cannot resume executions; use startBraid() for onNodeTimeout: "pause"');
  if (options?.onLimit === "pause") throw new TypeError('braid() cannot resume a run at a limit; use startBraid() for onLimit: "pause"');
  return startBraid(input, { ...options, onNodeTimeout: "fail", onLimit: "fail" }).result;
}

/** The graph holds execution instances; each node is a lineage whose latest instance is its head. */
export function startBraid(input: BraidInput, options: BraidOptions): BraidRun {
  validateOptions(options);
  let definition = structuredClone(input);
  let graph = compileGraph(definition);
  let nodeById = new Map(graph.nodes.map(node => [node.id, node]));
  const { runner, defaultModel, signal } = options;
  const maxConcurrency = options.maxConcurrency ?? 4;
  const limits: Required<BraidLimits> = {
    maxExecutions: options.maxExecutions ?? Infinity,
    graphTimeoutMs: options.graphTimeoutMs ?? Infinity,
    maxTokens: options.maxTokens ?? Infinity,
  };
  const nodeTimeoutMs = options.nodeTimeoutMs ?? Infinity;
  const onNodeTimeout = options.onNodeTimeout ?? "pause";
  const onLimit = options.onLimit ?? "pause";
  const startedAt = Date.now();
  const started = performance.now();
  let graphDeadline = started + limits.graphTimeoutMs;
  const runId = crypto.randomUUID();
  const log = createEventLog(options.onEvent);
  const executions = new Map<string, NodeExecution>();
  // Open lineages, in graph order. A removed lineage keeps its instances in `executions` only.
  const lineages = new Map<string, Lineage>();
  // Generations never restart, so a removed and re-added node gets new execution IDs.
  const generations = new Map<string, number>();
  // For each started instance: the upstream instance it used from each non-closing incoming edge's lineage.
  const consulted = new Map<string, Map<string, string>>();
  // Cycle-closing firings attached to a pending instance.
  const attached = new Map<string, Firing[]>();
  // Times each edge identity fired, for edge limits.
  const firings = new Map<string, number>();
  // Settled instances whose cycle-closing edges have not been routed yet.
  const unrouted = new Set<string>();
  // Decisions held at an edge limit; releasing one without a higher limit ends the cycle.
  const limitHeld = new Set<string>();
  // Running instances per lineage ID: a lineage starts its next instance only after the last one stops.
  const runningLineages = new Map<string, number>();
  // Instances cancelled because an update replaced or removed them; their failure is not a run failure.
  const discarded = new Set<string>();
  let admitted = 0;
  // Events from a state change are published only once the change is committed.
  let batch: EventPayload[] | undefined;
  const emit = (payload: EventPayload) => { if (batch) batch.push(payload); else log.emit(payload); };
  const paused = new Set<string>();
  const running = new Map<string, Promise<void>>();
  // Suspended and resuming executions stay in `running` but release their slot.
  const suspended = new Set<string>();
  const resumeQueue: string[] = [];
  const resumers = new Map<string, () => void>();
  const invocations = new Map<string, InvocationHandle>();
  // Cancellations requested before the invocation attached.
  const pendingAborts = new Map<string, RunError>();
  // Executions that pauseRun paused; resumeRun resumes only these.
  const pausedByRun = new Set<string>();
  let runPause: BraidSnapshot["pause"];
  const active = () => running.size - suspended.size;
  // The latest execution to stop being active work since the run last reported graph_waiting.
  let lastSettled: string | undefined;
  const controller = new AbortController();
  let revision = 0;
  let status: BraidSnapshot["status"] = "running";
  let finalNodes: Record<string, NodeResult> | undefined;
  let wake!: () => void;
  let changed: Promise<void>;
  function resetWake() { changed = new Promise(resolve => { wake = resolve; }); }
  resetWake();
  controller.signal.addEventListener("abort", () => wake());
  const cancel = () => {
    if (status !== "completed" && status !== "failed") controller.abort(new RunError("CANCELLED", "Graph cancelled by caller"));
  };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  // The scheduler loop acts on the deadline: it fails or pauses the run.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const startTimer = () => {
    clearTimeout(timer);
    // Timers have millisecond resolution and can fire just before the deadline; wait again then.
    timer = Number.isFinite(graphDeadline) ? setTimeout(() => performance.now() < graphDeadline ? startTimer() : wake(),
      Math.max(0, Math.ceil(graphDeadline - performance.now()))) : undefined;
  };
  startTimer();
  const context = (record: NodeExecution) => ({ executionId: record.executionId, revision: record.revision });
  const workspaces = new GitWorkspaces(resolve(options.cwd ?? process.cwd()), workspace => {
    const record = executions.get(workspace.executionId!);
    if (record) record.workspace = { ...workspace };
    log.emit({ type: "workspace_updated", workspace, ...(record ? context(record) : {}) });
  });

  function snapshot(): BraidSnapshot {
    const waits = assess();
    const state = structuredClone({ runId, status, revision, graph: definition, nodes: finalNodes ?? heads(),
      executions: Object.fromEntries(executions), pausedExecutionIds: [...paused], suspendedExecutionIds: [...suspended],
      ...(runPause ? { pause: runPause } : {}), limits: finiteLimits(),
      ...(controller.signal.aborted ? { error: describeError(controller.signal.reason) } : {}) });
    if (!finalNodes) for (const record of [...Object.values(state.nodes), ...Object.values(state.executions)]) mark(record, waits);
    return state;
  }
  /** Add the derived markers to a copied record. */
  function mark(record: NodeResult, waits: Map<string, WaitReason>) {
    const wait = waits.get(record.executionId!);
    if (wait) record.waitReason = wait;
    if (paused.has(record.executionId!)) record.held = true;
  }
  function heads(): Record<string, NodeResult> {
    const nodes: Record<string, NodeResult> = {};
    // defineProperty keeps IDs such as __proto__ ordinary own properties.
    for (const [id, lineage] of lineages) Object.defineProperty(nodes, id, { value: lineage.instances.at(-1)!, enumerable: true, writable: true, configurable: true });
    return nodes;
  }

  function finiteLimits(): BraidLimits {
    return Object.fromEntries(limitKeys.filter(key => Number.isFinite(limits[key])).map(key => [key, limits[key]]));
  }
  const tokensUsed = () => [...executions.values()].reduce((sum, record) => sum + (record.usage ? record.usage.inputTokens + record.usage.outputTokens : 0), 0);
  /** Run limits that are reached, by the pause source they use under onLimit: "pause". */
  const runLimits = {
    execution_limit: { limit: "maxExecutions", error: () => new RunError("EXECUTION_LIMIT", `Graph exceeded ${limits.maxExecutions} executions`),
      reached: () => admitted >= limits.maxExecutions },
    graph_timeout: { limit: "graphTimeoutMs", error: () => new RunError("GRAPH_TIMEOUT", `Graph exceeded ${limits.graphTimeoutMs}ms`),
      reached: () => performance.now() >= graphDeadline },
    token_limit: { limit: "maxTokens", error: () => new RunError("TOKEN_LIMIT", `Graph used ${tokensUsed()} tokens, reaching its limit of ${limits.maxTokens}`),
      reached: () => Number.isFinite(limits.maxTokens) && tokensUsed() >= limits.maxTokens },
  } as const;
  type RunLimitSource = keyof typeof runLimits;
  /**
   * Fail the run at a reached limit, or pause it: no new admissions, and for time and
   * tokens every running execution pauses too. An existing run pause is kept.
   */
  function reachLimit(source: RunLimitSource) {
    const { limit, error } = runLimits[source];
    if (onLimit === "fail") { controller.abort(error()); return; }
    if (runPause) return;
    runPause = { source, pausedAt: Date.now() };
    log.emit({ type: "limit_reached", limit, value: limits[limit], revision });
    log.emit({ type: "graph_paused", source, revision });
    // Executions already admitted count toward maxExecutions, so they may finish.
    if (source !== "execution_limit" && runner.pausable) for (const id of running.keys()) {
      const record = executions.get(id)!;
      if (!settled(record)) requestPause(record, source, true);
    }
    wake();
  }
  function setLimits(changes: BraidLimits): BraidSnapshot {
    assertActive();
    if (!changes || typeof changes !== "object" || Object.keys(changes).some(key => !(limitKeys as readonly string[]).includes(key)))
      throw new TypeError(`setLimits accepts only ${limitKeys.join(", ")}`);
    validateLimits(changes);
    for (const key of limitKeys) if (changes[key] !== undefined) limits[key] = changes[key];
    if (changes.graphTimeoutMs !== undefined) {
      graphDeadline = started + limits.graphTimeoutMs;
      startTimer();
      for (const invocation of invocations.values()) invocation.setGraphDeadline(graphDeadline);
    }
    log.emit({ type: "limits_updated", limits: finiteLimits(), revision });
    wake();
    return snapshot();
  }

  function assertActive() {
    if (status === "finalizing" || status === "completed" || status === "failed" || controller.signal.aborted)
      throw new Error("This run is no longer accepting updates");
  }
  function assertMutable(expectedRevision: number) {
    assertActive();
    if (expectedRevision !== revision) throw new Error(`Revision conflict: expected ${expectedRevision}, current ${revision}`);
  }
  function resumable(id: string) {
    const state = executions.get(id)?.suspension?.state;
    return paused.has(id) || state === "pausing" || state === "suspended";
  }
  function validateResume(ids: readonly string[], options?: ResumeOptions) {
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.some(id => !resumable(id)))
      throw new Error("resume must contain unique held or paused execution IDs");
    if (options === undefined) return;
    if (!options || typeof options !== "object" || Object.keys(options).some(key => key !== "nodeTimeoutMs"))
      throw new TypeError("Unknown resume option");
    const value = options.nodeTimeoutMs;
    if (value !== undefined && value !== Infinity && (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 2_147_483_647))
      throw new TypeError("nodeTimeoutMs must be Infinity or a positive number no greater than 2147483647");
  }
  /** Commit resume state without events; returns the executions that continue immediately. */
  function stageResume(ids: readonly string[], options?: ResumeOptions): string[] {
    const continued: string[] = [];
    for (const id of ids) {
      const record = executions.get(id)!;
      pausedByRun.delete(id);
      // A timeout pause gets a full new window unless the caller chose one.
      const budget = options?.nodeTimeoutMs ?? (record.suspension?.source === "node_timeout" ? nodeTimeoutMs : undefined);
      if (record.suspension && budget !== undefined) invocations.get(id)?.renew(budget);
      if (paused.delete(id)) continued.push(id);
      else if (record.suspension?.state === "pausing") { delete record.suspension; continued.push(id); }
      else if (record.suspension?.state === "suspended") { record.suspension.state = "resuming"; resumeQueue.push(id); }
    }
    return continued;
  }
  function announceResumed(ids: readonly string[]) {
    for (const id of ids) {
      const record = executions.get(id)!;
      log.emit({ type: "execution_resumed", nodeId: record.id, ...context(record) });
    }
  }
  /** Give free slots to resumed executions, in resume order, before any new admission. */
  function grantSlots() {
    if (controller.signal.aborted) return;
    while (resumeQueue.length && active() < maxConcurrency) {
      const id = resumeQueue.shift()!;
      const record = executions.get(id)!;
      suspended.delete(id);
      delete record.suspension;
      announceResumed([id]);
      resumers.get(id)?.();
      resumers.delete(id);
    }
  }
  function release(ids: readonly string[], options?: ResumeOptions) {
    const continued = stageResume(ids, options);
    status = "running";
    announceResumed(continued);
    grantSlots();
  }
  function requestPause(record: NodeExecution, source: string, byRun: boolean) {
    const suspension = record.suspension;
    // An execution that is already paused keeps its own pause; resumeRun leaves it alone.
    if (suspension && suspension.state !== "resuming") return;
    if (byRun) pausedByRun.add(record.executionId);
    if (suspension) {
      // Not yet continued: return it to the suspended set without a slot.
      resumeQueue.splice(resumeQueue.indexOf(record.executionId), 1);
      suspension.state = "suspended";
      suspension.source = source;
      log.emit({ type: "execution_suspended", nodeId: record.id, source, ...context(record) });
      return;
    }
    record.suspension = { state: "pausing", source, requestedAt: Date.now() };
    log.emit({ type: "execution_suspending", nodeId: record.id, source, ...context(record) });
  }
  function controlSource(options: PauseOptions | CancelExecutionsOptions | undefined, action: string): string {
    const source = options?.source ?? "caller";
    if (typeof source !== "string" || !source.trim()) throw new TypeError(`${action} source must be a non-empty string`);
    return source;
  }
  const pauseSource = (options: PauseOptions | undefined) => controlSource(options, "pause");
  function cancelExecutions(ids: readonly string[], options?: CancelExecutionsOptions): BraidSnapshot {
    assertActive();
    const source = controlSource(options, "cancel");
    if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length ||
        ids.some(id => !running.has(id) || settled(executions.get(id)!)))
      throw new Error("cancelExecutions must contain unique running execution IDs");
    for (const id of ids) {
      const record = executions.get(id)!;
      const timeout = record.suspension?.source === "node_timeout" ? record.suspension.timeout : undefined;
      // Cancelling a timeout pause gives the same result as onNodeTimeout: "fail".
      const error = timeout
        ? new RunError("NODE_TIMEOUT", `Node '${record.id}' exceeded ${timeout.nodeTimeoutMs}ms; cancelled by ${source} while paused`)
        : new RunError("CANCELLED", `Execution cancelled by ${source}`);
      const invocation = invocations.get(id);
      if (invocation) invocation.abort(error);
      else pendingAborts.set(id, error);
    }
    return snapshot();
  }
  function pause(ids: readonly string[], options?: PauseOptions): BraidSnapshot {
    assertActive();
    const source = pauseSource(options);
    if (!runner.pausable) throw new Error("This run's model runner does not support pausing running executions");
    if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length ||
        ids.some(id => !running.has(id) || settled(executions.get(id)!)))
      throw new Error("pause must contain unique running execution IDs");
    for (const id of ids) requestPause(executions.get(id)!, source, false);
    return snapshot();
  }
  function holdAfter(ids: readonly string[], hold: boolean, options?: PauseOptions): BraidSnapshot {
    assertActive();
    const source = pauseSource(options);
    if (typeof hold !== "boolean") throw new TypeError("hold must be a boolean");
    // Settled executions are rejected even before routing, so a hold never changes after completion is reported.
    if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length ||
        ids.some(id => !running.has(id) || settled(executions.get(id)!)))
      throw new Error("holdAfter must contain unique running execution IDs");
    for (const id of ids) {
      const record = executions.get(id)!;
      if (Boolean(record.holdAfter) === hold) continue;
      if (hold) record.holdAfter = { source, requestedAt: Date.now() };
      else delete record.holdAfter;
      log.emit({ type: hold ? "execution_hold_added" : "execution_hold_removed", nodeId: record.id, source, ...context(record) });
    }
    return snapshot();
  }
  function pauseRun(options?: PauseOptions): BraidSnapshot {
    assertActive();
    const source = pauseSource(options);
    if (runPause) return snapshot();
    runPause = { source, pausedAt: Date.now() };
    log.emit({ type: "graph_paused", source, revision });
    // Suspending releases slots, so admission must stop too or freed slots would admit other nodes.
    if (runner.pausable) for (const id of running.keys()) {
      const record = executions.get(id)!;
      if (!settled(record)) requestPause(record, source, true);
    }
    wake();
    return snapshot();
  }
  function resumeRun(): BraidSnapshot {
    assertActive();
    if (!runPause) return snapshot();
    const limit = Object.hasOwn(runLimits, runPause.source) ? runLimits[runPause.source as RunLimitSource] : undefined;
    if (limit?.reached()) throw new Error(`The run is paused at its ${limit.limit} limit of ${limits[limit.limit]}; raise it with setLimits before resuming`);
    runPause = undefined;
    const continued = stageResume([...pausedByRun].filter(resumable));
    pausedByRun.clear();
    status = "running";
    log.emit({ type: "graph_resumed", revision });
    announceResumed(continued);
    grantSlots();
    wake();
    return snapshot();
  }
  function suspensionControl(record: NodeExecution): SuspensionControl {
    const id = record.executionId;
    return {
      attach(handle) {
        invocations.set(id, handle);
        const error = pendingAborts.get(id);
        if (error) { pendingAborts.delete(id); handle.abort(error); }
      },
      timedOut(timeout) {
        if (controller.signal.aborted) return;
        const suspension = record.suspension;
        // The timer stops while suspended or resuming, so only a pending pause can be replaced.
        if (suspension && suspension.state !== "pausing") return;
        // The parent decides about a timeout pause; resumeRun leaves it alone.
        pausedByRun.delete(id);
        if (suspension) Object.assign(suspension, { source: "node_timeout", timeout });
        else record.suspension = { state: "pausing", source: "node_timeout", requestedAt: Date.now(), timeout };
        log.emit({ type: "execution_suspending", nodeId: record.id, source: "node_timeout", ...context(record) });
      },
      suspend() {
        const suspension = record.suspension;
        if (suspension?.state !== "pausing" || controller.signal.aborted) return undefined;
        suspension.state = "suspended";
        suspension.suspendedAt = Date.now();
        suspended.add(id);
        lastSettled = id;
        log.emit({ type: "execution_suspended", nodeId: record.id, source: suspension.source, ...context(record) });
        const resumed = new Promise<void>(resolve => resumers.set(id, resolve));
        // The released slot can go to a waiting resume or a new admission.
        grantSlots();
        wake();
        return resumed;
      },
      finished() {
        const queued = resumeQueue.indexOf(id);
        if (queued >= 0) resumeQueue.splice(queued, 1);
        // One that ends while suspended was not active work, so it cannot be what leaves the run waiting.
        if (!suspended.delete(id)) lastSettled = id;
        resumers.delete(id);
        pausedByRun.delete(id);
        invocations.delete(id);
        pendingAborts.delete(id);
        delete record.suspension;
      },
    };
  }
  const suggestionFields = ["upsertNodes", "removeNodeIds", "addEdges", "removeEdges"];
  /** Record a node's request to replan and hold its result for the graph owner. */
  function requestReplan(record: NodeExecution, request: ReplanInput) {
    assertActive();
    if (!request || typeof request !== "object" || Object.keys(request).some(key => key !== "reason" && key !== "suggestion"))
      throw new TypeError("A replan request has only reason and an optional suggestion");
    if (typeof request.reason !== "string" || !request.reason.trim()) throw new TypeError("Replan reason must be a non-empty string");
    const suggestion = request.suggestion === undefined ? undefined : structuredClone(request.suggestion);
    if (suggestion !== undefined) {
      if (!suggestion || typeof suggestion !== "object" || Array.isArray(suggestion) || !Object.keys(suggestion).length ||
          Object.keys(suggestion).some(key => !suggestionFields.includes(key)))
        throw new TypeError(`A replan suggestion needs at least one of ${suggestionFields.join(", ")}, and nothing else`);
      try { candidateGraph(suggestion); }
      catch (error) { throw new TypeError(`Invalid replan suggestion at revision ${revision}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    const requestedAt = Date.now();
    record.replan = { reason: request.reason, ...(suggestion ? { suggestion } : {}), revision, requestedAt };
    // A hold the parent already placed, or the definition's pauseAfter, keeps its source.
    if (!record.holdAfter) {
      record.holdAfter = { source: "replan", requestedAt };
      log.emit({ type: "execution_hold_added", nodeId: record.id, source: "replan", ...context(record) });
    }
    log.emit({ type: "replan_requested", nodeId: record.id, reason: request.reason,
      ...(suggestion ? { suggestion: structuredClone(suggestion) } : {}), ...context(record) });
  }
  const head = (id: string) => lineages.get(id)!.instances.at(-1)!;
  /** Settled, and its checkpoint is sealed: successors may use it. */
  const done = (record: NodeExecution) => settled(record) && !running.has(record.executionId);
  const modelFor = (node: BraidNode) => node.model ?? defaultModel;

  /** Add a pending instance to a lineage, opening the lineage if needed. */
  function createInstance(id: string, cause: "submitted" | "added" | "cloned" | "replaced", links: { supersedes?: string; trigger?: string } = {}): NodeExecution {
    const node = nodeById.get(id)!;
    const generation = (generations.get(id) ?? 0) + 1;
    generations.set(id, generation);
    const model = modelFor(node);
    const record: NodeExecution = {
      id, executionId: `${id}@${generation}`, generation, node: structuredClone(node), revision,
      predecessorExecutionIds: [], status: "pending", ...(model ? { model } : {}),
      ...(links.supersedes ? { supersedes: links.supersedes } : {}),
    };
    executions.set(record.executionId, record);
    let lineage = lineages.get(id);
    if (!lineage) lineages.set(id, lineage = { instances: [], queued: [] });
    lineage.instances.push(record);
    emit({ type: "execution_created", nodeId: id, nodeType: node.type, generation, cause, ...(model ? { model } : {}),
      ...links, ...context(record) });
    return record;
  }
  batch = [];
  for (const node of graph.nodes) createInstance(node.id, "submitted");
  // Published by execute() after graph_created.
  const initialEvents = batch;
  batch = undefined;

  /** Fail a running instance that an update replaced or removed. */
  function discard(record: NodeExecution, reason: string) {
    if (!running.has(record.executionId) || settled(record)) return;
    discarded.add(record.executionId);
    const error = new RunError("CANCELLED", `Execution ${reason} by a graph update`);
    const invocation = invocations.get(record.executionId);
    if (invocation) invocation.abort(error);
    else pendingAborts.set(record.executionId, error);
  }
  /** Drop a settled instance's hold without releasing it downstream. */
  function dropHold(record: NodeExecution) {
    paused.delete(record.executionId);
    limitHeld.delete(record.executionId);
    unrouted.delete(record.executionId);
  }

  /** Validate a graph edit against the current graph without applying it. */
  function candidateGraph(patch: GraphUpdate | ReplanSuggestion): { candidate: BraidInput; compiled: Graph } {
    const edit = patch as GraphUpdate;
    for (const key of ["upsertNodes", "removeNodeIds", "addEdges", "removeEdges"] as const)
      if (edit[key] !== undefined && !Array.isArray(edit[key])) throw new TypeError(`${key} must be an array`);
    const removed = new Set<string>();
    for (const id of patch.removeNodeIds ?? []) {
      if (typeof id !== "string" || !id.trim()) throw new TypeError("removeNodeIds must contain non-empty node IDs");
      if (!lineages.has(id) || removed.has(id)) throw new TypeError(`removeNodeIds: unknown or repeated node '${id}'`);
      removed.add(id);
    }
    const upserted = new Set<string>();
    for (const node of patch.upsertNodes ?? []) {
      const id = node && typeof node === "object" ? node.id : undefined;
      if (typeof id === "string" && upserted.has(id)) throw new TypeError(`upsertNodes: repeated node '${id}'`);
      if (typeof id === "string") upserted.add(id);
    }
    const existing = new Set(definition.edges.map(edgeIdentity));
    const removedEdges = new Set<string>();
    for (const edge of patch.removeEdges ?? []) {
      if (!edge || typeof edge !== "object" || Object.keys(edge).some(key => !["from", "to", "choice", "limit"].includes(key)) ||
          [edge.from, edge.to, ...(edge.choice === undefined ? [] : [edge.choice])].some(value => typeof value !== "string" || !value.trim()))
        throw new TypeError("removeEdges must contain edge identities: from, to, and choice when present");
      const key = edgeIdentity(edge);
      if (!existing.has(key)) throw new TypeError(`removeEdges: no edge '${edge.from}' -> '${edge.to}'${edge.choice === undefined ? "" : ` with choice '${edge.choice}'`}`);
      removedEdges.add(key);
    }
    const nodes = new Map(definition.nodes.filter(node => !removed.has(node.id)).map(node => [node.id, node]));
    for (const node of patch.upsertNodes ?? []) nodes.set(node.id, node);
    const edges = definition.edges.filter(edge => !removed.has(edge.from) && !removed.has(edge.to) && !removedEdges.has(edgeIdentity(edge)));
    const candidate: BraidInput = structuredClone({ ...definition, nodes: [...nodes.values()], edges: [...edges, ...(patch.addEdges ?? [])],
      ...(edit.promptTemplates !== undefined ? { promptTemplates: edit.promptTemplates } : {}) });
    return { candidate, compiled: compileGraph(candidate) };
  }

  function update(patch: GraphUpdate): BraidSnapshot {
    assertMutable(patch.expectedRevision);
    const allowed = ["expectedRevision", "upsertNodes", "removeNodeIds", "addEdges", "removeEdges", "promptTemplates", "resume", "resumeOptions"];
    if (Object.keys(patch).some(key => !allowed.includes(key))) throw new TypeError("Unknown graph update field");
    if (patch.resume !== undefined && !Array.isArray(patch.resume)) throw new TypeError("resume must be an array");
    if (patch.resumeOptions !== undefined && !patch.resume?.length) throw new TypeError("resumeOptions requires resume");
    validateResume(patch.resume ?? [], patch.resumeOptions);
    const { candidate, compiled } = candidateGraph(patch);
    // Commit all state before publishing callbacks, which may themselves submit an update.
    batch = [];
    definition = candidate;
    graph = compiled;
    nodeById = new Map(graph.nodes.map(node => [node.id, node]));
    revision++;
    for (const id of patch.removeNodeIds ?? []) {
      const lineage = lineages.get(id)!;
      const record = lineage.instances.at(-1)!;
      lineages.delete(id);
      if (record.status === "pending") {
        // Never started: no history is kept.
        executions.delete(record.executionId);
        attached.delete(record.executionId);
        emit({ type: "execution_removed", nodeId: id, ...context(record) });
      } else {
        discard(record, "removed");
        dropHold(record);
      }
    }
    const upserted = new Set((patch.upsertNodes ?? []).map(node => node.id));
    for (const id of upserted) {
      const record = lineages.get(id)?.instances.at(-1);
      if (!record) createInstance(id, "added");
      else if (record.status !== "pending") {
        // Started instances are immutable: replace this one, and cancel it if it is still running.
        const replacement = createInstance(id, "replaced", { supersedes: record.executionId });
        record.supersededBy = replacement.executionId;
        discard(record, "replaced");
        dropHold(record);
        emit({ type: "execution_superseded", nodeId: id, supersededBy: replacement.executionId, ...context(record) });
      }
    }
    // Not-started heads follow their current definition, including edited templates.
    for (const [id, lineage] of lineages) {
      const record = lineage.instances.at(-1)!;
      const node = nodeById.get(id)!;
      if (record.status !== "pending" || (!upserted.has(id) && JSON.stringify(record.node) === JSON.stringify(node))) continue;
      record.node = structuredClone(node);
      record.revision = revision;
      const model = modelFor(node);
      if (model) record.model = model;
      else delete record.model;
    }
    const continued = stageResume(patch.resume ?? [], patch.resumeOptions);
    status = "running";
    const events = batch;
    batch = undefined;
    log.emit({ type: "graph_updated", graph: definition, revision });
    for (const event of events) log.emit(event);
    announceResumed(continued);
    grantSlots();
    wake();
    return snapshot();
  }

  /** True when a newer instance exists, or an edge is new, for any non-closing input lineage. */
  function outdated(record: NodeExecution): boolean {
    const used = consulted.get(record.executionId);
    return graph.incoming.get(record.id)!.some(edge => !graph.closing.has(edge) && used?.get(edge.from) !== head(edge.from).executionId);
  }
  function upstreamDirt(id: string, dirt: Map<string, Dirt>): Dirt {
    let result: Dirt;
    for (const edge of graph.incoming.get(id)!) if (!graph.closing.has(edge)) result = worse(result, dirt.get(edge.from));
    return result;
  }
  /** Whether successors must wait for this lineage, given what its inputs are waiting for. */
  function lineageDirt(id: string, upstream: Dirt): Dirt {
    const lineage = lineages.get(id)!;
    const record = lineage.instances.at(-1)!;
    const own: Dirt = paused.has(record.executionId) ? "hold"
      : !done(record) ? (lineage.instances.length > 1 ? "stale" : "predecessors")
      : lineage.queued.length || outdated(record) ? "stale" : undefined;
    const result = worse(own, upstream);
    // A lineage that already has a result will refresh it: its successors wait on a stale input.
    return result === "predecessors" && own !== "predecessors" ? "stale" : result;
  }
  /** Wait reasons of pending heads, without changing anything. */
  function assess(): Map<string, WaitReason> {
    const waits = new Map<string, WaitReason>();
    const dirt = new Map<string, Dirt>();
    for (const { id } of graph.topologicalOrder) {
      if (!lineages.has(id)) continue;
      const upstream = upstreamDirt(id, dirt);
      const record = head(id);
      if (record.status === "pending") waits.set(record.executionId, upstream ?? (runPause ? "run_paused" : "slot"));
      dirt.set(id, lineageDirt(id, upstream));
    }
    return waits;
  }

  /** Fire the cycle-closing edges of settled, released instances. */
  function route(): boolean {
    let progressed = false;
    for (const id of [...unrouted]) {
      const record = executions.get(id)!;
      if (paused.has(id)) continue;
      // Superseded and removed instances no longer route.
      if (lineages.get(record.id)?.instances.at(-1) !== record) { unrouted.delete(id); continue; }
      let held = false;
      for (const edge of graph.outgoing.get(record.id)!) {
        if (!graph.closing.has(edge) || edgeState(edge, record) !== "active") continue;
        const key = edgeIdentity(edge);
        const count = firings.get(key) ?? 0;
        const limit = edge.limit ?? Infinity;
        if (count >= limit) {
          if (onLimit === "fail") {
            controller.abort(new RunError("EDGE_LIMIT", `Edge '${edge.from}' -> '${edge.to}' reached its limit of ${limit}`));
            return true;
          }
          // Released without a higher limit: the cycle ends here, and the decision's other edges stay inactive.
          if (limitHeld.has(id)) continue;
          // Hold the decision until the owner raises the limit or releases it to end the cycle.
          limitHeld.add(id);
          record.holdAfter = { source: "edge_limit", requestedAt: Date.now() };
          paused.add(id);
          log.emit({ type: "execution_hold_added", nodeId: record.id, source: "edge_limit", ...context(record) });
          log.emit({ type: "limit_reached", limit: "edge", value: limit, nodeId: record.id,
            edge: { from: edge.from, to: edge.to, ...(edge.choice !== undefined ? { choice: edge.choice } : {}), limit }, ...context(record) });
          log.emit({ type: "execution_paused", nodeId: record.id, ...context(record) });
          held = progressed = true;
          break;
        }
        firings.set(key, count + 1);
        const target = head(edge.to);
        const firing = { edge, source: record };
        if (target.status === "pending") (attached.get(target.executionId) ?? attached.set(target.executionId, []).get(target.executionId)!).push(firing);
        else lineages.get(edge.to)!.queued.push(firing);
        progressed = true;
      }
      if (!held) { unrouted.delete(id); limitHeld.delete(id); }
    }
    return progressed;
  }

  /** Start or skip a pending head whose inputs are settled and current. */
  function admit(record: NodeExecution): boolean {
    if (runLimits.execution_limit.reached()) {
      reachLimit("execution_limit");
      return false;
    }
    const used = new Map<string, string>();
    const states: EdgeState[] = [];
    const predecessors = new Map<string, NodeExecution>();
    for (const edge of graph.incoming.get(record.id)!) {
      if (graph.closing.has(edge)) continue;
      const source = head(edge.from);
      used.set(edge.from, source.executionId);
      const state = edgeState(edge, source);
      states.push(state);
      if (state === "active") predecessors.set(source.executionId, source);
    }
    for (const { source } of attached.get(record.executionId) ?? []) {
      states.push("active");
      predecessors.set(source.executionId, source);
    }
    attached.delete(record.executionId);
    const skipReason = states.includes("blocked") ? "upstream_failed" : states.length && !states.includes("active") ? "inactive" : undefined;
    admitted++;
    consulted.set(record.executionId, used);
    record.predecessorExecutionIds = [...predecessors.keys()];
    if (skipReason) {
      record.status = "skipped";
      record.skipReason = skipReason;
      record.finishedAt = Date.now();
      log.emit({ type: "node_skipped", nodeId: record.id, reason: skipReason, ...context(record) });
      return true;
    }
    record.status = "running";
    if (record.node.pauseAfter) record.holdAfter = { source: "definition", requestedAt: Date.now() };
    runningLineages.set(record.id, (runningLineages.get(record.id) ?? 0) + 1);
    const scopedLog: EventLog = { events: log.events, emit: event => log.emit({ ...event, ...context(record) }) };
    const request: Omit<ModelRequest, "signal" | "decide"> = {
      goal: graph.goal, node: structuredClone(record.node),
      execution: { runId, rootRunId: runId, ...context(record), generation: record.generation },
      predecessors: [...predecessors.values()].map(value => ({ nodeId: value.id, executionId: value.executionId, ...nodeOutput(value),
        ...(value.error ? { error: { ...value.error } } : {}), ...(value.workspace ? { workspace: { ...value.workspace } } : {}) })),
      ...(record.model ? { model: record.model } : {}),
    };
    const failure = (error: ExecutionError, infrastructure?: boolean) => {
      if (infrastructure) controller.abort(new RunError(error.code, error.message));
      else if (record.node.requireSuccess && !discarded.has(record.executionId))
        controller.abort(new RunError("REQUIRED_NODE_FAILED", `Required node '${record.id}' (${record.executionId}) failed: ${error.message}`));
    };
    // Reserve the slot before publishing events or invoking asynchronous runner code.
    const task = Promise.resolve().then(async () => {
      await runNode(request, record, runner, nodeTimeoutMs, controller.signal, () => graphDeadline, onLimit === "fail", scopedLog, workspaces,
        failure, suspensionControl(record), onNodeTimeout,
        record.node.type === "execute" || record.node.type === "decision" ? request => requestReplan(record, request) : undefined);
      // A replaced or removed instance is history: it is never held.
      if (record.holdAfter && !controller.signal.aborted && lineages.get(record.id)?.instances.at(-1) === record) {
        paused.add(record.executionId);
        scopedLog.emit({ type: "execution_paused", nodeId: record.id });
      }
    }).catch(error => {
      controller.abort(new RunError("SCHEDULING_ERROR", error instanceof Error ? error.message : String(error)));
    }).finally(() => {
      running.delete(record.executionId);
      runningLineages.set(record.id, runningLineages.get(record.id)! - 1);
      unrouted.add(record.executionId);
      grantSlots();
      wake();
    });
    running.set(record.executionId, task);
    return true;
  }

  /** One scheduling pass in topological order; returns whether anything changed. */
  function schedule(): boolean {
    const startRevision = revision;
    let progressed = route();
    const dirt = new Map<string, Dirt>();
    for (const { id } of graph.topologicalOrder) {
      // A paused run admits nothing, not even skipped records; an update restarts the pass.
      if (controller.signal.aborted || revision !== startRevision) return true;
      const lineage = lineages.get(id)!;
      const upstream = upstreamDirt(id, dirt);
      let record = lineage.instances.at(-1)!;
      if (!upstream && !runPause && done(record) && !paused.has(record.executionId) && (lineage.queued.length || outdated(record))) {
        // An edge reached the settled head: clone it into a new instance.
        const source = lineage.queued[0]?.source ?? graph.incoming.get(id)!.filter(edge => !graph.closing.has(edge))
          .map(edge => head(edge.from)).find(value => consulted.get(record.executionId)?.get(value.id) !== value.executionId);
        record = createInstance(id, "cloned", source ? { trigger: source.executionId } : {});
        progressed = true;
        if (revision !== startRevision) return true;
      }
      if (record.status === "pending" && lineage.queued.length) {
        attached.set(record.executionId, [...(attached.get(record.executionId) ?? []), ...lineage.queued]);
        lineage.queued = [];
      }
      if (record.status === "pending" && !upstream && !runPause && !runningLineages.get(id)) {
        const skip = willSkip(record);
        // Resumed executions waiting for a slot take priority over new admissions.
        if (skip || (active() < maxConcurrency && !resumeQueue.length)) {
          if (!admit(record)) return true;
          progressed = true;
        }
      }
      dirt.set(id, lineageDirt(id, upstream));
    }
    return progressed;
  }
  /** Whether a pending head with settled inputs would be skipped rather than run. */
  function willSkip(record: NodeExecution): boolean {
    if (attached.get(record.executionId)?.length) return false;
    const states = graph.incoming.get(record.id)!.filter(edge => !graph.closing.has(edge)).map(edge => edgeState(edge, head(edge.from)));
    return states.includes("blocked") || (states.length > 0 && !states.includes("active"));
  }

  async function execute(): Promise<BraidResult> {
    let cleanupError: ExecutionError | undefined;
    try {
      log.emit({ type: "graph_created", nodeCount: graph.nodes.length, edgeCount: graph.edges.length, revision });
      for (const event of initialEvents) log.emit(event);
      for (const edge of graph.edges) log.emit({ type: "edge_created", ...edge });
      await workspaces.initialize(runId);
      while (true) {
        if (runLimits.graph_timeout.reached()) reachLimit("graph_timeout");
        else if (runLimits.token_limit.reached()) reachLimit("token_limit");
        if (controller.signal.aborted) { await Promise.all(running.values()); break; }
        resetWake();
        grantSlots();
        const schedulingRevision = revision;
        const progressed = schedule();
        if (controller.signal.aborted || progressed || schedulingRevision !== revision) continue;
        if (running.size || paused.size || runPause) {
          status = active() ? "running" : "waiting";
          // Updates and resumes that start nothing leave lastSettled unset, so they do not report again.
          if (status === "waiting" && lastSettled) {
            log.emit({ type: "graph_waiting", settledExecutionId: lastSettled, pausedExecutionIds: [...paused],
              suspendedExecutionIds: [...suspended], ...(runPause ? { pause: { ...runPause } } : {}), revision });
            lastSettled = undefined;
          }
          await changed;
          continue;
        }
        const unfinished = [...lineages.values()].some(lineage => lineage.instances.at(-1)!.status === "pending");
        if (unfinished) controller.abort(new RunError("SCHEDULING_ERROR", "The current graph cannot make progress"));
        break;
      }
    } catch (error) {
      controller.abort(new RunError("SCHEDULING_ERROR", error instanceof Error ? error.message : String(error)));
      await Promise.all(running.values());
    } finally {
      status = "finalizing";
      // Terminal holds are no longer resumable; the event log retains pause history.
      paused.clear();
      runPause = undefined;
      try { await workspaces.archivePending("Execution checkpoint retained for inspection and future recovery"); }
      catch (error) { cleanupError = { code: "CLEANUP_FAILED", message: error instanceof Error ? error.message : String(error) }; }
      try { await workspaces.close(); }
      catch (error) { cleanupError ??= { code: "CLEANUP_FAILED", message: error instanceof Error ? error.message : String(error) }; }
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    }
    const consumed = new Set([...executions.values()].flatMap(record => record.status === "skipped" ? [] : record.predecessorExecutionIds));
    const terminals = [...lineages.values()].map(lineage => lineage.instances.at(-1)!)
      .filter(record => record.status === "completed" && !consumed.has(record.executionId));
    const terminalOutputs = Object.fromEntries(terminals.map(record => [record.id, nodeOutput(record)]));
    const usage = { inputTokens: 0, outputTokens: 0 };
    let usageReportedNodes = 0;
    for (const record of executions.values()) if (record.usage) {
      usage.inputTokens += record.usage.inputTokens;
      usage.outputTokens += record.usage.outputTokens;
      usageReportedNodes++;
    }
    const error = cleanupError ?? (controller.signal.aborted ? describeError(controller.signal.reason) : undefined);
    status = error ? "failed" : "completed";
    for (const lineage of lineages.values()) {
      const record = lineage.instances.at(-1)!;
      if (record.status !== "pending") continue;
      record.status = "skipped";
      record.skipReason = error?.code === "CANCELLED" ? "cancelled" : error?.code === "GRAPH_TIMEOUT" ? "graph_timeout" : "run_failed";
      record.finishedAt = Date.now();
      attached.delete(record.executionId);
      log.emit({ type: "node_skipped", nodeId: record.id, reason: record.skipReason, ...context(record) });
    }
    const nodes = snapshot().nodes;
    finalNodes = structuredClone(nodes);
    const result: BraidResult = {
      status, terminalOutputs, nodes, executions: structuredClone(Object.fromEntries(executions)),
      terminalExecutionIds: terminals.map(record => record.executionId), revision, events: [],
      workspaces: workspaces.all(), ...(error ? { error } : {}),
      metadata: { runId, rootRunId: runId, startedAt, finishedAt: Date.now(), latencyMs: performance.now() - started, usage, usageReportedNodes },
    };
    log.emit(error ? { type: "graph_failed", error, terminalNodeIds: Object.keys(terminalOutputs), revision }
      : { type: "graph_completed", terminalNodeIds: Object.keys(terminalOutputs), revision });
    result.events = Object.freeze(log.events);
    return result;
  }
  return { runId, result: Promise.resolve().then(execute), snapshot, update, cancel, cancelExecutions, pause, holdAfter, pauseRun, resumeRun, setLimits,
    resume(ids, expectedRevision, options) {
      assertMutable(expectedRevision); validateResume(ids, options); release(ids, options); wake(); return snapshot();
    } };
}
