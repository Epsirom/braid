import type {
  BraidInput,
  BraidOptions,
  BraidResult,
  BraidRun,
  BraidSnapshot,
  GraphUpdate,
  NodeExecution,
  Edge,
  ExecutionError,
  ExecutionEvent,
  ModelRequest,
  ModelResponse,
  NodeOutput,
  NodeResult,
  NodeWorkspace,
  PredecessorOutput,
} from "./types.js";
import { compileGraph, type Graph } from "./validate.js";
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
  if (!Number.isSafeInteger(options.maxExecutions ?? 1000) || (options.maxExecutions ?? 1000) < 1)
    throw new TypeError("maxExecutions must be a positive integer");
  for (const key of ["nodeTimeoutMs", "graphTimeoutMs"] as const) {
    const value = options[key];
    if (
      value !== undefined &&
      value !== Infinity &&
      (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647)
    ) {
      throw new TypeError(
        `${key} must be Infinity or a positive number no greater than 2147483647`,
      );
    }
  }
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

async function runNode(
  request: Omit<ModelRequest, "signal" | "decide">,
  result: NodeResult,
  runner: BraidOptions["runner"],
  timeoutMs: number,
  graphSignal: AbortSignal,
  graphDeadline: number,
  log: EventLog,
  workspaces: GitWorkspaces,
  fail: (error: ExecutionError, infrastructure?: boolean) => void,
): Promise<void> {
  result.status = "running";
  result.startedAt = Date.now();
  const started = performance.now();
  const controller = new AbortController();
  const signal = AbortSignal.any([graphSignal, controller.signal]);
  const nodeTimeout = new RunError(
    "NODE_TIMEOUT",
    `Node '${result.id}' exceeded ${timeoutMs}ms`,
  );
  const timer = Number.isFinite(timeoutMs)
    ? setTimeout(() => controller.abort(nodeTimeout), timeoutMs)
    : undefined;
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
  if (Number.isFinite(timeoutMs) || Number.isFinite(graphDeadline)) {
    invocation.deadlines = {
      ...(Number.isFinite(timeoutMs) ? { node: started + timeoutMs } : {}),
      ...(Number.isFinite(graphDeadline) ? { graph: graphDeadline } : {}),
    };
  }
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
    const error =
      now >= graphDeadline
        ? new RunError("GRAPH_TIMEOUT", "Graph deadline exceeded")
        : now - started >= timeoutMs
          ? nodeTimeout
          : undefined;
    if (error) {
      controller.abort(error);
      throw error;
    }
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
    acceptingWrites = false;
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

interface LoopState {
  iteration: number;
  records: Map<string, NodeExecution>;
  previous?: NodeExecution;
  done: boolean;
}

const settled = (record: NodeResult) => ["completed", "failed", "skipped"].includes(record.status);
const edgeKey = (edge: Edge) => JSON.stringify([edge.from, edge.to, edge.choice, edge.feedback, edge.executionId]);

/** Execute a graph to completion. Use startBraid for live edits and pause/resume. */
export async function braid(input: BraidInput, options: BraidOptions): Promise<BraidResult> {
  return startBraid(input, options).result;
}

/** Definitions are mutable; each admitted execution captures its definition and inputs. */
export function startBraid(input: BraidInput, options: BraidOptions): BraidRun {
  validateOptions(options);
  let definition = structuredClone(input);
  let graph = compileGraph(definition);
  if (graph.edges.some(edge => edge.executionId)) throw new TypeError("Initial edges cannot reference historical executions");
  const { runner, defaultModel, signal } = options;
  const maxConcurrency = options.maxConcurrency ?? 4;
  const maxExecutions = options.maxExecutions ?? 1000;
  const nodeTimeoutMs = options.nodeTimeoutMs ?? 60_000;
  const graphTimeoutMs = options.graphTimeoutMs ?? 300_000;
  const startedAt = Date.now();
  const started = performance.now();
  const graphDeadline = started + graphTimeoutMs;
  const runId = crypto.randomUUID();
  const log = createEventLog(options.onEvent);
  const executions = new Map<string, NodeExecution>();
  const latest = new Map<string, NodeExecution>();
  const roots = new Map<string, NodeExecution>();
  const loops = new Map<string, LoopState>();
  const paused = new Set<string>();
  const running = new Map<string, Promise<void>>();
  const controller = new AbortController();
  let revision = 0;
  let status: BraidSnapshot["status"] = "running";
  let finalNodes: Record<string, NodeResult> | undefined;
  let wake!: () => void;
  let changed: Promise<void>;
  function resetWake() { changed = new Promise(resolve => { wake = resolve; }); }
  resetWake();
  controller.signal.addEventListener("abort", () => wake());
  const graphTimeout = new RunError("GRAPH_TIMEOUT", `Graph exceeded ${graphTimeoutMs}ms`);
  const cancel = () => {
    if (status !== "completed" && status !== "failed") controller.abort(new RunError("CANCELLED", "Graph cancelled by caller"));
  };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = Number.isFinite(graphTimeoutMs) ? setTimeout(() => controller.abort(graphTimeout), graphTimeoutMs) : undefined;
  const context = (record: NodeExecution) => ({ executionId: record.executionId, revision: record.revision,
    ...(record.loopId ? { loopId: record.loopId, iteration: record.iteration! } : {}) });
  const workspaces = new GitWorkspaces(resolve(options.cwd ?? process.cwd()), workspace => {
    const record = executions.get(workspace.executionId!);
    if (record) record.workspace = { ...workspace };
    log.emit({ type: "workspace_updated", workspace, ...(record ? context(record) : {}) });
  });

  function snapshot(): BraidSnapshot {
    const nodes: Record<string, NodeResult> = Object.fromEntries(graph.nodes.map(node => [node.id, latest.get(node.id) ?? { id: node.id, status: "pending" }]));
    for (const [id, record] of latest) Object.defineProperty(nodes, id, { value: record, enumerable: true, writable: true, configurable: true });
    return structuredClone({ runId, status, revision, graph: definition, nodes: finalNodes ?? nodes,
      executions: Object.fromEntries(executions), pausedExecutionIds: [...paused],
      ...(controller.signal.aborted ? { error: describeError(controller.signal.reason) } : {}) });
  }

  function assertMutable(expectedRevision: number) {
    if (status === "finalizing" || status === "completed" || status === "failed" || controller.signal.aborted)
      throw new Error("This run is no longer accepting updates");
    if (expectedRevision !== revision) throw new Error(`Revision conflict: expected ${expectedRevision}, current ${revision}`);
  }
  function validateResume(ids: readonly string[]) {
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.some(id => !paused.has(id)))
      throw new Error("resume must contain unique paused execution IDs");
  }
  function release(ids: readonly string[]) {
    for (const id of ids) paused.delete(id);
    status = "running";
    for (const id of ids) {
      const record = executions.get(id)!;
      log.emit({ type: "execution_resumed", nodeId: record.id, ...context(record) });
    }
  }
  function reconcileLoops(previousGraph?: Graph) {
    // Preserve the already admitted activation when an edit moves a definition
    // between scopes. Keep removed members until their original round drains.
    const previousRecords = new Map<string, NodeExecution>();
    for (const node of previousGraph?.nodes ?? []) {
      const scope = previousGraph!.membership.get(node.id);
      const record = scope ? loops.get(scope)?.records.get(node.id) : roots.get(node.id);
      if (record) previousRecords.set(node.id, record);
    }
    for (const [id, state] of loops) {
      const current = graph.loops.get(id);
      for (const [nodeId, record] of state.records) {
        if (!current?.members.has(nodeId) && !graph.membership.has(nodeId)) roots.set(nodeId, record);
      }
    }
    for (const [id, loop] of graph.loops) {
      let state = loops.get(id);
      if (!state) {
        state = { iteration: 1, records: new Map(), done: false };
        loops.set(id, state);
      }
      for (const nodeId of loop.members) {
        if (!state.records.has(nodeId) && previousGraph?.membership.get(nodeId) !== id) {
          const record = previousRecords.get(nodeId) ?? roots.get(nodeId);
          if (record) { state.records.set(nodeId, record); roots.delete(nodeId); }
        }
      }
      if ([...loop.members].some(nodeId => !state.records.has(nodeId))) state.done = false;
    }
  }
  reconcileLoops();

  function update(patch: GraphUpdate): BraidSnapshot {
    assertMutable(patch.expectedRevision);
    const allowed = ["expectedRevision", "upsertNodes", "removeNodeIds", "addEdges", "removeEdges", "promptTemplates", "loops", "resume"];
    if (Object.keys(patch).some(key => !allowed.includes(key))) throw new TypeError("Unknown graph update field");
    for (const key of ["upsertNodes", "removeNodeIds", "addEdges", "removeEdges", "loops", "resume"] as const)
      if (patch[key] !== undefined && !Array.isArray(patch[key])) throw new TypeError(`${key} must be an array`);
    if (patch.removeNodeIds?.some(id => typeof id !== "string" || !id.trim())) throw new TypeError("removeNodeIds must contain non-empty node IDs");
    for (const edge of patch.removeEdges ?? []) {
      if (!edge || typeof edge !== "object" || !edge.from || !edge.to ||
          Object.entries(edge).some(([key, value]) => !["from", "to", "choice", "feedback", "executionId"].includes(key) || typeof value !== "string" || !value.trim()))
        throw new TypeError("removeEdges must contain complete edge identities");
    }
    validateResume(patch.resume ?? []);
    const removed = new Set(patch.removeNodeIds ?? []);
    const nodes = new Map(definition.nodes.filter(node => !removed.has(node.id)).map(node => [node.id, node]));
    for (const node of patch.upsertNodes ?? []) nodes.set(node.id, node);
    const removedEdges = new Set((patch.removeEdges ?? []).map(edgeKey));
    const edges = definition.edges.filter(edge => !removed.has(edge.from) && !removed.has(edge.to) && !removedEdges.has(edgeKey(edge)));
    const candidate: BraidInput = structuredClone({ ...definition, nodes: [...nodes.values()], edges: [...edges, ...(patch.addEdges ?? [])],
      ...(patch.promptTemplates !== undefined ? { promptTemplates: patch.promptTemplates } : {}),
      ...(patch.loops !== undefined ? { loops: patch.loops } : {}) });
    const compiled = compileGraph(candidate);
    for (const edge of compiled.edges) {
      if (!edge.executionId) continue;
      const record = executions.get(edge.executionId);
      if (!record || record.id !== edge.from || !settled(record)) throw new TypeError(`Unknown or unfinished source execution '${edge.executionId}'`);
      if (edge.choice && (record.node.type !== "decision" || !record.node.choices.includes(edge.choice)))
        throw new TypeError(`Invalid choice for execution '${edge.executionId}'`);
    }
    const previousGraph = graph;
    definition = candidate;
    graph = compiled;
    revision++;
    reconcileLoops(previousGraph);
    // Commit all state before publishing callbacks, which may themselves submit an update.
    for (const id of patch.resume ?? []) paused.delete(id);
    status = "running";
    log.emit({ type: "graph_updated", graph: definition, revision });
    for (const [id, loop] of graph.loops) if (!previousGraph.loops.has(id))
      log.emit({ type: "loop_started", loopId: id, entry: loop.entry, iteration: loops.get(id)!.iteration, revision });
    for (const id of patch.resume ?? []) {
      const record = executions.get(id)!;
      log.emit({ type: "execution_resumed", nodeId: record.id, ...context(record) });
    }
    wake();
    return snapshot();
  }

  function frame(nodeId: string): Map<string, NodeExecution> {
    const loopId = graph.membership.get(nodeId);
    return loopId ? loops.get(loopId)!.records : roots;
  }
  function sourceFor(edge: Edge, target: string): NodeExecution | undefined {
    if (edge.executionId) return executions.get(edge.executionId);
    const sourceLoop = graph.membership.get(edge.from);
    if (sourceLoop && sourceLoop !== graph.membership.get(target) && !loops.get(sourceLoop)!.done) return undefined;
    return frame(edge.from).get(edge.from);
  }
  function dependencies(nodeId: string): { states: EdgeState[]; predecessors: NodeExecution[] } {
    const inputs = graph.incoming.get(nodeId)!.filter(edge => !edge.feedback).map(edge => ({ edge, record: sourceFor(edge, nodeId) }));
    const states = inputs.map(({ edge, record }) => record && (running.has(record.executionId) || paused.has(record.executionId)) ? "unresolved" as const : edgeState(edge, record));
    const predecessors = inputs.filter((_, index) => states[index] === "active").map(value => value.record!);
    const loopId = graph.membership.get(nodeId);
    const loop = loopId ? graph.loops.get(loopId)! : undefined;
    const state = loopId ? loops.get(loopId)! : undefined;
    if (loop?.entry === nodeId && state?.previous) {
      states.push("active");
      predecessors.push(state.previous);
    }
    return { states, predecessors: [...new Map(predecessors.map(record => [record.executionId, record])).values()] };
  }
  function admit(nodeId: string, predecessors: NodeExecution[], skipReason?: NodeResult["skipReason"]) {
    if (executions.size >= maxExecutions) {
      controller.abort(new RunError("EXECUTION_LIMIT", `Graph exceeded ${maxExecutions} executions`));
      return;
    }
    const node = graph.nodes.find(node => node.id === nodeId)!;
    const loopId = graph.membership.get(node.id);
    const record: NodeExecution = {
      id: node.id, executionId: crypto.randomUUID(), node: structuredClone(node), revision,
      predecessorExecutionIds: predecessors.map(value => value.executionId), status: skipReason ? "skipped" : "runnable",
      ...(loopId ? { loopId, iteration: loops.get(loopId)!.iteration } : {}),
      ...(node.model ?? defaultModel ? { model: node.model ?? defaultModel! } : {}),
    };
    executions.set(record.executionId, record);
    latest.set(node.id, record);
    frame(node.id).set(node.id, record);
    if (skipReason) {
      record.skipReason = skipReason;
      record.finishedAt = Date.now();
      log.emit({ type: "node_skipped", nodeId: record.id, reason: skipReason, ...context(record) });
      return;
    }
    const scopedLog: EventLog = { events: log.events, emit: event => log.emit({ ...event, ...context(record) }) };
    const request: Omit<ModelRequest, "signal" | "decide"> = {
      goal: graph.goal, node: structuredClone(record.node), execution: { runId, rootRunId: runId, ...context(record) },
      predecessors: predecessors.map(value => ({ nodeId: value.id, executionId: value.executionId, ...nodeOutput(value),
        ...(value.error ? { error: { ...value.error } } : {}), ...(value.workspace ? { workspace: { ...value.workspace } } : {}) })),
      ...(record.model ? { model: record.model } : {}),
    };
    // Reserve the slot before publishing events or invoking asynchronous runner code.
    const task = Promise.resolve().then(async () => {
      scopedLog.emit({ type: "node_runnable", nodeId: record.id });
      await runNode(request, record, runner, nodeTimeoutMs, controller.signal, graphDeadline, scopedLog, workspaces, (error, infrastructure) => {
        if (infrastructure) controller.abort(new RunError(error.code, error.message));
        else if (record.node.requireSuccess) controller.abort(new RunError("REQUIRED_NODE_FAILED", `Required node '${record.id}' (${record.executionId}) failed: ${error.message}`));
      });
      if (record.node.pauseAfter && !controller.signal.aborted) {
        paused.add(record.executionId);
        scopedLog.emit({ type: "execution_paused", nodeId: record.id });
      }
    }).catch(error => {
      controller.abort(new RunError("SCHEDULING_ERROR", error instanceof Error ? error.message : String(error)));
    }).finally(() => { running.delete(record.executionId); wake(); });
    running.set(record.executionId, task);
  }

  function advanceLoops(): boolean {
    for (const [id, loop] of graph.loops) {
      const state = loops.get(id)!;
      if (state.done || ![...loop.members].every(nodeId => state.records.has(nodeId))) continue;
      if ([...state.records.values()].some(record => !settled(record) || running.has(record.executionId) || paused.has(record.executionId))) continue;
      const decision = state.records.get(loop.feedback.from)!;
      if (edgeState(loop.feedback, decision) === "active") {
        if (state.iteration >= loop.maxIterations) {
          controller.abort(new RunError("LOOP_LIMIT", `Loop '${id}' exceeded ${loop.maxIterations} iterations`));
          return true;
        }
        state.iteration++;
        state.previous = decision;
        state.records = new Map();
        log.emit({ type: "loop_started", loopId: id, iteration: state.iteration, entry: loop.entry, revision });
      } else {
        state.done = true;
        log.emit({ type: "loop_completed", loopId: id, iteration: state.iteration, entry: loop.entry, revision });
      }
      return true;
    }
    return false;
  }

  async function execute(): Promise<BraidResult> {
    let cleanupError: ExecutionError | undefined;
    try {
      log.emit({ type: "graph_created", nodeCount: graph.nodes.length, edgeCount: graph.edges.length, revision });
      for (const node of graph.nodes) log.emit({ type: "node_created", nodeId: node.id, nodeType: node.type, ...(node.model ?? defaultModel ? { model: node.model ?? defaultModel! } : {}) });
      for (const edge of graph.edges) log.emit({ type: "edge_created", ...edge });
      await workspaces.initialize(runId);
      for (const [id, loop] of graph.loops) log.emit({ type: "loop_started", loopId: id, iteration: 1, entry: loop.entry, revision });
      while (true) {
        if (performance.now() >= graphDeadline) controller.abort(graphTimeout);
        if (controller.signal.aborted) { await Promise.all(running.values()); break; }
        resetWake();
        let progressed = advanceLoops();
        const schedulingRevision = revision;
        for (const node of graph.topologicalOrder) {
          if (controller.signal.aborted || revision !== schedulingRevision) break;
          const loopId = graph.membership.get(node.id);
          if (loopId && loops.get(loopId)!.done || frame(node.id).has(node.id)) continue;
          const { states, predecessors } = dependencies(node.id);
          if (states.includes("unresolved")) continue;
          const reason = states.includes("blocked") ? "upstream_failed" : states.length && !states.includes("active") ? "inactive" : undefined;
          if (!reason && running.size >= maxConcurrency) continue;
          admit(node.id, predecessors, reason);
          progressed = true;
        }
        if (controller.signal.aborted || progressed || schedulingRevision !== revision) continue;
        if (running.size || paused.size) {
          status = running.size ? "running" : "waiting";
          await changed;
          continue;
        }
        const unfinished = graph.nodes.some(node => !frame(node.id).has(node.id));
        if (unfinished) controller.abort(new RunError("SCHEDULING_ERROR", "The current graph cannot make progress"));
        break;
      }
    } catch (error) {
      controller.abort(new RunError("SCHEDULING_ERROR", error instanceof Error ? error.message : String(error)));
      await Promise.all(running.values());
    } finally {
      status = "finalizing";
      try { await workspaces.archivePending("Execution checkpoint retained for inspection and future recovery"); }
      catch (error) { cleanupError = { code: "CLEANUP_FAILED", message: error instanceof Error ? error.message : String(error) }; }
      try { await workspaces.close(); }
      catch (error) { cleanupError ??= { code: "CLEANUP_FAILED", message: error instanceof Error ? error.message : String(error) }; }
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    }
    const consumed = new Set([...executions.values()].flatMap(record => record.status === "skipped" ? [] : record.predecessorExecutionIds));
    const terminals = [...executions.values()].filter(record => record.status === "completed" && !consumed.has(record.executionId));
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
    const nodes = snapshot().nodes;
    for (const node of Object.values(nodes)) if (node.status === "pending") {
      node.status = "skipped";
      node.skipReason = error?.code === "CANCELLED" ? "cancelled" : error?.code === "GRAPH_TIMEOUT" ? "graph_timeout" : "run_failed";
      log.emit({ type: "node_skipped", nodeId: node.id, reason: node.skipReason });
    }
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
  return { runId, result: Promise.resolve().then(execute), snapshot, update, cancel,
    resume(ids, expectedRevision) { assertMutable(expectedRevision); validateResume(ids); release(ids); wake(); return snapshot(); } };
}
