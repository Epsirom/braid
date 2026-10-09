import { formatActivityStatus, type ExecutionActivity } from "@chrok/braid";
import type { JobSnapshot } from "./jobs.js";

/** Plain text works in both DSH's native job panel and human command results. */
export function renderPanel(job: JobSnapshot, activity: (executionId: string) => ExecutionActivity | undefined = () => undefined, now = Date.now()): string {
  const state = job.execution;
  const lines = [`Braid ${job.handle} · ${job.status} · revision ${state.revision}`, job.goal,
    `Paused: ${state.pausedExecutionIds.join(", ") || "none"}`, ""];
  for (const node of state.graph.nodes.slice(0, 80)) {
    const result = state.nodes[node.id];
    const progress = result?.executionId ? job.progress[result.executionId] : undefined;
    lines.push(`${result?.status === "running" ? "▶" : "·"} ${node.id} [${node.type}] ${result?.status ?? "pending"}` +
      (progress ? ` · context ${progress.contextTokens}${progress.contextWindow ? `/${progress.contextWindow}` : ""} (${progress.contextSource}) · tools ${progress.toolCalls}` : "") +
      (result?.startedAt ? ` · ${Math.max(0, (result.finishedAt ?? Date.now()) - result.startedAt)} ms` : ""));
    for (const edge of state.graph.edges.filter(edge => edge.from === node.id))
      lines.push(`  └─${edge.choice ? ` ${edge.choice}` : ""}${edge.feedback ? ` ↻ ${edge.feedback}` : ""} → ${edge.to}`);
    const live = result?.status === "running" && result.executionId ? activity(result.executionId) : undefined;
    if (live) lines.push(`  activity: ${formatActivityStatus(live, now)} · ${live.lastActivity.slice(0, 160)}`);
    if (result?.error) lines.push(`  ${result.error.code}: ${result.error.message}`);
  }
  if (state.graph.nodes.length > 80) lines.push("… additional nodes available through braid_status");
  lines.push("", "Recent events:", ...job.events.slice(-12).map(event =>
    `#${event.sequence} ${event.type}${"nodeId" in event ? ` · ${event.nodeId}` : ""}${event.executionId ? ` · ${event.executionId}` : ""}`));
  lines.push("", `Usage: ${job.usage.totalTokens ?? 0} tokens (including cache)`,
    `Results: braid_status({"jobId":"${job.handle}"})`, `/braid cancel ${job.handle}`);
  return lines.join("\n");
}
