import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  truncateHead,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { BraidInput } from "@chrok/braid";
import { Text } from "@earendil-works/pi-tui";
import { BraidJobs, type JobSnapshot } from "./jobs.js";
import { registerBraidCommand } from "./command.js";
import { renderGraphCall, renderGraphResult } from "./display.js";

const text = () => Type.String({ minLength: 1 });
const prompt = () => Type.Union([
  text(),
  Type.Object({
    template: text(),
    variables: Type.Record(Type.String(), Type.String()),
  }, { additionalProperties: false }),
]);
const timeout = () =>
  Type.Optional(
    Type.Number({
      exclusiveMinimum: 0,
      maximum: 2_147_483_647,
      description: "Timeout in milliseconds; omit for no time limit",
    }),
  );
const toolBudget = (unit: string) =>
  Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
      description: `Maximum tool ${unit} per node, including decide and rejected requests; omit for no limit`,
    }),
  );

const braidParameters = Type.Object(
  {
    goal: text(),
    promptTemplates: Type.Optional(Type.Record(Type.String(), text(), {
      description: "Reusable prompts for this graph. Use {{name}} placeholders; variable names use letters, digits, and underscores and cannot start with a digit. Nodes reference a template and supply exactly its string variables. Rendering happens before any node starts.",
    })),
    // A flat object avoids provider-specific discriminated-union schema problems.
    nodes: Type.Array(
      Type.Object(
        {
          type: StringEnum(["execute", "decision", "merge"]),
          id: text(),
          prompt: Type.Optional(prompt()),
          model: Type.Optional(
            Type.String({
              description:
                "Exact provider/modelId; default is the current Pi model",
            }),
          ),
          workspace: Type.Optional(StringEnum(["read-only", "worktree"], {
            description: "Execute/decision only; forbidden on merge nodes. Use read-only for analysis, review, routing, and synthesis: reads the live source directory with Git inspection, no writes or worktree. Omit or use worktree for implementation or a fixed snapshot in Git. Outside Git, both modes are read-only.",
          })),
          choices: Type.Optional(
            Type.Array(text(), {
              minItems: 1,
              description:
                "Required on decision nodes; forbidden on execute and merge nodes",
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
          maxToolRounds: toolBudget("rounds"),
          maxToolCalls: toolBudget("calls"),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

const BRAID_FILESYSTEM_GUIDANCE =
  "Set workspace=read-only on execute/decision nodes for analysis, review, routing, and synthesis that do not need file edits. These nodes read the live source directory with read, ls, and Git inspection in Git repositories; they get no write/edit tools, snapshot, worktree, or merge source. Reads can observe parent edits or concurrent merges. " +
  "Omit workspace or use workspace=worktree for implementation or when a fixed snapshot is needed. In a Git repository, these execute and decision nodes get individual writable worktrees with read, ls, write, edit, and Git inspection. Search tools grep/find are exposed only when their local rg/fd dependencies are available. " +
  "Worktrees include tracked changes and non-ignored untracked files. Merge nodes operate in the source checkout and decide whether to merge, cherry-pick, apply, or discard predecessor changes; core never makes that choice. " +
  "Do not set workspace on merge nodes. Use a read-only execute node to summarize findings; use a merge node only to integrate file changes. Merge agents must call finish_merge for every source; core checkpoints changes and removes processed worktrees. Core releases unchanged worktrees and appends a final merge agent only for remaining changed worktrees; explicit merge nodes always run. Failed predecessors pass their errors and partial work along unconditional edges. " +
  "Outside Git, nodes have read and ls, plus grep/find when their local dependencies are available. Shell commands and tests remain unavailable in all nodes. " +
  "Inspect braid_status for integration outcomes and recovery checkpoint refs, then run tests in the parent. Avoid concurrent parent edits while a merge agent owns the source checkout.";

const BRAID_USAGE_GUIDANCE = [
  "Braid is a proactive execution primitive, not only a user-requested command.",
  "Selection rule: for a code review, bug investigation, design comparison, test-planning request, or change spanning multiple files, call braid FIRST when two or more concerns can be handled independently. Nodes can analyze the project and implement changes in isolated Git worktrees. Do this without waiting for the user to say Braid; do not read everything in the parent and then decide whether to delegate.",
  BRAID_FILESYSTEM_GUIDANCE,
  "For repeated instructions, define promptTemplates once and use prompt={template: name, variables: {name: value}} on nodes. Values are strings inserted literally into {{name}} placeholders; plain-string prompts remain supported.",
  "When Braid fits, construct and submit the complete DAG in one call: use parallel execute nodes for independent analysis or implementation, execute nodes to synthesize findings, and merge nodes to integrate file changes. The tool returns a jobId immediately. Continue independent work or finish your turn while it runs; do not poll repeatedly. A completion reminder will resume you. Use braid_status with the jobId to retrieve terminal outputs before relying on them.",
  "Do not use braid for a simple one-step answer, a trivial direct edit, shell work, or when decomposition adds no value. The parent reviews results, runs tests, and executes shell commands after Braid completes.",
].join("\n");

export function createBraidTools(jobs: BraidJobs) {
  const braidTool = defineTool<typeof braidParameters, JobSnapshot | undefined>(
    {
      name: "braid",
      label: "Braid",
      description:
        "Use this tool FIRST for nontrivial engineering work: code reviews, bug investigations, design comparisons, test planning, and changes spanning multiple files. " +
        "It starts a background job and immediately returns jobId for a complete DAG of isolated LLM invocations with parallel branches and joins; the user does not need to mention Braid. " +
        "Use execute, decision, or merge nodes. Decision nodes must declare choices and call decide; matching choice edges activate together. Merge nodes accept multiple predecessors and an optional prompt. " +
        "For repeated prompts, define promptTemplates and set node prompt to {template: name, variables: {name: value}}; core renders {{name}} placeholders using explicit string variables before execution. " +
        "Unlabelled edges are unconditional. Joins wait for all possible predecessor paths to resolve. " +
        "Nodes see only the goal, their prompt, labelled direct-predecessor outputs, and their filesystem capabilities: " +
        "no parent history, shell, tests, or recursive Braid calls. " +
        BRAID_FILESYSTEM_GUIDANCE + " " +
        "Do not use it for a simple one-step answer or trivial direct edit. " +
        "Use braid_status(jobId) for progress and results, or braid_cancel(jobId) to stop it. A completion reminder resumes the agent if idle; do independent work or end your turn instead of polling. Humans can open /braid for the live flow panel. " +
        "Read result.status: failed graphs can still return successful terminal outputs.",
      promptSnippet:
        "Use FIRST for nontrivial code review/debug/design/implementation work; set workspace=read-only for analysis/synthesis, use worktrees for edits and merge nodes for integration",
      promptGuidelines: [
        "Call braid before direct repository inspection when a code task has two or more separable review, debugging, design, test-planning, or implementation concerns; the Braid nodes can inspect the project and edit isolated Git worktrees.",
        "Use parallel execute nodes for independent analysis or implementation, execute nodes to synthesize findings, and merge nodes to integrate file changes. The user does not need to mention Braid or design the graph.",
        "Do not use braid for simple one-step answers or trivial direct edits. Keep shell commands and test execution in the parent; use merge nodes for integration.",
        BRAID_FILESYSTEM_GUIDANCE,
        "Decision nodes additionally receive decide. Nodes cannot call recursive Braid.",
        "Tool and time budgets are unlimited by default. Set maxToolRounds, maxToolCalls, nodeTimeoutMs, or graphTimeoutMs in options to impose hard limits; nodes receive system reminders of their remaining budgets before each model call.",
      ],
      parameters: braidParameters,
      renderCall(args, theme) {
        return renderGraphCall(args, theme);
      },
      renderResult(result, _options, theme) {
        const job = result.details;
        return new Text(
          theme.fg(
            job ? "accent" : "error",
            job
              ? `Braid background job ${job.jobId} · ${job.status} · /braid to view`
              : result.content
                  .filter((item) => item.type === "text")
                  .map((item) => item.text)
                  .join("\n"),
          ),
          0,
          0,
        );
      },
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        signal?.throwIfAborted();
        try {
          const job = jobs.start(
            {
              goal: params.goal,
              nodes: params.nodes,
              edges: params.edges,
              ...(params.promptTemplates !== undefined ? { promptTemplates: params.promptTemplates } : {}),
            } as BraidInput,
            params.options ?? {},
            ctx,
          );
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  jobId: job.handle,
                  canonicalJobId: job.jobId,
                  status: job.status,
                  message:
                    "Running in background. Use braid_status to retrieve progress/results. A completion reminder will resume you; do not poll repeatedly.",
                }),
              },
            ],
            details: job,
          };
        } catch (error) {
          throw new Error(
            `Braid submission failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    },
  );

  const statusParameters = Type.Object(
    { jobId: Type.Optional(text()) },
    { additionalProperties: false },
  );
  const statusTool = defineTool<
    typeof statusParameters,
    JobSnapshot | undefined
  >({
    name: "braid_status",
    label: "Braid status",
    description:
      "Retrieve a background Braid job's status, node progress, and final results by exact session handle (e.g. job-1) or UUID in jobId. Prefer the short handle from submission/reminders. Omit jobId to list jobs in this session. Completion reminders arrive automatically; avoid repeated polling.",
    parameters: statusParameters,
    renderResult(result, options, theme) {
      const job = result.details;
      const fallback = result.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      if (!job) return new Text(fallback, 0, 0);
      if (job.error)
        return new Text(
          theme.fg("error", `Braid ${job.status}: ${job.error}`),
          0,
          0,
        );
      return renderGraphResult(
        {
          ...(job.result ?? job.live),
          progress: job.live.progress,
          ...(job.workspaces ? { workspaces: job.workspaces } : {}),
          ...(job.fullOutputPath ? { fullOutputPath: job.fullOutputPath } : {}),
        },
        options.expanded,
        options.isPartial,
        theme,
        fallback,
      );
    },
    async execute(_id, params) {
      if (!params.jobId)
        return {
          content: [{ type: "text", text: JSON.stringify(jobs.list()) }],
          details: undefined,
        };
      const job = jobs.get(params.jobId);
      if (!job) throw jobs.unknownJob(params.jobId);
      const preview = truncateHead(JSON.stringify(job, null, 2));
      const suffix = preview.truncated
        ? `\n[Preview truncated. ${job.fullOutputPath ? `Full result/log: ${job.fullOutputPath}` : "Full results will be available when the job finishes."}]`
        : "";
      const usage = jobs.claimUsage(job.jobId);
      return {
        content: [{ type: "text", text: preview.content + suffix }],
        details: job,
        ...(usage ? { usage } : {}),
      };
    },
  });

  const cancelParameters = Type.Object(
    { jobId: text() },
    { additionalProperties: false },
  );
  const cancelTool = defineTool<typeof cancelParameters, undefined>({
    name: "braid_cancel",
    label: "Cancel Braid",
    description:
      "Cancel a background Braid job by jobId. Stopping the foreground response does not cancel background jobs.",
    parameters: cancelParameters,
    async execute(_id, params) {
      const cancelled = jobs.cancel(params.jobId);
      return {
        content: [
          {
            type: "text",
            text: cancelled
              ? "Cancellation requested."
              : "Job has already finished.",
          },
        ],
        details: undefined,
      };
    },
  });
  return { braidTool, statusTool, cancelTool };
}

export default function braidExtension(pi: ExtensionAPI) {
  const pending = new Map<string, JobSnapshot["status"]>();
  const remind = (jobId: string, status: JobSnapshot["status"]): void => {
    const handle = jobs.get(jobId)?.handle ?? jobId;
    pi.sendMessage(
      {
        customType: "braid-completed",
        display: true,
        content: `[system-reminder] Braid job ${handle} finished with status ${status}. Retrieve its results with braid_status({"jobId":"${handle}"}) and continue the original task. Failed or cancelled jobs may contain successful partial outputs. [/system-reminder]`,
        details: { jobId, handle, status },
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  };
  const jobs = new BraidJobs((job) => {
    pending.set(job.jobId, job.status);
    remind(job.jobId, job.status);
  });
  // Foreground cancellation can discard queued follow-ups. Retry only reminders
  // that never entered context, once Pi has settled and emptied its queues.
  pi.on("message_start", (event) => {
    const message = event.message;
    if (message.role === "custom" && message.customType === "braid-completed") {
      const details = message.details as { jobId?: string } | undefined;
      if (details?.jobId) pending.delete(details.jobId);
    }
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (ctx.isIdle() && !ctx.hasPendingMessages()) {
      for (const [jobId, status] of pending) remind(jobId, status);
    }
  });
  const { braidTool, statusTool, cancelTool } = createBraidTools(jobs);
  registerBraidCommand(pi, jobs);
  pi.registerTool(braidTool);
  pi.registerTool(statusTool);
  pi.registerTool(cancelTool);
  pi.on("session_shutdown", () => {
    pending.clear();
    jobs.dispose();
  });
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n## Braid execution policy\n${BRAID_USAGE_GUIDANCE}\n\nFor the current user request, make this delegation choice before using read, grep, find, edit, write, or bash. Completion reminders refer to existing jobs: retrieve their results instead of submitting the same graph again.`,
  }));
}
