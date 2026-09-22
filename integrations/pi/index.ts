import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  truncateHead,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { BraidInput } from "../../dist/index.js";
import { Text } from "@earendil-works/pi-tui";
import { BraidJobs, type JobSnapshot } from "./jobs.js";
import { registerBraidCommand } from "./command.js";
import { renderGraphCall, renderGraphResult } from "./display.js";

const text = () => Type.String({ minLength: 1 });
const timeout = () =>
  Type.Optional(
    Type.Number({
      exclusiveMinimum: 0,
      maximum: 2_147_483_647,
      description: "Timeout in milliseconds; omit for no time limit",
    }),
  );

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

const BRAID_USAGE_GUIDANCE = [
  "Braid is a proactive execution primitive, not only a user-requested command.",
  "Selection rule: for a code review, bug investigation, design comparison, test-planning request, or change spanning multiple files, call braid FIRST when two or more concerns can be analyzed independently. Do this without waiting for the user to say Braid; do not read everything in the parent and then decide whether to delegate.",
  "Braid nodes can inspect the current project with read-only read, grep, find, and ls tools. Use those capabilities for repository-aware analysis. Nodes cannot edit files, write files, run shell commands, or run tests.",
  "When Braid fits, construct and submit the complete DAG in one call: use parallel execute nodes for independent concerns and a final execute node to synthesize their outputs. The tool returns a jobId immediately. Continue independent work or finish your turn while it runs; do not poll repeatedly. A completion reminder will resume you. Use braid_status with the jobId to retrieve terminal outputs before relying on them.",
  "Do not use braid for a simple one-step answer, a trivial direct edit, shell work, or when decomposition adds no value. Apply edits, run tests, and execute commands in the parent agent after Braid analysis.",
].join("\n");

export function createBraidTools(jobs: BraidJobs) {
  const braidTool = defineTool<typeof braidParameters, JobSnapshot | undefined>(
    {
      name: "braid",
      label: "Braid",
      description:
        "Use this tool FIRST for nontrivial engineering work: code reviews, bug investigations, design comparisons, test planning, and changes spanning multiple files. " +
        "It starts a background job and immediately returns jobId for a complete DAG of isolated LLM invocations with parallel branches and joins; the user does not need to mention Braid. " +
        "Only execute and decision nodes exist. Decision nodes must declare choices and call decide; matching choice edges activate together. " +
        "Unlabelled edges are unconditional. Joins wait for all possible predecessor paths to resolve. " +
        "Nodes see only the goal, their prompt, labelled direct-predecessor outputs, and read-only read/grep/find/ls tools: " +
        "no parent history, writes, shell, tests, or recursive Braid calls. " +
        "Do not use it for a simple one-step answer or trivial direct edit. The parent applies edits and runs tests after analysis. " +
        "Use braid_status(jobId) for progress and results, or braid_cancel(jobId) to stop it. A completion reminder resumes the agent if idle; do independent work or end your turn instead of polling. Humans can open /braid for the live flow panel. " +
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
            } as BraidInput,
            params.options ?? {},
            ctx,
          );
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  jobId: job.jobId,
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
      "Retrieve a background Braid job's status, node progress, and final results by jobId. Omit jobId to list jobs in this session. Completion reminders arrive automatically; avoid repeated polling.",
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
      if (!job)
        throw new Error(
          `Unknown Braid job: ${params.jobId}. Jobs are available only in the current session until reload or exit.`,
        );
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
    pi.sendMessage(
      {
        customType: "braid-completed",
        display: true,
        content: `[system-reminder] Braid job ${jobId} finished with status ${status}. Retrieve its results with braid_status({"jobId":"${jobId}"}) and continue the original task. Failed or cancelled jobs may contain successful partial outputs. [/system-reminder]`,
        details: { jobId, status },
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
