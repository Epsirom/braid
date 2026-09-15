import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringEnum, Type, type Usage } from "@earendil-works/pi-ai";
import {
  defineTool,
  truncateHead,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  braid,
  type BraidInput,
  type BraidResult,
  type ExecutionEvent,
} from "../../dist/index.js";
import { createPiRunner, sumPiUsage } from "./runner.js";
import { registerBraidCommand } from "./command.js";
import {
  applyEvent,
  applyProgress,
  createLiveState,
  renderGraphCall,
  renderGraphResult,
  type BraidLiveState,
} from "./display.js";

const text = () => Type.String({ minLength: 1 });
const timeout = () =>
  Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 2_147_483_647 }));

const braidParameters = Type.Object(
  {
    goal: text(),
    // A flat object avoids provider-specific discriminated-union schema problems.
    nodes: Type.Array(
      Type.Object(
        {
          type: StringEnum(["execute", "decision"]),
          id: text(),
          prompt: text(),
          model: Type.Optional(
            Type.String({
              description:
                "Exact provider/modelId; default is the current Pi model",
            }),
          ),
          choices: Type.Optional(
            Type.Array(text(), {
              minItems: 1,
              description:
                "Required on decision nodes; forbidden on execute nodes",
            }),
          ),
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
    edges: Type.Array(
      Type.Object(
        {
          from: text(),
          to: text(),
          choice: Type.Optional(text()),
        },
        { additionalProperties: false },
      ),
    ),
    options: Type.Optional(
      Type.Object(
        {
          maxConcurrency: Type.Optional(Type.Integer({ minimum: 1 })),
          nodeTimeoutMs: timeout(),
          graphTimeoutMs: timeout(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

type BraidToolDetails =
  | (BraidResult & {
      fullOutputPath?: string;
      progress?: Record<string, import("./runner.js").PiNodeProgress>;
    })
  | BraidLiveState
  | undefined;

const BRAID_USAGE_GUIDANCE = [
  "Braid is a proactive execution primitive, not only a user-requested command.",
  "Selection rule: for a code review, bug investigation, design comparison, test-planning request, or change spanning multiple files, call braid FIRST when two or more concerns can be analyzed independently. Do this without waiting for the user to say Braid; do not read everything in the parent and then decide whether to delegate.",
  "Braid nodes can inspect the current project with read-only read, grep, find, and ls tools. Use those capabilities for repository-aware analysis. Nodes cannot edit files, write files, run shell commands, or run tests.",
  "When Braid fits, construct and submit the complete DAG in one call: use parallel execute nodes for independent concerns and a final execute node to synthesize their outputs. Then use the terminal outputs in your answer.",
  "Do not use braid for a simple one-step answer, a trivial direct edit, shell work, or when decomposition adds no value. Apply edits, run tests, and execute commands in the parent agent after Braid analysis.",
].join("\n");

export const braidTool = defineTool<typeof braidParameters, BraidToolDetails>({
  name: "braid",
  label: "Braid",
  description:
    "Use this tool FIRST for nontrivial engineering work: code reviews, bug investigations, design comparisons, test planning, and changes spanning multiple files. " +
    "It runs a complete DAG of isolated LLM invocations with parallel branches and joins; the user does not need to mention Braid. " +
    "Only execute and decision nodes exist. Decision nodes must declare choices and call decide; matching choice edges activate together. " +
    "Unlabelled edges are unconditional. Joins wait for all possible predecessor paths to resolve. " +
    "Nodes see only the goal, their prompt, labelled direct-predecessor outputs, and read-only read/grep/find/ls tools: " +
    "no parent history, writes, shell, tests, or recursive Braid calls. " +
    "Do not use it for a simple one-step answer or trivial direct edit. The parent applies edits and runs tests after analysis. " +
    "The tool displays graph construction, handoffs, failures, and active nodes live. " +
    "Read result.status: failed graphs can still return successful terminal outputs.",
  promptSnippet:
    "Use FIRST for nontrivial code review/debug/design work; parallelize independent analysis and synthesize",
  promptGuidelines: [
    "Call braid before direct repository inspection when a code task has two or more separable review, debugging, design, or test-planning concerns; the Braid nodes can inspect the checkout read-only.",
    "Use parallel execute nodes for independent concerns and a final synthesis node. The user does not need to mention Braid or design the graph.",
    "Do not use braid for simple one-step answers or trivial direct edits. Keep writes, shell commands, and test execution in the parent after Braid analysis.",
    "Braid nodes have read, grep, find, and ls plus decide on decision nodes; they cannot edit files, write files, run shell commands, run tests, or call recursive Braid.",
  ],
  parameters: braidParameters,
  renderCall(args, theme) {
    return renderGraphCall(args, theme);
  },
  renderResult(result, options, theme) {
    const details = result.details as BraidToolDetails;
    const fallback = result.content
      .filter(
        (item): item is { type: "text"; text: string } => item.type === "text",
      )
      .map((item) => item.text)
      .join("\n");
    return renderGraphResult(
      details,
      options.expanded,
      options.isPartial,
      theme,
      fallback,
      false,
    );
  },
  async execute(_toolCallId, params, signal, onUpdate, ctx) {
    const reports: Usage[] = [];
    const defaultModel = ctx.model
      ? `${ctx.model.provider}/${ctx.model.id}`
      : undefined;
    const live = createLiveState();
    const liveStarted = performance.now();
    let liveActive = true;
    const publish = (event?: ExecutionEvent): void => {
      if (!liveActive) return;
      live.latencyMs = performance.now() - liveStarted;
      live.observedAt = Date.now();
      const active = Object.values(live.nodes)
        .filter((node) => node.status === "running")
        .map((node) => node.id);
      try {
        onUpdate?.({
          content: [
            {
              type: "text",
              text: `Braid: ${event?.type ?? "starting"}${active.length ? ` · active: ${active.join(", ")}` : ""}`,
            },
          ],
          details: structuredClone(live),
        });
      } catch {
        // TUI updates are diagnostic; a closed/aborted tool row must not fail Braid.
      }
    };
    publish();
    const ticker = onUpdate ? setInterval(() => publish(), 1000) : undefined;

    const input = {
      goal: params.goal,
      nodes: params.nodes,
      edges: params.edges,
    } as BraidInput;
    let result: BraidResult;
    try {
      result = await braid(input, {
        ...params.options,
        runner: createPiRunner(ctx.modelRegistry, {
          onUsage: (usage) => reports.push(usage),
          onProgress: (progress) => {
            applyProgress(live, progress);
            publish();
          },
          cwd: ctx.cwd,
        }),
        ...(defaultModel ? { defaultModel } : {}),
        ...(signal ? { signal } : {}),
        onEvent: (event) => {
          applyEvent(live, event);
          publish(event);
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [
          { type: "text", text: `Braid validation failed: ${message}` },
        ],
        details: undefined,
        ...(reports.length > 0 ? { usage: sumPiUsage(reports) } : {}),
      };
    } finally {
      liveActive = false;
      if (ticker) clearInterval(ticker);
    }

    const full = JSON.stringify(result, null, 2);
    const preview = truncateHead(full);
    let output = preview.content;
    let fullOutputPath: string | undefined;
    if (preview.truncated) {
      const directory = await mkdtemp(join(tmpdir(), "braid-result-"));
      fullOutputPath = join(directory, "result.json");
      await writeFile(fullOutputPath, full, { mode: 0o600 });
      output += `\n\n[Braid result/log truncated at 50KB/2000 lines. Full result: ${fullOutputPath}]`;
    }
    const details = {
      ...result,
      ...(fullOutputPath ? { fullOutputPath } : {}),
      progress: live.progress,
    };
    onUpdate?.({
      content: [{ type: "text", text: `Braid: ${result.status}` }],
      details,
    });
    return {
      content: [{ type: "text", text: output }],
      details,
      ...(reports.length > 0 ? { usage: sumPiUsage(reports) } : {}),
    };
  },
});

export default function braidExtension(pi: ExtensionAPI) {
  registerBraidCommand(pi);
  pi.registerTool(braidTool);
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n## Braid execution policy\n${BRAID_USAGE_GUIDANCE}\n\nFor the current user request, make this delegation choice before using read, grep, find, edit, write, or bash.`,
  }));
}
