import type {
  BraidInput, BraidInputNode, BraidSnapshot, ExecutionActivity, ExecutionError, NodeExecution, NodeResult, NodeWorkspace,
} from "@chrok/braid";
import type { Usage } from "@earendil-works/pi-ai";
import type { JobSnapshot } from "./jobs.js";

/** Model-facing text documents for the parent Braid tools. */

const iso = (ms: number) => new Date(ms).toISOString();
const duration = (ms: number) => ms < 1000 ? `${Math.max(0, Math.round(ms))}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
const failure = (error: ExecutionError) => `${error.code}: ${error.message}`;
const ids = (values: readonly string[] | undefined) => values?.length ? values.join(", ") : "none";
const GOAL_CHARS = 2000;
const clip = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit)}… [${text.length} chars]` : text;
const indent = (text: string) => text.split("\n").map(line => line ? `  ${line}` : line).join("\n");

export function formatUsage(usage: Usage | undefined): string | undefined {
  if (!usage) return undefined;
  const parts = [`input ${usage.input}`, `output ${usage.output}`];
  if (usage.cacheRead) parts.push(`cache read ${usage.cacheRead}`);
  if (usage.cacheWrite) parts.push(`cache write ${usage.cacheWrite}`);
  const cost = usage.cost?.total ? `, $${usage.cost.total.toFixed(4)}` : "";
  return `${parts.join(", ")} (${usage.totalTokens} tokens${cost})`;
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
  if (execution.suspension) parts.push(`${execution.suspension.state}, paused by ${execution.suspension.source}`);
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
function control(execution: Control | undefined): string {
  if (!execution) return "Graph not started";
  const parts = [`Graph ${execution.status}`, `revision ${execution.revision}`, `paused executions: ${ids(execution.pausedExecutionIds)}`];
  if (execution.suspendedExecutionIds?.length) parts.push(`suspended executions: ${ids(execution.suspendedExecutionIds)}`);
  if (execution.pause) parts.push(`job paused by ${execution.pause.source} at ${iso(execution.pause.pausedAt)}`);
  return parts.join(" · ");
}

/** Paused-by-user work is the user's call: say so wherever the parent sees it. */
const USER_PAUSE_NOTE = "The user paused this; do not resume it unless the user asks.";

function userPaused(execution: Control | undefined, executions: readonly NodeResult[]): boolean {
  return execution?.pause?.source === "user" || executions.some(item => item.suspension?.source === "user");
}

/** The submission receipt. The caller already has the graph it submitted. */
export function formatReceipt(job: JobSnapshot, message: string): string {
  return [`Braid job ${job.handle} started (${job.status}).`, `ID: ${job.jobId}`, message].join("\n");
}

export function formatUpdate(job: JobSnapshot): string {
  return [`Braid job ${job.handle} updated to revision ${job.execution!.revision}.`,
    `Paused executions: ${ids(job.execution!.pausedExecutionIds)}`,
    ...job.execution!.suspendedExecutionIds?.length ? [`Suspended executions: ${ids(job.execution!.suspendedExecutionIds)}`] : [],
    "Current graph:", formatGraph(job.execution!.graph)].join("\n");
}

export function formatResume(job: JobSnapshot): string {
  const execution = job.execution!;
  return `Braid job ${job.handle} resumed at revision ${execution.revision}. Still paused: ${ids(execution.pausedExecutionIds)}. ` +
    `Still suspended: ${ids(execution.suspendedExecutionIds)}.${execution.pause ? ` The job itself is still paused by ${execution.pause.source}.` : ""}`;
}

/** The result of braid_pause: what is pausing now and how to continue. */
export function formatPause(job: JobSnapshot, executionIds?: readonly string[]): string {
  const execution = job.execution!;
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
    ...node.suspension ? [`Execution is ${node.suspension.state}, paused by ${node.suspension.source}${node.suspension.suspendedAt !== undefined ? ` since ${iso(node.suspension.suspendedAt)}` : ""}.${node.suspension.source === "user" ? ` ${USER_PAUSE_NOTE}` : ""}`] : [],
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
  if (job.status === "running" && userPaused(job.execution, Object.values(job.execution?.executions ?? {}))) header.push(USER_PAUSE_NOTE);
  const error = job.error ?? (job.result?.error ? failure(job.result.error) : job.execution?.error ? failure(job.execution.error) : undefined);
  if (error) header.push(`Error: ${error}`);
  const usage = formatUsage(job.usage);
  if (usage) header.push(`Usage: ${usage}`);
  if (job.result) header.push(`Finished ${iso(job.result.metadata.finishedAt)} after ${duration(job.result.metadata.latencyMs)}`);
  else header.push(`Started ${iso(job.createdAt)}, ${duration(now - job.createdAt)} ago`);
  header.push(`Goal: ${clip(job.goal, GOAL_CHARS)}`);
  const sections = [header.join("\n")];
  const executions = Object.values(state?.executions ?? {});
  if (executions.length) sections.push([`Executions (${executions.length}):`, ...executions.map(executionLine)].join("\n"));
  const pending = Object.values(state?.nodes ?? {}).filter(node => !node.executionId);
  if (pending.length) sections.push(["Nodes without executions:", ...pending.map(executionLine)].join("\n"));
  const terminal = new Set(job.result?.terminalExecutionIds ?? []);
  const outputs = executions.filter(execution => execution.output !== undefined);
  if (outputs.length) sections.push(["Outputs:", ...outputs.map(execution =>
    `## ${execution.id} · ${execution.executionId}${terminal.has(execution.executionId) ? " · terminal" : ""}${execution.decision ? ` · decision ${execution.decision}` : ""}\n${execution.output}`)].join("\n\n"));
  const workspaces = executions.filter(execution => execution.workspace);
  if (workspaces.length) sections.push(["Workspaces:", ...workspaces.map(execution => `- ${execution.executionId}: ${workspaceLine(execution.workspace!)}`)].join("\n"));
  if (job.execution) sections.push(`Current graph (revision ${job.execution.revision}):\n${formatGraph(job.execution.graph)}`);
  return sections.join("\n\n");
}
