import type {
  BraidInput, BraidInputNode, BraidSnapshot, ExecutionActivity, ExecutionError, ExecutionHold, ExecutionSuspension, NodeExecution, NodeResult, NodeWorkspace,
} from "@chrok/braid";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TokenUsage } from "@deepseek-ai/dsh-llm";
import type { ControlNotice, JobSnapshot, TimeoutPause } from "./jobs.js";

/** Model-facing text documents for the parent Braid tools. */

const iso = (ms: number) => new Date(ms).toISOString();
const duration = (ms: number) => ms < 1000 ? `${Math.max(0, Math.round(ms))}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
const failure = (error: ExecutionError) => `${error.code}: ${error.message}`;
const ids = (values: readonly string[] | undefined) => values?.length ? values.join(", ") : "none";
const GOAL_CHARS = 2000;
const clip = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit)}… [${text.length} chars]` : text;
const indent = (text: string) => text.split("\n").map(line => line ? `  ${line}` : line).join("\n");

export function formatUsage(usage: TokenUsage | undefined): string | undefined {
  if (!usage) return undefined;
  const parts = [`input ${usage.inputTokens}`, `output ${usage.outputTokens}`];
  if (usage.cacheReadTokens) parts.push(`cache read ${usage.cacheReadTokens}`);
  if (usage.cacheWriteTokens) parts.push(`cache write ${usage.cacheWriteTokens}`);
  if (usage.reasoningTokens) parts.push(`reasoning ${usage.reasoningTokens}`);
  return `${parts.join(", ")}${usage.totalTokens !== undefined ? ` (${usage.totalTokens} tokens)` : ""}`;
}

/** Bounds the model-facing text; the complete document stays readable in a private file. */
export const TEXT_LIMIT_BYTES = 50_000;
export async function boundedText(text: string, name: string): Promise<{ text: string; path?: string }> {
  if (Buffer.byteLength(text) <= TEXT_LIMIT_BYTES) return { text };
  const directory = await mkdtemp(join(tmpdir(), "braid-dsh-status-"));
  const path = join(directory, name);
  await writeFile(path, text, { mode: 0o600 });
  // Keep whole leading lines, as a truncated head preview.
  let preview = Buffer.from(text).subarray(0, TEXT_LIMIT_BYTES).toString("utf8");
  const end = preview.lastIndexOf("\n");
  if (end > 0) preview = preview.slice(0, end);
  return { text: `${preview}\n[Truncated. Full text: ${path}]`, path };
}

function nodeLine(node: BraidInputNode): string {
  const settings: string[] = [node.type];
  if ("workspace" in node && node.workspace) settings.push(`workspace=${node.workspace}`);
  if ("choices" in node) settings.push(`choices=${node.choices.join("|")}`);
  if (node.model) settings.push(`model=${node.model}`);
  if (typeof node.prompt === "object") settings.push(`template=${node.prompt.template}`);
  for (const flag of ["pauseAfter", "notifyOnCompletion", "requireSuccess"] as const) if (node[flag]) settings.push(flag);
  return `- ${node.id}: ${settings.join(", ")}`;
}

/** Accepted definitions without prompts, which the caller already sent. */
export function formatGraph(graph: Pick<BraidInput, "nodes" | "edges" | "loops">): string {
  const lines = ["Nodes:", ...graph.nodes.map(nodeLine), "Edges:"];
  lines.push(...graph.edges.length ? graph.edges.map(edge => {
    const labels = [edge.choice && `choice=${edge.choice}`, edge.feedback && `feedback=${edge.feedback}`, edge.executionId && `execution=${edge.executionId}`].filter(Boolean);
    return `- ${edge.from} -> ${edge.to}${labels.length ? ` [${labels.join(", ")}]` : ""}`;
  }) : ["- none"]);
  if (graph.loops?.length) lines.push("Loops:", ...graph.loops.map(loop => `- ${loop.id}: entry ${loop.entry}, at most ${loop.maxIterations} iterations`));
  return lines.join("\n");
}

function workspaceLine(workspace: NodeWorkspace): string {
  const parts = [`${workspace.mode} ${workspace.workingDirectory}`, workspace.state];
  for (const root of [workspace.worktreeRoot, workspace.sourceRoot]) if (root && root !== workspace.workingDirectory) parts.push(`root ${root}`);
  if (workspace.checkpointRef) parts.push(`checkpoint ${workspace.checkpointRef}`);
  if (workspace.backupRef) parts.push(`backup ${workspace.backupRef}`);
  if (workspace.reason) parts.push(workspace.reason);
  for (const item of workspace.dispositions ?? []) parts.push(`${item.executionId} ${item.disposition}: ${item.reason}`);
  return parts.join(" · ");
}

function executionLine(execution: NodeResult & Partial<Pick<NodeExecution, "iteration" | "node">>): string {
  const parts = [execution.executionId ?? "(no execution)", `node ${execution.id}`];
  if (execution.iteration) parts.push(`iteration ${execution.iteration}`);
  parts.push(execution.skipReason ? `${execution.status} (${execution.skipReason})` : execution.status);
  if (execution.suspension) parts.push(`${execution.suspension.state}, ${pausedBy(execution.suspension)}`);
  if (pendingHold(execution)) parts.push(`holds when finished, set by ${holdSource(execution.holdAfter!)}`);
  if (execution.latencyMs !== undefined) parts.push(duration(execution.latencyMs));
  if (execution.decision) parts.push(`decision ${execution.decision}`);
  if (execution.error) parts.push(failure(execution.error));
  return `- ${parts.join(" · ")}`;
}

export function formatJobList(jobs: readonly Pick<JobSnapshot, "jobId" | "handle" | "goal" | "status" | "createdAt">[]): string {
  if (!jobs.length) return "No Braid jobs in this session.";
  return [`${jobs.length} Braid job${jobs.length === 1 ? "" : "s"} in this session, newest first:`,
    ...jobs.map(job => `- ${job.handle} · ${job.status} · started ${iso(job.createdAt)} · id ${job.jobId}\n  Goal: ${job.goal}`)].join("\n");
}

type Control = Pick<BraidSnapshot, "status" | "revision" | "pausedExecutionIds"> & Partial<Pick<BraidSnapshot, "suspendedExecutionIds" | "pause">>;

/** Held (pauseAfter) and suspended executions are resumed the same way; a job pause has its own resume. */
function control(execution: Control): string {
  const parts = [`Graph ${execution.status}`, `revision ${execution.revision}`, `paused executions: ${ids(execution.pausedExecutionIds)}`];
  if (execution.suspendedExecutionIds?.length) parts.push(`suspended executions: ${ids(execution.suspendedExecutionIds)}`);
  if (execution.pause) parts.push(`job paused by ${execution.pause.source} at ${iso(execution.pause.pausedAt)}`);
  return parts.join(" · ");
}

/** Paused-by-user work is the user's call: say so wherever the parent sees it. */
const USER_PAUSE_NOTE = "The user paused this; do not resume it unless the user asks.";
const USER_HOLD_NOTE = "The user set this hold; do not remove it or release the result unless the user asks.";

/** A hold that applies once a still-unsettled execution finishes. Settled holds are paused executions. */
function pendingHold(execution: NodeResult): boolean {
  return Boolean(execution.holdAfter) && (execution.status === "running" || execution.status === "runnable");
}
const holdSource = (hold: ExecutionHold) => hold.source === "definition" ? "pauseAfter" : hold.source;

/** A node timeout pause waits for the parent's decision. */
const TIMEOUT_PAUSE_NOTE = "Its node timeout ran out. Resume it with braid_resume (optionally with nodeTimeoutMs; the default is the job's nodeTimeoutMs again), or fail only this execution with braid_cancel and executionIds. Its successors wait until then.";

/** Who paused an execution; a node timeout pause also says how long it ran. */
export function pausedBy(suspension: ExecutionSuspension): string {
  if (suspension.source !== "node_timeout") return `paused by ${suspension.source}`;
  return suspension.timeout ? `paused by node timeout after ${duration(suspension.timeout.activeMs)} (budget ${duration(suspension.timeout.nodeTimeoutMs)})` : "paused by node timeout";
}

/** One sentence for a pause, resume, hold change, or cancellation the parent did not make. */
export function formatControlNotice(notice: ControlNotice): string {
  const who = notice.source === "user" ? "The user" : `A ${notice.source} control`;
  const target = notice.executions
    ? notice.executions.map(execution => `node ${JSON.stringify(execution.nodeId)} execution ${execution.executionId}`).join(", ")
    : "the whole job";
  const lookup = JSON.stringify({ jobId: notice.handle, ...(notice.executions?.length === 1 ? { executionId: notice.executions[0]!.executionId } : {}) });
  switch (notice.action) {
    case "paused": return `${who} paused ${target} of Braid job ${notice.handle}. Paused work keeps its conversation and workspace. Do not resume it unless the user asks; check the current state with braid_status(${lookup}).`;
    case "resumed": return `${who} resumed ${target} of Braid job ${notice.handle}; it continues where it stopped.`;
    case "held": return `${who} set ${target} of Braid job ${notice.handle} to hold its result once it finishes; downstream work waits for a resume. Do not release it unless the user asks; check the current state with braid_status(${lookup}).`;
    case "unheld": return `${who} removed the hold on ${target} of Braid job ${notice.handle}; its result goes downstream when it finishes.`;
    case "cancelled": return `${who} cancelled ${target} of Braid job ${notice.handle}. It failed; its successors follow the usual failure rules. Check the current state with braid_status(${lookup}).`;
  }
}

/** The result of braid_pause or braid_resume with after=true. */
export function formatHold(job: JobSnapshot, executionIds: readonly string[], hold: boolean): string {
  const execution = job.execution;
  if (!hold) return [`Braid job ${job.handle}: hold removed for ${ids(executionIds)}; their results go downstream when they finish.`, control(execution)].join("\n");
  return [
    `Braid job ${job.handle}: ${ids(executionIds)} keep running and will be held when they finish; downstream work waits until you release them.`,
    control(execution),
    "Each one appears in paused executions once it finishes, and you get a pause reminder. Review it with braid_status, then release it with " +
      `braid_resume({"jobId":"${job.handle}","expectedRevision":<current>,"executionIds":[...]}), or atomically with braid_update resume. ` +
      `To remove the hold before it finishes, use braid_resume({"jobId":"${job.handle}","executionIds":[...],"after":true}).`,
  ].join("\n");
}

/** The result of braid_pause: what is pausing now and how to continue. */
export function formatPause(job: JobSnapshot, executionIds?: readonly string[]): string {
  const execution = job.execution;
  const pausing = Object.values(execution.executions).filter(item => item.suspension?.state === "pausing").map(item => item.executionId);
  return [
    executionIds ? `Braid job ${job.handle}: pause requested for ${ids(executionIds)}.` : `Braid job ${job.handle} paused: no new executions start, and running ones pause.`,
    control(execution),
    `Pausing (each stops before its next model request; a running tool finishes first): ${ids(pausing)}.`,
    "Suspended executions keep their conversation and workspace and release their concurrency slot. The node timeout stops while suspended; the graph timeout keeps running. " +
      (executionIds ? `Continue with braid_resume({"jobId":"${job.handle}","expectedRevision":${execution.revision},"executionIds":[...]}).`
        : `Continue with braid_resume({"jobId":"${job.handle}"}).`),
  ].join("\n");
}

/** The submission receipt. The caller already has the graph it submitted. */
export function formatReceipt(job: JobSnapshot, message: string): string {
  return [`Braid job ${job.handle} started (${job.status}).`, `ID: ${job.jobId}`, message].join("\n");
}

export function formatUpdate(job: JobSnapshot): string {
  return [`Braid job ${job.handle} updated to revision ${job.execution.revision}.`,
    `Paused executions: ${ids(job.execution.pausedExecutionIds)}`,
    ...job.execution.suspendedExecutionIds?.length ? [`Suspended executions: ${ids(job.execution.suspendedExecutionIds)}`] : [],
    "Current graph:", formatGraph(job.execution.graph)].join("\n");
}

export function formatResume(job: JobSnapshot): string {
  const execution = job.execution;
  return `Braid job ${job.handle} resumed at revision ${execution.revision}. Still paused: ${ids(execution.pausedExecutionIds)}. ` +
    `Still suspended: ${ids(execution.suspendedExecutionIds)}.${execution.pause ? ` The job itself is still paused by ${execution.pause.source}.` : ""}`;
}

export function formatActivity(activity: ExecutionActivity, now: number, jobId: string): string {
  const lines = [`Activity: ${activity.phase} for ${duration(now - activity.phaseStartedAt)}; last observed signal ${duration(now - activity.lastActivityAt)} ago (${activity.lastActivity}). Model requests ${activity.modelRequests}, tool calls ${activity.toolCalls}.`];
  const model = activity.model;
  if (model && model.completedAt === undefined) {
    const stream = model.firstStreamAt === undefined ? "no stream received yet"
      : `receiving ${model.receiving ?? "output"}${model.toolName ? ` for ${model.toolName}` : ""}, ${model.receivedChars} chars, last chunk ${duration(now - (model.lastStreamAt ?? model.firstStreamAt))} ago`;
    lines.push(`Model request ${model.round}: started ${duration(now - model.startedAt)} ago; ${stream}.`);
  }
  for (const tool of activity.tools) {
    lines.push(`Running tool ${tool.name} for ${duration(now - tool.startedAt)}: ${tool.arguments}`);
    if (tool.outputTail) lines.push(indent(`Output tail:\n${tool.outputTail}`));
  }
  for (const limitation of activity.limitations) lines.push(`Not observable: ${limitation}`);
  if (activity.entries.length) {
    lines.push("History:");
    for (const entry of activity.entries) {
      lines.push(`- #${entry.sequence} ${iso(entry.timestamp)} ${entry.kind}${entry.toolName ? ` ${entry.toolName}` : ""}${entry.isError ? " (error)" : ""}${entry.durationMs !== undefined ? ` ${duration(entry.durationMs)}` : ""}: ${entry.summary}`);
      if (entry.detail) lines.push(indent(entry.detail + (entry.detailLength ? `\n[preview of ${entry.detailLength} chars]` : "")));
    }
    const first = activity.entries[0]!.sequence;
    if (first > 1) lines.push(first - 1 > activity.droppedEntries
      ? `Earlier entries: braid_status({"jobId":"${jobId}","executionId":"${activity.executionId}","activityBefore":${first}})`
      : `${activity.droppedEntries} earlier entries are no longer retained.`);
  }
  return lines.join("\n");
}

export interface NodeStatus {
  job: JobSnapshot;
  node: NodeResult & Partial<Pick<NodeExecution, "iteration" | "node">>;
  activity?: ExecutionActivity;
  now: number;
}

/** A focused read: the current control state, then one execution in full. */
export function formatNodeStatus({ job, node, activity, now }: NodeStatus): string {
  const lines = [`Braid job ${job.handle} · ${job.status} · ${control(job.execution)}`,
    ...node.suspension ? [`Execution is ${node.suspension.state}, ${pausedBy(node.suspension)}${node.suspension.suspendedAt !== undefined ? ` since ${iso(node.suspension.suspendedAt)}` : ""}.${node.suspension.source === "user" ? ` ${USER_PAUSE_NOTE}` : node.suspension.source === "node_timeout" ? ` ${TIMEOUT_PAUSE_NOTE}` : ""}`] : [],
    ...pendingHold(node) ? [`Its result will be held when it finishes (set by ${holdSource(node.holdAfter!)}).${node.holdAfter!.source === "user" ? ` ${USER_HOLD_NOTE}` : ""}`] : [],
    `Execution ${node.executionId ?? "(none yet)"} · node ${node.id}${node.node ? ` (${node.node.type})` : ""}${node.iteration ? ` · iteration ${node.iteration}` : ""} · ${node.skipReason ? `${node.status} (${node.skipReason})` : node.status}`];
  const timing = [node.startedAt !== undefined && `started ${iso(node.startedAt)}`, node.latencyMs !== undefined && `took ${duration(node.latencyMs)}`,
    node.model && `model ${node.model}`, node.usage && `usage input ${node.usage.inputTokens}, output ${node.usage.outputTokens}`].filter(Boolean);
  if (timing.length) lines.push(timing.join(" · "));
  if (node.decision) lines.push(`Decision: ${node.decision}`);
  if (node.error) lines.push(`Error: ${failure(node.error)}`);
  if (node.workspace) lines.push(`Workspace: ${workspaceLine(node.workspace)}`);
  if (node.humanInputs?.length) lines.push("Human input delivered during this execution:", ...node.humanInputs.map(input => `- ${iso(input.timestamp)}: ${input.text}`));
  const output = `Output:\n${node.output ?? "(none)"}`;
  // While running, activity is the useful part; afterwards the output is.
  const running = activity && activity.finishedAt === undefined;
  const sections = [lines.join("\n"), ...running ? [formatActivity(activity, now, job.handle), output] : [output, ...activity ? [formatActivity(activity, now, job.handle)] : []]];
  return sections.join("\n\n");
}

/** The whole job: control state, every execution, then their outputs and the current definition. */
export function formatJobStatus(job: JobSnapshot, now: number): string {
  const state = job.result ?? job.execution;
  // Control fields lead: a long goal or output must not push them out of a truncated preview.
  const header = [`Braid job ${job.handle} · ${job.status}`, `ID: ${job.jobId}`, control(job.execution)];
  if (job.status === "running" && (job.execution.pause?.source === "user" ||
      Object.values(job.execution.executions).some(item => item.suspension?.source === "user" || item.holdAfter?.source === "user"))) header.push(USER_PAUSE_NOTE);
  const error = job.error ?? (job.result?.error ? failure(job.result.error) : job.execution.error ? failure(job.execution.error) : undefined);
  if (error) header.push(`Error: ${error}`);
  const usage = formatUsage(job.usage);
  if (usage) header.push(`Usage: ${usage}`);
  if (job.result) header.push(`Finished ${iso(job.result.metadata.finishedAt)} after ${duration(job.result.metadata.latencyMs)}`);
  else header.push(`Started ${iso(job.createdAt)}, ${duration(now - job.createdAt)} ago`);
  header.push(`Goal: ${clip(job.goal, GOAL_CHARS)}`);
  const sections = [header.join("\n")];
  const executions = Object.values(state.executions);
  if (executions.length) sections.push([`Executions (${executions.length}):`, ...executions.map(executionLine)].join("\n"));
  const pending = Object.values(state.nodes).filter(node => !node.executionId);
  if (pending.length) sections.push(["Nodes without executions:", ...pending.map(executionLine)].join("\n"));
  const terminal = new Set(job.result?.terminalExecutionIds ?? []);
  const outputs = executions.filter(execution => execution.output !== undefined);
  if (outputs.length) sections.push(["Outputs:", ...outputs.map(execution =>
    `## ${execution.id} · ${execution.executionId}${terminal.has(execution.executionId) ? " · terminal" : ""}${execution.decision ? ` · decision ${execution.decision}` : ""}\n${execution.output}`)].join("\n\n"));
  const workspaces = executions.filter(execution => execution.workspace);
  if (workspaces.length) sections.push(["Workspaces:", ...workspaces.map(execution => `- ${execution.executionId}: ${workspaceLine(execution.workspace!)}`)].join("\n"));
  sections.push(`Current graph (revision ${job.execution.revision}):\n${formatGraph(job.execution.graph)}`);
  return sections.join("\n\n");
}

/** The waking reminder for an execution its node timeout paused. */
export function formatTimeoutPause(pause: TimeoutPause): string {
  const execution = `${pause.executionId}${pause.iteration ? ` (iteration ${pause.iteration})` : ""}`;
  return [
    `Braid job ${pause.handle} node ${JSON.stringify(pause.nodeId)} execution ${execution} was paused because it exceeded its node timeout:`,
    `it ran ${duration(pause.activeMs)} against a budget of ${duration(pause.nodeTimeoutMs)}.`,
    pause.activity ? `When the timeout fired it was: ${pause.activity}.` : "",
    "Its conversation, workspace, and tool budgets are kept; the step that was interrupted is reported to it after resume.",
    "Its successors wait until you decide. Check it with",
    `braid_status(${JSON.stringify({ jobId: pause.handle, executionId: pause.executionId })}), then either`,
    `resume it with braid_resume({"jobId":"${pause.handle}","executionIds":["${pause.executionId}"],"expectedRevision":<current>}) — it gets the job's nodeTimeoutMs again, or pass nodeTimeoutMs —`,
    "or resume it in braid_update with resume and resumeOptions together with graph changes,",
    `or fail only this execution with braid_cancel({"jobId":"${pause.handle}","executionIds":["${pause.executionId}"]}).`,
    "The graph timeout keeps running while it is paused.",
  ].filter(Boolean).join(" ");
}

/** The result of braid_cancel with executionIds. */
export function formatCancelExecutions(job: JobSnapshot, executionIds: readonly string[]): string {
  return [`Braid job ${job.handle}: cancellation requested for ${ids(executionIds)}. They fail; their successors follow the usual failure rules.`,
    control(job.execution)].join("\n");
}
