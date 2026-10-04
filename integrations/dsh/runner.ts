import { resolve } from "node:path";
import {
  BlockAssembler, createToolResultMessage,
  type LlmRuntime, type RequestMessage, type TokenUsage,
} from "@deepseek-ai/dsh-llm";
import {
  formatBudgetReminder, gitToolDefinition, finishMergeToolDefinition,
  mergeInstructions, parseGitToolArguments, parseFinishMergeArguments,
  type ModelRunner,
} from "@chrok/braid";
import { createWorkerTools } from "./worker-tools.js";

export interface NodeProgress {
  nodeId: string;
  executionId: string;
  contextTokens: number;
  contextWindow?: number;
  contextSource: "reported" | "estimate";
  toolCalls: number;
  toolRounds: number;
  phase: "model" | "tool";
}

export interface RunnerOptions {
  cwd: string;
  maxToolRounds?: number;
  maxToolCalls?: number;
  onUsage?: (usage: TokenUsage) => void;
  onProgress?: (progress: NodeProgress) => void;
}

export function validateBudgets(options: { maxToolRounds?: number | undefined; maxToolCalls?: number | undefined }): void {
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined && value !== Infinity && (!Number.isSafeInteger(value) || value < 1))
      throw new Error(`${key} must be a positive safe integer or Infinity`);
  }
}

/** Fresh, private model contexts. DSH owns provider routing and credentials. */
export type DshLlm = Pick<LlmRuntime, "stream"> & Partial<Pick<LlmRuntime, "resolveModelInfo">>;

export function createDshRunner(llm: DshLlm, options: RunnerOptions): ModelRunner {
  validateBudgets({ maxToolRounds: options.maxToolRounds, maxToolCalls: options.maxToolCalls });
  return async request => {
    const route = request.model;
    const slash = route?.indexOf("/") ?? -1;
    if (!route || slash < 1 || slash === route.length - 1)
      throw new Error("Choose a DSH provider/model, or set node.model to an exact provider/model-id");
    const provider = route.slice(0, slash), model = route.slice(slash + 1);
    const modelInfo = await llm.resolveModelInfo?.(provider, model, request.signal);
    const contextWindow = modelInfo?.context?.contextWindow;
    request.signal.throwIfAborted();
    const workspace = request.workspace ?? {
      nodeId: request.node.id, mode: "read-only" as const,
      workingDirectory: resolve(options.cwd), state: "ready" as const,
    };
    const files = await createWorkerTools(request, workspace);
    const tools = files.map(({ name, description, parameters }) => ({ name, description, parameters: JSON.parse(JSON.stringify(parameters)) as Record<string, unknown> }));
    const integrating = request.node.type === "merge" || request.node.type === "integrate";
    if (request.git) tools.push(gitToolDefinition(integrating));
    if (request.merge) tools.push(finishMergeToolDefinition(request.merge.sources.map(source => source.executionId!)));
    if (request.node.type === "decision") tools.push({
      name: "decide", description: "Select exactly one declared choice before answering.",
      parameters: { type: "object", properties: { choice: { type: "string", enum: request.node.choices } }, required: ["choice"], additionalProperties: false },
    });
    const messages: RequestMessage[] = [{ role: "user", content: [{ type: "text", text: JSON.stringify({
      goal: request.goal, nodeId: request.node.id, execution: request.execution,
      prompt: request.node.prompt, predecessors: request.predecessors, workspace,
      ...(request.merge ? { mergeSources: request.merge.sources, sourceCheckoutStatus: request.merge.sourceStatus } : {}),
    }) }] }];
    const system = "You are an isolated Braid worker. Complete only the assigned node. " +
      "Use read, ls, grep, and find to inspect files. Only writable Git workspaces have write, edit, and shell tools. " +
      "Use your assigned workingDirectory. Never write outside it; integrate alone may edit sourceRoot. " +
      "Shell tools have host permissions, not a sandbox. Do not change shared Git refs, branches, configuration, hooks, or worktree registrations. " +
      "Do not launch recursive agents, daemons, or background servers. Use execution-specific temporary resources. " +
      "Checkpoints exclude ignored new dependencies, caches, and build outputs. Run tests for your changes. " +
      "Parent transcript, skills, extension tools, and MCP tools are not inherited. " +
      mergeInstructions(request) +
      (request.node.type === "decision" ? "Call decide exactly once, then answer. " : "") +
      "Return a nonempty natural-language result.";
    let toolRounds = 0, toolCalls = 0, decided = false;
    let contextTokens = 0;
    let contextSource: NodeProgress["contextSource"] = "estimate";
    const reports: TokenUsage[] = [];
    const output: string[] = [];
    const progress = (phase: NodeProgress["phase"]) => {
      try { options.onProgress?.({ nodeId: request.node.id, executionId: request.execution.executionId!, contextTokens, ...(contextWindow === undefined ? {} : { contextWindow }), contextSource, toolCalls, toolRounds, phase }); }
      catch { /* Observers cannot fail a worker. */ }
    };
    while (true) {
      request.signal.throwIfAborted();
      const budgets = [
        ...(options.maxToolRounds === undefined ? [] : [`Tool round budget: ${toolRounds}/${options.maxToolRounds} used.`]),
        ...(options.maxToolCalls === undefined ? [] : [`Tool call budget: ${toolCalls}/${options.maxToolCalls} used; rejected requests count.`]),
        "Reserve budget for decide or finish_merge. At zero remaining, return your final answer without further tools.",
      ];
      const activeTools = tools.filter(tool => !decided || tool.name !== "decide");
      const prompt = system + formatBudgetReminder(request, budgets);
      contextTokens = Math.ceil(JSON.stringify({ messages, system: prompt, tools: activeTools }).length / 4);
      contextSource = "estimate";
      progress("model");
      const assembler = new BlockAssembler();
      let finished = false;
      try {
        for await (const chunk of llm.stream({ provider, model, messages, system: prompt, tools: activeTools, signal: request.signal })) {
          request.signal.throwIfAborted();
          assembler.push(chunk);
          if (chunk.type === "finish") finished = true;
        }
      } finally {
        if (assembler.usage) {
          const usage = structuredClone(assembler.usage);
          reports.push(usage);
          options.onUsage?.(usage);
          contextTokens = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
          contextSource = "reported";
          progress("model");
        }
      }
      request.signal.throwIfAborted();
      const finish = assembler.finish;
      if (!finished) throw new Error("DSH model stream ended without a finish event");
      if (finish.kind !== "stop" && finish.kind !== "tool-calls")
        throw new Error("failure" in finish ? finish.failure.message : `DSH model ended with ${finish.kind}`);
      const response = assembler.message({ provider, model, ...(assembler.replayState ? { replayState: assembler.replayState } : {}) });
      output.push(...response.content.flatMap(block => block.type === "text" ? [block.text] : []));
      const calls = response.content.filter(block => block.type === "tool-call");
      if (!calls.length) {
        if (finish.kind === "tool-calls") throw new Error("DSH requested tool use without tool calls");
        break;
      }
      if (finish.kind !== "tool-calls") throw new Error("DSH returned tool calls with an invalid finish reason");
      toolRounds++;
      toolCalls += calls.length;
      progress("tool");
      if (toolRounds > (options.maxToolRounds ?? Infinity) || toolCalls > (options.maxToolCalls ?? Infinity))
        throw new Error("Braid node exceeded its tool budget");
      messages.push(response);
      for (const call of calls) {
        request.signal.throwIfAborted();
        let text: string, isError = false;
        try {
          const args: unknown = JSON.parse(call.arguments);
          if (call.name === "decide" && request.decide) {
            if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length !== 1 || !("choice" in args) || typeof args.choice !== "string")
              throw new Error("decide requires exactly one string argument: choice");
            request.decide(args.choice);
            decided = true;
            text = JSON.stringify({ choice: args.choice });
          } else if (call.name === "git" && request.git) {
            const parsed = parseGitToolArguments(args, integrating);
            const result = await request.git(parsed.args, parsed.input);
            text = JSON.stringify(result); isError = result.exitCode !== 0;
          } else if (call.name === "finish_merge" && request.merge) {
            await request.merge.finish(parseFinishMergeArguments(args, request.merge.sources.map(source => source.executionId!)));
            text = "Merge dispositions recorded. Return your final answer.";
          } else {
            const tool = files.find(tool => tool.name === call.name);
            if (!tool) throw new Error(`Unavailable tool '${call.name}'. Available: ${activeTools.map(tool => tool.name).join(", ")}`);
            const invoke = () => tool.execute(args);
            text = tool.writes && request.withWorkspaceWrite ? await request.withWorkspaceWrite(invoke) : await invoke();
          }
        } catch (error) {
          request.signal.throwIfAborted();
          // Invalid or duplicate decisions are terminal, matching core's exactly-once contract.
          if (call.name === "decide" && request.decide) throw error;
          isError = true;
          text = error instanceof Error ? error.message : String(error);
        }
        messages.push(createToolResultMessage({ callId: call.id, content: [{ type: "text", text }], isError }));
      }
    }
    const text = output.filter(part => part.trim()).join("\n\n");
    if (!text.trim()) throw new Error("DSH model returned no textual output");
    const usage = sumUsage(reports);
    return { output: text, model: route, usage: {
      inputTokens: usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0), outputTokens: usage.outputTokens,
    } };
  };
}

export function sumUsage(reports: readonly TokenUsage[]): TokenUsage {
  const total: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  for (const report of reports) for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens"] as const)
    if (report[key] !== undefined) total[key] = (total[key] ?? 0) + report[key];
  total.totalTokens = total.inputTokens + total.outputTokens + (total.cacheReadTokens ?? 0) + (total.cacheWriteTokens ?? 0);
  return total;
}
