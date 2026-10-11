import {
  Type,
  validateToolCall,
  type Api,
  type AssistantMessage,
  type Context,
  type Message,
  type Model,
  type Tool,
  type ToolCall,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { truncateHead, type ModelRegistry, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { BraidJobs } from "./jobs.js";
import type { PiConversation, PiTranscript } from "./transcript.js";

/** Model access for the assistant; the panel passes the current Pi model. */
export interface AssistantModel {
  registry: Pick<ModelRegistry, "complete"> & Partial<Pick<ModelRegistry, "stream">>;
  model?: Model<Api>;
}

/** Bounds a single answer, independently of how the model behaves. */
const MAX_ROUNDS = 24;
const ACTIVITY_ENTRIES = 40;
const TRANSCRIPT_MESSAGES = 20;
const MESSAGE_PREVIEW = 1500;

const id = (description: string) => Type.String({ minLength: 1, description });
const TOOLS: Tool[] = [
  {
    name: "job_status",
    description: "Read this job's goal, status, revision, graph definition (node prompts and edges), the latest result per node, and every execution with its status.",
    parameters: Type.Object({}, { additionalProperties: false }),
  },
  {
    name: "execution_details",
    description: "Read one execution: status, output or error, decision, workspace, usage, human inputs, and live activity (phase, model/tool waits, recent history). Pass executionId, or nodeId for the node's latest execution.",
    parameters: Type.Object({
      executionId: Type.Optional(id("Exact execution ID.")),
      nodeId: Type.Optional(id("Node ID; reads its latest execution.")),
      activityBefore: Type.Optional(Type.Integer({ minimum: 1, description: "Page activity entries before this sequence number." })),
    }, { additionalProperties: false }),
  },
  {
    name: "execution_transcript",
    description: "Read the latest messages of one execution's worker conversation: assistant text, tool calls and results, and human messages. Available while it runs and for recently finished executions.",
    parameters: Type.Object({
      executionId: id("Exact execution ID."),
      last: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: `Number of latest messages; default ${TRANSCRIPT_MESSAGES}.` })),
    }, { additionalProperties: false }),
  },
  {
    name: "message_execution",
    description: "Send a message to a running execution's worker on the user's behalf. It is delivered before the worker's next model request (a running tool batch finishes first) and is recorded as human input on the execution. Use only when the user asks to guide, correct, or inform a running execution. Write a self-contained instruction the worker can act on; it cannot see this conversation.",
    parameters: Type.Object({
      executionId: id("Exact ID of a running execution."),
      message: id("The instruction for the worker."),
    }, { additionalProperties: false }),
  },
];

const short = (value: unknown): string => typeof value === "string" ? (value.length > 13 ? `${value.slice(0, 8)}…` : value) : "?";
const target = (args: Record<string, unknown>): string =>
  args.executionId !== undefined ? `execution ${short(args.executionId)}` : args.nodeId !== undefined ? `node ${JSON.stringify(args.nodeId)}` : "";

/** Compact tool cards: what was read or sent, with full results on ctrl+o. */
function renderer(call: (args: Record<string, unknown>, theme: Theme) => string): ToolDefinition {
  return {
    renderCall: (args: Record<string, unknown>, theme: Theme) => new Text(call(args ?? {}, theme), 0, 0),
    renderResult: (result: { content: { type: string; text?: string }[] }, options: { expanded: boolean }, theme: Theme) => {
      const text = textOf(result.content);
      const first = text.split("\n").find(line => line.trim()) ?? "";
      return new Text(options.expanded ? text : theme.fg("dim", first.length > 160 ? `${first.slice(0, 159)}…` : first), 0, 0);
    },
  } as unknown as ToolDefinition;
}

const RENDERERS = new Map<string, ToolDefinition>([
  ["job_status", renderer((_args, theme) => theme.fg("toolTitle", theme.bold("Read job status")))],
  ["execution_details", renderer((args, theme) => theme.fg("toolTitle", theme.bold("Read details")) + " " + theme.fg("muted", target(args)))],
  ["execution_transcript", renderer((args, theme) => theme.fg("toolTitle", theme.bold("Read conversation")) + " " + theme.fg("muted", `of ${target(args)}`))],
  ["message_execution", renderer((args, theme) =>
    theme.fg("warning", theme.bold("✎ Message")) + " " + theme.fg("muted", `to ${target(args)}`) +
    (typeof args.message === "string" ? `\n${args.message}` : ""))],
]);

const clip = (text: string, max = MESSAGE_PREVIEW): string =>
  text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} more characters]`;

const textOf = (content: readonly { type: string; text?: string }[]): string =>
  content.flatMap(block => block.type === "text" && block.text ? [block.text] : []).join("\n");

function describeTranscript(transcript: PiTranscript, last: number): string {
  const lines: string[] = [];
  const messages = transcript.messages.slice(-last);
  if (messages.length < transcript.messages.length) lines.push(`[${transcript.messages.length - messages.length} earlier messages omitted]`);
  else lines.push(`[node prompt] ${clip(transcript.intro.prompt)}`);
  for (const message of messages) {
    if (message.role === "human") lines.push(`[human input · ${message.delivered ? "delivered" : "not delivered"}] ${clip(message.text)}`);
    else if (message.role === "toolResult") lines.push(`[${message.toolName} ${message.isError ? "error" : "result"}] ${clip(textOf(message.content), 800)}`);
    else if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "text" && block.text.trim()) lines.push(`[assistant] ${clip(block.text)}`);
        else if (block.type === "toolCall") lines.push(`[tool call ${block.name}] ${clip(JSON.stringify(block.arguments), 400)}`);
      }
      if (message.stopReason === "error" || message.stopReason === "aborted") lines.push(`[${message.stopReason}] ${message.errorMessage ?? ""}`);
    }
  }
  if (transcript.streaming) lines.push(`[assistant, streaming] ${clip(textOf(transcript.streaming.content))}`);
  for (const callId of transcript.running.keys()) lines.push(`[tool running] ${callId}`);
  lines.push(transcript.finished ? "[execution finished]" : "[execution running]");
  return lines.join("\n");
}

/**
 * A side conversation about one Braid job, or about one node of it. Each
 * scope keeps its own history. It inspects the job through
 * read-only tools and can message running executions; graph changes,
 * cancellation, and resumption stay with the main agent.
 */
export class BraidAssistant {
  readonly conversation: PiConversation;
  private readonly history: Message[] = [];
  private queued: { text: string; view: string }[] = [];
  private controller: AbortController | undefined;
  private pending: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(
    private readonly jobs: BraidJobs,
    private readonly jobId: string,
    cwd: string,
    private readonly onChange: () => void,
    /** The node this conversation is about; absent for the whole job. */
    readonly nodeId?: string,
  ) {
    this.conversation = { cwd, messages: [], running: new Map(), renderers: RENDERERS, version: 0 };
  }

  get busy(): boolean {
    return this.controller !== undefined;
  }

  /** Ask a question or request an intervention. `view` describes what the panel shows. */
  send(text: string, view: string, model: AssistantModel): void {
    if (this.disposed || !text.trim()) return;
    this.conversation.messages.push({ role: "user", content: text, timestamp: Date.now() });
    this.queued.push({ text, view });
    this.changed();
    if (!this.controller) void this.run(model);
  }

  /** Stop the current answer; queued questions are dropped. */
  abort(): void {
    this.queued = [];
    this.controller?.abort();
  }

  dispose(): void {
    this.disposed = true;
    this.abort();
    clearTimeout(this.pending);
  }

  private systemPrompt(): string {
    const job = this.jobs.get(this.jobId);
    return "You are the Braid assistant inside the /braid panel of Pi. You help the user understand and steer one background Braid job " +
      `(${job?.handle ?? this.jobId}: ${JSON.stringify(job?.goal ?? "")}). ` +
      "A Braid job is a graph of nodes; each run of a node is an execution with its own isolated worker conversation. " +
      "Use your tools to inspect the job instead of guessing, and cite node and execution IDs. " +
      "When the user asks to guide, correct, or inform a running execution, use message_execution with a clear, self-contained instruction. " +
      "If it is unclear which execution they mean, or none is running, say so instead of guessing. Never message an execution on your own initiative. " +
      "Messages reach the worker before its next model request; they cannot change finished executions, the graph, or a decision already made. " +
      "You cannot edit the graph, cancel, or resume; tell the user to ask the main Pi agent for that. " +
      "You do not see the main conversation. Answer concisely, in the user's language." +
      (this.nodeId === undefined
        ? " This conversation is about the whole job; separate conversations exist for individual nodes."
        : ` This conversation is about node ${JSON.stringify(this.nodeId)} and all of its executions; when the user says "it" or "this node", they mean this node. ` +
          "Each question says which execution the panel shows. You may still read other nodes for context, but message only this node's executions unless the user names another.");
  }

  private async run(model: AssistantModel): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    try {
      while (this.queued.length && !controller.signal.aborted) {
        for (const { text, view } of this.queued.splice(0)) {
          this.history.push({ role: "user", content: `[Panel view: ${view}]\n\n${text}`, timestamp: Date.now() });
        }
        await this.answer(model, controller.signal);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.closeToolCalls();
      this.fail(controller.signal.aborted ? "aborted" : "error", controller.signal.aborted ? "Stopped" : message);
    } finally {
      this.controller = undefined;
      this.conversation.running.clear();
      this.changed();
    }
  }

  private async answer(source: AssistantModel, signal: AbortSignal): Promise<void> {
    const model = source.model;
    if (!model) throw new Error("Choose a Pi model with /model to use the Braid assistant");
    for (let round = 0; round < MAX_ROUNDS; round++) {
      signal.throwIfAborted();
      const context: Context = { systemPrompt: this.systemPrompt(), messages: this.history, tools: TOOLS };
      const options = { signal, maxRetries: 0 };
      let response: AssistantMessage;
      if (source.registry.stream) {
        const stream = source.registry.stream(model, context, options);
        for await (const event of stream) {
          if (event.type === "done" || event.type === "error") continue;
          this.conversation.streaming = event.partial;
          this.changed(true);
        }
        response = await stream.result();
      } else {
        response = await source.registry.complete(model, context, options);
      }
      delete this.conversation.streaming;
      this.conversation.messages.push(response);
      this.changed();
      if (response.stopReason === "aborted") signal.throwIfAborted();
      // Failed responses are shown, but never sent back to the provider.
      if (response.stopReason === "error" || response.stopReason === "aborted") return;
      this.history.push(response);
      const calls = response.content.filter((block): block is ToolCall => block.type === "toolCall");
      if (!calls.length) return;
      for (const call of calls) {
        signal.throwIfAborted();
        this.conversation.running.set(call.id, undefined);
        this.changed();
        const result = this.execute(call);
        this.conversation.running.delete(call.id);
        this.history.push(result);
        this.conversation.messages.push(result);
        this.changed();
      }
    }
    this.fail("error", `Stopped after ${MAX_ROUNDS} tool rounds`);
  }

  private execute(call: ToolCall): ToolResultMessage {
    let text: string;
    let isError = false;
    try {
      const args = validateToolCall(TOOLS, call) as Record<string, unknown>;
      text = this.tool(call.name, args);
    } catch (error) {
      text = error instanceof Error ? error.message : String(error);
      isError = true;
    }
    return { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text }], isError, timestamp: Date.now() };
  }

  private tool(name: string, args: Record<string, unknown>): string {
    const job = this.jobs.get(this.jobId);
    if (!job) throw this.jobs.unknownJob(this.jobId);
    const preview = (value: unknown) => {
      const full = JSON.stringify(value, null, 2);
      const result = truncateHead(full);
      return result.truncated ? `${result.content}\n[Truncated; ask about a specific node or execution.]` : full;
    };
    switch (name) {
      case "job_status": {
        const state = job.result ?? job.execution;
        return preview({
          handle: job.handle, goal: job.goal, status: job.status, error: job.error ?? state?.error,
          revision: job.execution?.revision, pausedExecutionIds: job.execution?.pausedExecutionIds,
          graph: job.execution?.graph,
          nodes: state?.nodes,
          executions: Object.values(state?.executions ?? {}).map(execution => ({
            executionId: execution.executionId, nodeId: execution.id, status: execution.status,
            ...(execution.iteration ? { iteration: execution.iteration } : {}),
            ...(execution.humanInputs?.length ? { humanInputs: execution.humanInputs.length } : {}),
          })),
        });
      }
      case "execution_details": {
        if (args.executionId === undefined && args.nodeId === undefined) throw new Error("Pass executionId or nodeId");
        const node = this.jobs.getNode(this.jobId, args.nodeId as string | undefined, args.executionId as string | undefined);
        const activity = node.executionId ? this.jobs.getActivity(this.jobId, node.executionId, {
          limit: ACTIVITY_ENTRIES, ...(args.activityBefore === undefined ? {} : { before: args.activityBefore as number }),
        }) : undefined;
        return preview({ node, ...(activity ? { activity } : {}) });
      }
      case "execution_transcript": {
        const transcript = this.jobs.getTranscript(this.jobId, args.executionId as string);
        if (!transcript) throw new Error("No live conversation is retained for this execution; use execution_details for its output and activity history.");
        return describeTranscript(transcript, (args.last as number | undefined) ?? TRANSCRIPT_MESSAGES);
      }
      case "message_execution": {
        this.jobs.sendInput(this.jobId, args.executionId as string, args.message as string);
        return "Queued. The worker receives it before its next model request, after any running tool batch.";
      }
      default:
        throw new Error(`Unknown tool ${name}`);
    }
  }

  /** Answer tool calls interrupted by an abort, so the next request is well formed. */
  private closeToolCalls(): void {
    let index = this.history.length - 1;
    while (index >= 0 && this.history[index]!.role !== "assistant") index--;
    const last = this.history[index];
    if (last?.role !== "assistant") return;
    const answered = new Set(this.history.slice(index + 1).flatMap(message => message.role === "toolResult" ? [message.toolCallId] : []));
    for (const block of last.content) {
      if (block.type !== "toolCall" || answered.has(block.id)) continue;
      const result: ToolResultMessage = {
        role: "toolResult", toolCallId: block.id, toolName: block.name,
        content: [{ type: "text", text: "Stopped by the user before this tool ran" }], isError: true, timestamp: Date.now(),
      };
      this.history.push(result);
      this.conversation.messages.push(result);
    }
  }

  private fail(stopReason: "error" | "aborted", errorMessage: string): void {
    const partial = this.conversation.streaming;
    delete this.conversation.streaming;
    const message: AssistantMessage = {
      role: "assistant", api: partial?.api ?? "braid", provider: partial?.provider ?? "braid", model: partial?.model ?? "assistant",
      content: partial?.content ?? [], stopReason, errorMessage, timestamp: Date.now(),
      usage: partial?.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    // The model sees what was said, without a dangling unanswered tool call.
    if (message.content.some(block => block.type === "toolCall")) message.content = message.content.filter(block => block.type !== "toolCall");
    this.conversation.messages.push(message);
    if (message.content.length) this.history.push({ ...message, stopReason: "stop" });
    this.changed();
  }

  /** Token bursts coalesce into at most one notification per 100 ms. */
  private changed(burst = false): void {
    this.conversation.version++;
    if (!burst) {
      clearTimeout(this.pending);
      this.pending = undefined;
      this.emit();
    } else if (!this.pending) {
      this.pending = setTimeout(() => { this.pending = undefined; this.emit(); }, 100);
      this.pending.unref?.();
    }
  }

  private emit(): void {
    if (this.disposed) return;
    try { this.onChange(); }
    catch { /* Observers cannot fail the assistant. */ }
  }
}
