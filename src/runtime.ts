import type {
  BraidInput,
  BraidOptions,
  BraidResult,
  Edge,
  ExecutionError,
  ExecutionEvent,
  ModelRequest,
  ModelResponse,
  NodeOutput,
  NodeResult,
  PredecessorOutput,
} from "./types.js";
import { compileGraph, type Graph } from "./validate.js";
import { GitWorkspaces } from "./workspaces.js";
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
    code: error instanceof RunError ? error.code : "MODEL_ERROR",
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

function edgeState(edge: Edge, results: Map<string, NodeResult>): EdgeState {
  const source = results.get(edge.from)!;
  switch (source.status) {
    case "completed":
      return edge.choice === undefined || edge.choice === source.decision
        ? "active"
        : "inactive";
    case "failed":
      return edge.choice === undefined ? "active" : "blocked";
    case "skipped":
      // Failure is not inactivity: a downstream join must not silently lose required input.
      return source.skipReason === "inactive" ? "inactive" : "blocked";
    default:
      return "unresolved";
  }
}

function skip(
  result: NodeResult,
  reason: NonNullable<NodeResult["skipReason"]>,
  log: EventLog,
): void {
  result.status = "skipped";
  result.skipReason = reason;
  result.finishedAt = Date.now();
  log.emit({ type: "node_skipped", nodeId: result.id, reason });
}

function resolveDependencies(
  graph: Graph,
  results: Map<string, NodeResult>,
  log: EventLog,
): void {
  // Topological order propagates arbitrarily long skipped paths in one pass.
  for (const node of graph.topologicalOrder) {
    const result = results.get(node.id)!;
    if (result.status !== "pending") continue;
    const incoming = graph.incoming.get(node.id)!;
    const states = incoming.map((edge) => edgeState(edge, results));
    if (states.includes("unresolved")) continue;
    if (states.includes("blocked")) skip(result, "upstream_failed", log);
    else if (incoming.length > 0 && !states.includes("active"))
      skip(result, "inactive", log);
    else {
      result.status = "runnable";
      log.emit({ type: "node_runnable", nodeId: result.id });
    }
  }
}

function nodeOutput(result: NodeResult): NodeOutput {
  // Failed predecessors can have no valid response; preserve their error separately.
  const output: NodeOutput = { output: result.output ?? "" };
  if (result.decision !== undefined) output.decision = result.decision;
  if (result.model !== undefined) output.model = result.model;
  return output;
}

function predecessorOutputs(
  graph: Graph,
  id: string,
  results: Map<string, NodeResult>,
): PredecessorOutput[] {
  const activeIds = new Set(
    graph.incoming
      .get(id)!
      .filter((edge) => edgeState(edge, results) === "active")
      .map((edge) => edge.from),
  );
  // A predecessor appears once even if more than one edge connects the same pair.
  return [...activeIds].map((nodeId) => ({
    nodeId,
    ...nodeOutput(results.get(nodeId)!),
    ...(results.get(nodeId)!.error ? { error: { ...results.get(nodeId)!.error! } } : {}),
    ...(results.get(nodeId)!.workspace ? { workspace: { ...results.get(nodeId)!.workspace! } } : {}),
  }));
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
    if (request.node.type === "merge") {
      merge = await workspaces.beginMerge(invocation, request.predecessors.map(value => value.nodeId));
      invocation.merge = { sources: structuredClone(merge.sources),
        ...(merge.sourceStatus ? { sourceStatus: structuredClone(merge.sourceStatus) } : {}), finish: merge.finish };
    } else {
      invocation.workspace = await workspaces.prepare(invocation);
    }
    invocation.workspace = structuredClone(invocation.workspace!);
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
            to: result.id,
            output: predecessor.output,
            ...(predecessor.decision !== undefined
              ? { decision: predecessor.decision }
              : {}),
          });
        }
        checkDeadline();
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
  } finally {
    acceptingDecisions = false;
    acceptingWrites = false;
    await Promise.allSettled(writes);
    if (merge) {
      try { await merge.complete(result.status === "completed"); }
      catch (error) {
        result.status = "failed";
        result.error = { code: "MERGE_FAILED", message: error instanceof Error ? error.message : String(error) };
      }
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

/** Submit a complete DAG; core may append a final merge node for pending worktrees. */
export async function braid(
  input: BraidInput,
  options: BraidOptions,
): Promise<BraidResult> {
  validateOptions(options);
  const graph = compileGraph(input);
  // Snapshot options as well as the graph before any asynchronous work.
  const { runner, defaultModel, signal } = options;
  const log = createEventLog(options.onEvent);
  const maxConcurrency = options.maxConcurrency ?? 4;
  const nodeTimeoutMs = options.nodeTimeoutMs ?? 60_000;
  const graphTimeoutMs = options.graphTimeoutMs ?? 300_000;
  const startedAt = Date.now();
  const started = performance.now();
  const graphDeadline = started + graphTimeoutMs;
  const runId = crypto.randomUUID();
  const execution = { runId, rootRunId: runId };
  const edges = graph.edges;
  log.emit({
    type: "graph_created",
    nodeCount: graph.nodes.length,
    edgeCount: edges.length,
  });
  for (const node of graph.nodes) {
    const model = node.model ?? defaultModel;
    log.emit({
      type: "node_created",
      nodeId: node.id,
      nodeType: node.type,
      ...(model !== undefined ? { model } : {}),
    });
  }
  for (const edge of edges) {
    log.emit({
      type: "edge_created",
      from: edge.from,
      to: edge.to,
      ...(edge.choice !== undefined ? { choice: edge.choice } : {}),
    });
  }
  const results = new Map<string, NodeResult>(
    graph.nodes.map((node) => {
      const result: NodeResult = { id: node.id, status: "pending" };
      const model = node.model ?? defaultModel;
      if (model !== undefined) result.model = model;
      return [node.id, result];
    }),
  );
  const workspaces = new GitWorkspaces(resolve(options.cwd ?? process.cwd()), workspace => {
    if (workspace.mode === "read-only") return;
    const node = results.get(workspace.nodeId);
    if (node) node.workspace = { ...workspace };
    log.emit({ type: "workspace_updated", workspace: { ...workspace } });
  });
  const running = new Map<string, Promise<void>>();
  let automaticMergeAdded = false;
  let cleanupError: ExecutionError | undefined;
  const controller = new AbortController();
  const graphTimeout = new RunError(
    "GRAPH_TIMEOUT",
    `Graph exceeded ${graphTimeoutMs}ms`,
  );
  const onCancel = () =>
    controller.abort(new RunError("CANCELLED", "Graph cancelled by caller"));
  signal?.addEventListener("abort", onCancel, { once: true });
  if (signal?.aborted) onCancel();
  const timer = Number.isFinite(graphTimeoutMs)
    ? setTimeout(() => controller.abort(graphTimeout), graphTimeoutMs)
    : undefined;

  try {
    while (true) {
      if (performance.now() >= graphDeadline) controller.abort(graphTimeout);
      if (controller.signal.aborted) {
        const reason =
          describeError(controller.signal.reason).code === "CANCELLED"
            ? "cancelled"
            : "graph_timeout";
        for (const result of results.values()) {
          if (result.status === "pending" || result.status === "runnable")
            skip(result, reason, log);
        }
        await Promise.all(running.values());
        break;
      }
      resolveDependencies(graph, results, log);
      for (const node of graph.topologicalOrder) {
        if (running.size >= maxConcurrency) break;
        const result = results.get(node.id)!;
        if (result.status !== "runnable") continue;
        // A merge owns the source checkout and may remove predecessors. Let
        // currently running consumers finish first, and admit no workers during it.
        if ([...running.keys()].some(id => graph.nodes.find(value => value.id === id)?.type === "merge")) break;
        if (node.type === "merge" && running.size > 0) continue;
        const predecessors = predecessorOutputs(graph, node.id, results);
        const request: Omit<ModelRequest, "signal" | "decide"> = {
          goal: graph.goal,
          node: structuredClone(node),
          predecessors,
          execution: { ...execution },
        };
        if (result.model !== undefined) request.model = result.model;
        const task = runNode(
          request,
          result,
          runner,
          nodeTimeoutMs,
          controller.signal,
          graphDeadline,
          log,
          workspaces,
        ).finally(() => {
          running.delete(node.id);
        });
        running.set(node.id, task);
      }
      if (running.size === 0) {
        if (!automaticMergeAdded) {
          try { await workspaces.discardUnchanged(); }
          catch (error) {
            cleanupError = { code: "CLEANUP_FAILED", message: error instanceof Error ? error.message : String(error) };
            break;
          }
          // Checkpointing/cleanup can outlast the deadline or trigger cancellation.
          if (controller.signal.aborted || performance.now() >= graphDeadline) continue;
        }
        const pending = workspaces.pending();
        if (!automaticMergeAdded && pending.length) {
          automaticMergeAdded = true;
          let id = "__braid_merge__";
          while (results.has(id)) id += "_";
          const node = { type: "merge" as const, id, prompt: "Review every remaining node checkpoint, including partial work from failed nodes. Decide whether to integrate each change using git merge, cherry-pick, apply, or another available local operation. Preserve the user's existing changes. Call finish_merge to account for every source." };
          graph.nodes.push(node);
          graph.topologicalOrder.push(node);
          graph.incoming.set(id, pending.map(from => ({ from, to: id })));
          graph.outgoing.set(id, []);
          for (const edge of graph.incoming.get(id)!) {
            graph.edges.push(edge);
            graph.outgoing.get(edge.from)!.push(edge);
          }
          results.set(id, { id, status: "pending", ...(defaultModel ? { model: defaultModel } : {}) });
          log.emit({ type: "node_created", nodeId: id, nodeType: "merge", ...(defaultModel ? { model: defaultModel } : {}) });
          for (const edge of graph.incoming.get(id)!) log.emit({ type: "edge_created", ...edge });
          continue;
        }
        break;
      }
      await Promise.race(running.values());
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onCancel);
    try {
      await workspaces.archivePending("Run ended before an agent integrated these changes; recover them from checkpointRef");
    } catch (error) {
      cleanupError = { code: "CLEANUP_FAILED", message: error instanceof Error ? error.message : String(error) };
    }
    try { await workspaces.close(); }
    catch (error) {
      cleanupError ??= { code: "CLEANUP_FAILED", message: error instanceof Error ? error.message : String(error) };
    }
  }

  const terminalOutputs = Object.fromEntries(
    graph.nodes
      .filter(
        (node) =>
          results.get(node.id)!.status === "completed" &&
          !graph.outgoing
            .get(node.id)!
            .some((edge) => edgeState(edge, results) === "active"),
      )
      .map((node) => [node.id, nodeOutput(results.get(node.id)!)]),
  );
  const usage = { inputTokens: 0, outputTokens: 0 };
  let usageReportedNodes = 0;
  for (const result of results.values()) {
    if (result.usage) {
      usage.inputTokens += result.usage.inputTokens;
      usage.outputTokens += result.usage.outputTokens;
      usageReportedNodes++;
    }
  }
  const error = cleanupError ?? (controller.signal.aborted
    ? describeError(controller.signal.reason)
    : [...results.values()].find((result) => result.status === "failed")?.error);
  const result: BraidResult = {
    status: error ? "failed" : "completed",
    terminalOutputs,
    events: [],
    nodes: Object.fromEntries(results),
    ...(Object.values(workspaces.all()).some(value => value.mode !== "read-only") ? { workspaces: workspaces.all() } : {}),
    metadata: {
      ...execution,
      startedAt,
      finishedAt: Date.now(),
      latencyMs: performance.now() - started,
      usage,
      usageReportedNodes,
    },
  };
  if (error) {
    result.error = { ...error };
    log.emit({
      type: "graph_failed",
      error: { ...error },
      terminalNodeIds: Object.keys(terminalOutputs),
    });
  } else {
    log.emit({
      type: "graph_completed",
      terminalNodeIds: Object.keys(terminalOutputs),
    });
  }
  result.events = Object.freeze(log.events);
  return result;
}
