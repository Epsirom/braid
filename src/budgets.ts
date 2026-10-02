import type { ModelRequest } from "./types.js";

/** Rebuilt before each model call so reminders never restart a shared deadline. */
export function formatBudgetReminder(
  request: ModelRequest,
  toolBudgets: readonly string[] = [],
): string {
  const lines = [...toolBudgets];
  const now = performance.now();
  for (const scope of ["node", "graph"] as const) {
    const deadline = request.deadlines?.[scope];
    if (deadline !== undefined && Number.isFinite(deadline)) {
      lines.push(
        `${scope === "node" ? "Node" : "Graph"} time budget: ${Math.max(0, Math.ceil(deadline - now))} ms remaining as of this request.`,
      );
    }
  }
  if (lines.length === 0) return "";
  return (
    "\n\n<system-reminder>\n" + lines.join("\n") +
    "\nThese are hard limits. Time includes model generation and tool execution; the graph budget is shared by all nodes. " +
    "Finish your analysis and return a final answer within the remaining budgets. " +
    "If a decision is required, call decide before finishing. " +
    ((request.node.type === "merge" || request.node.type === "integrate") ? "Reserve budget to call finish_merge for every source before finishing. " : "") +
    "\n</system-reminder>"
  );
}
