import type { ToolCallPhaseProps } from "@deepseek-ai/dsh-client-ui-tool/client";

export interface BraidNavigation { jobId?: string; nodeId?: string; executionId?: string; createdBefore?: number }
export const braidToolNames = ["braid", "braid_status", "braid_update", "braid_resume", "braid_pause", "braid_cancel"] as const;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function json(raw: string): Record<string, unknown> {
  try { return record(JSON.parse(raw)); } catch { return {}; }
}
const id = (value: unknown): string | undefined => typeof value === "string" && value.trim() && value.length <= 1024 ? value : undefined;

/** Sidebar navigation also survives layout restoration, so validate its loose JSON boundary. */
export function readNavigation(value: unknown): BraidNavigation {
  const source = record(value), target: BraidNavigation = {};
  for (const key of ["jobId", "nodeId", "executionId"] as const) {
    const text = id(source[key]); if (text !== undefined) target[key] = text;
  }
  if (typeof source.createdBefore === "number" && Number.isSafeInteger(source.createdBefore) && source.createdBefore >= 0)
    target.createdBefore = source.createdBefore;
  return target;
}

function toolData(props: ToolCallPhaseProps) {
  const args = json(props.phase === "result" ? props.block.call?.argsRaw ?? "" : props.phase === "start" ? props.block.argsRaw : "");
  let result: Record<string, unknown> = {};
  if (props.phase === "result" && !props.block.isError) {
    // Results carry their identifiers in presentation meta; sessions recorded
    // before results became text kept them in JSON content.
    result = record(props.block.meta);
    if (!Object.keys(result).length) for (const content of props.block.content) {
      if (content.type !== "text") continue;
      const value = json(content.text);
      if (Object.keys(value).length > 0) { result = value; break; }
    }
  }
  return { args, result };
}

/** Read only envelope identifiers, never the result preview, prompts, or worker output. */
export function toolNavigation(toolName: string, props: ToolCallPhaseProps): BraidNavigation | null {
  if (!braidToolNames.some(name => name === toolName) || props.phase === "preparing") return null;
  const { args, result } = toolData(props);
  const jobId = id(result.canonicalJobId) ?? id(result.jobId) ?? id(args.jobId);
  // A submission has no target until its receipt arrives. A list call opens the roster.
  if (!jobId) return toolName === "braid_status" && !("jobId" in args || "nodeId" in args || "executionId" in args) ? {} : null;
  const target: BraidNavigation = { jobId };
  const node = record(result.node);
  const executionId = id(args.executionId) ?? id(node.executionId)
    ?? ((toolName === "braid_resume" || toolName === "braid_pause") && Array.isArray(args.executionIds) && args.executionIds.length === 1 ? id(args.executionIds[0]) : undefined);
  const nodeId = id(args.nodeId) ?? id(node.id);
  if (executionId) target.executionId = executionId;
  if (nodeId) target.nodeId = nodeId;
  const time = props.block.time;
  if (Number.isSafeInteger(time) && time >= 0) target.createdBefore = time;
  return target;
}

export interface ToolPresentation {
  label: string;
  summary: string;
  changes: string[];
  jobs: { label: string; status: string; target: BraidNavigation }[];
}
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const revision = (value: unknown): string => typeof value === "number" && Number.isSafeInteger(value) ? `r${value}` : "";
const names = (values: unknown[]): string => {
  const ids = values.map(value => id(value) ?? id(record(value).id)).filter(Boolean);
  return ids.slice(0, 8).join(", ") + (ids.length > 8 ? ` … (+${ids.length - 8})` : "");
};

/** Each tool card describes its recorded operation; the sidebar is explicitly live. */
export function toolPresentation(toolName: string, props: ToolCallPhaseProps): ToolPresentation {
  const { args, result } = toolData(props);
  const label = id(result.handle) ?? id(args.jobId) ?? id(result.jobId) ?? "";
  const model: ToolPresentation = { label, summary: "", changes: [], jobs: [] };
  const failed = props.phase === "result" && props.block.isError;
  const settled = props.phase === "result";
  if (toolName === "braid_update") {
    const revisions = [revision(args.expectedRevision), revision(result.revision)].filter(Boolean).join(" → ");
    model.summary = `${failed ? "Update rejected · not applied" : settled ? "Graph updated" : "Updating graph"}${revisions ? ` · ${revisions}` : ""}`;
    for (const [key, title] of [["upsertNodes", "Upsert nodes"], ["removeNodeIds", "Remove nodes"], ["resume", "Resume executions"]] as const) {
      const values = array(args[key]); if (values.length) model.changes.push(`${title}: ${names(values)}`);
    }
    for (const [key, title] of [["addEdges", "Add edges"], ["removeEdges", "Remove edges"]] as const) {
      const values = array(args[key]); if (values.length) model.changes.push(`${title}: ${values.length}`);
    }
    if ("loops" in args) model.changes.push(`Replace loops: ${array(args.loops).length}`);
    if ("promptTemplates" in args) model.changes.push(`Prompt templates: ${Object.keys(record(args.promptTemplates)).length}`);
  } else if (toolName === "braid_resume" || toolName === "braid_pause") {
    // Without execution IDs, both act on the whole job.
    const target = "executionIds" in args ? `${array(args.executionIds).length} execution(s)` : "job";
    // after=true adds (pause) or removes (resume) a hold instead of suspending or resuming.
    model.summary = args.after === true
      ? toolName === "braid_pause"
        ? failed ? "Hold rejected" : `${settled ? "Holding" : "Requesting hold for"} ${target}`
        : failed ? "Hold removal rejected" : `${settled ? "Hold removed for" : "Removing hold for"} ${target}`
      : toolName === "braid_pause"
      ? failed ? "Pause rejected" : `${settled ? "Pause requested for" : "Pausing"} ${target}`
      : failed ? "Resume rejected" : `${settled ? "Resumed" : "Resuming"} ${target}`;
    const ids = names(array(args.executionIds)); if (ids) model.changes.push(ids);
    const execution = toolName === "braid_pause" ? record(result.execution) : result;
    if (Array.isArray(execution.pausedExecutionIds)) model.changes.push(`${execution.pausedExecutionIds.length} still paused · ${revision(execution.revision)}`);
    if (Array.isArray(execution.suspendedExecutionIds) && execution.suspendedExecutionIds.length) model.changes.push(`${execution.suspendedExecutionIds.length} suspended`);
  } else if (toolName === "braid_cancel") {
    model.summary = failed ? "Cancellation failed" : !settled ? "Requesting cancellation" : result.cancelled === false ? "Job already finished" : "Cancellation requested";
  } else if (toolName === "braid_status" && Array.isArray(result.jobs)) {
    model.summary = `${result.jobs.length} job(s) at this call`;
    model.jobs = result.jobs.flatMap(value => {
      const row = record(value), jobId = id(row.jobId);
      return jobId ? [{ label: id(row.handle) ?? jobId, status: id(row.status) ?? "", target: { jobId, createdBefore: props.block.time } }] : [];
    });
  } else if (toolName === "braid_status") {
    const execution = record(result.execution), node = record(result.node);
    const executions = Object.values(record(execution.executions));
    const total = typeof execution.total === "number" ? execution.total : executions.length;
    const completed = typeof execution.completed === "number" ? execution.completed : executions.filter(value => record(value).status === "completed").length;
    const details = id(node.status)
      ? [`execution ${id(node.status)}`, id(execution.status) ? `graph ${id(execution.status)}` : undefined, revision(execution.revision)]
      : [id(execution.status) ?? id(result.status), revision(execution.revision)];
    if (total && !id(node.status)) details.push(`${completed}/${total} executions complete`);
    if (Array.isArray(execution.pausedExecutionIds) && execution.pausedExecutionIds.length) details.push(`${execution.pausedExecutionIds.length} paused`);
    if (Array.isArray(execution.suspendedExecutionIds) && execution.suspendedExecutionIds.length) details.push(`${execution.suspendedExecutionIds.length} suspended`);
    if (record(execution.pause).source) details.push("job paused");
    model.summary = failed ? "Status query failed" : details.filter(Boolean).join(" · ") || (settled ? "Recorded status" : "Reading status");
  } else {
    const graph = record(result.graph);
    const nodes = (typeof result.nodeCount === "number" ? result.nodeCount : array(graph.nodes).length) || array(args.nodes).length;
    model.summary = failed ? "Submission failed" : `${settled ? "Graph submitted" : "Starting graph"}${nodes ? ` · ${nodes} nodes` : ""}`;
  }
  if (result.truncated === true) model.changes.push("Long result truncated; the full text is saved to the file named in the result");
  return model;
}
