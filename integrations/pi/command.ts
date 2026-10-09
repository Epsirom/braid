import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type AutocompleteItem,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import { BraidJobs, type JobSnapshot } from "./jobs.js";
import { renderGraphResult, renderNodeResult } from "./display.js";

// Match the overlay height exactly so Pi never clips the footer or bottom border.
const panelHeight = (rows: number): number =>
  Math.max(1, Math.floor(rows * 0.9));

const plain = (value: string): string =>
  stripTerminalSequences(value).replace(/\p{Cc}/gu, " ");

/** A node definition (latest invocation) or one exact execution. */
export type NodeFocus = { nodeId: string } | { executionId: string };

/** A live, scrollable panel. Closing the panel leaves jobs running. */
export class BraidPanel implements Component {
  private selected: string | undefined;
  private focus: NodeFocus | undefined;
  private offset = 0;
  private maxOffset = 0;
  private disposed = false;
  private readonly unsubscribe: () => void;
  private readonly ticker: ReturnType<typeof setInterval>;

  constructor(
    private readonly jobs: BraidJobs,
    private readonly tui: Pick<TUI, "requestRender" | "terminal">,
    private readonly theme: Theme,
    private readonly done: () => void,
    jobId?: string,
    focus?: NodeFocus,
  ) {
    this.selected = jobId ? jobs.get(jobId)?.jobId ?? jobId : undefined;
    this.focus = focus;
    this.unsubscribe = jobs.subscribe(() => this.refresh());
    this.ticker = setInterval(() => this.refresh(), 1000);
    this.ticker.unref();
  }

  private refresh(): void {
    if (!this.disposed) this.tui.requestRender();
  }

  render(width: number): string[] {
    const rows = panelHeight(this.tui.terminal.rows);
    if (width < 8 || rows < 4) {
      return [truncateToWidth("Braid · Esc close", width, "")];
    }
    const innerWidth = width - 2;
    const contentWidth = width - 4;
    const border = (value: string) => this.theme.fg("borderMuted", value);
    const rule = (left: string, right: string, label = "") => {
      const title = truncateToWidth(label ? ` ${label} ` : "", innerWidth, "");
      return (
        border(left) +
        this.theme.fg("accent", this.theme.bold(title)) +
        border("─".repeat(innerWidth - visibleWidth(title)) + right)
      );
    };
    const row = (value: string) =>
      border("│") +
      " " +
      truncateToWidth(value, contentWidth, "…", true) +
      " " +
      border("│");
    const jobs = this.jobs.list();
    const summary = jobs.find((job) => job.jobId === this.selected) ?? jobs[0];
    const current = summary ? this.jobs.get(summary.jobId) : undefined;
    this.selected = current?.jobId;
    const index = jobs.findIndex((job) => job.jobId === current?.jobId);
    const statusColor =
      current?.status === "running"
        ? "warning"
        : current?.status === "completed"
          ? "success"
          : current?.status === "failed"
            ? "error"
            : "muted";
    const focusLabel = this.focus
      ? "nodeId" in this.focus ? `node ${plain(this.focus.nodeId)}` : `execution ${plain(this.focus.executionId)}`
      : "";
    const heading = current
      ? `Job ${index + 1} of ${jobs.length}  ·  ${this.theme.fg(statusColor, current.status)}${focusLabel ? `  ·  ${focusLabel}` : ""}`
      : this.theme.fg("muted", "No background jobs");
    // Reserve a body row and the close hint even in a very short terminal.
    if (rows < 10) {
      const compact = [
        heading,
        ...(current
          ? [plain(current.goal)]
          : ["Ask the agent to run a Braid graph."]),
      ];
      return [
        rule("╭", "╮", "Braid"),
        ...compact.slice(0, rows - 3).map(row),
        row("Esc close"),
        rule("╰", "╯"),
      ];
    }
    const header = [
      rule("╭", "╮", "Braid"),
      row(heading),
      row(
        current ? plain(current.goal) : "Ask the agent to run a Braid graph.",
      ),
      row(
        this.theme.fg(
          "dim",
          current
            ? current.jobId
            : "Jobs will appear here as soon as they are submitted.",
        ),
      ),
      rule("├", "┤"),
    ];
    const content = current && this.focus
      ? this.renderFocus(current, this.focus, contentWidth)
      : current
      ? [
          ...(current.error
            ? [this.theme.fg("error", plain(current.error))]
            : []),
          ...renderGraphResult(
            {
              ...(current.result ?? current.live),
              progress: current.live.progress,
              ...(current.workspaces ? { workspaces: current.workspaces } : {}),
              ...(current.fullOutputPath
                ? { fullOutputPath: current.fullOutputPath }
                : {}),
            },
            true,
            false,
            this.theme,
          ).render(contentWidth),
        ]
      : ["No Braid jobs in this session."];
    const height = rows - header.length - 4;
    this.maxOffset = Math.max(0, content.length - height);
    this.offset = Math.min(this.offset, this.maxOffset);
    const body = content.slice(this.offset, this.offset + height);
    while (body.length < height) body.push("");
    const range = `Lines ${this.offset + 1}–${Math.min(content.length, this.offset + height)}/${content.length}`;
    const help = this.focus
      ? contentWidth >= 72
        ? "⌫ graph   ←/→ jobs   ↑/↓ scroll   PgUp/PgDn page   c cancel   Esc close"
        : contentWidth >= 42
          ? "⌫ graph · ↑/↓ scroll · c cancel · Esc close"
          : "⌫ graph · Esc close"
      : contentWidth >= 72
        ? "←/→ jobs   ↑/↓ scroll   PgUp/PgDn page   c cancel   Esc close"
        : contentWidth >= 42
          ? "←/→ jobs · ↑/↓ scroll · c cancel · Esc close"
          : "↑/↓ scroll · Esc close";
    return [
      ...header,
      ...body.map(row),
      rule("├", "┤"),
      row(
        this.theme.fg(
          "dim",
          `${range}${contentWidth >= 60 ? "  ·  Jobs keep running when this panel closes" : ""}`,
        ),
      ),
      row(this.theme.fg("muted", help)),
      rule("╰", "╯"),
    ];
  }

  /** A focused node can disappear after a live graph update; say so instead of failing. */
  private renderFocus(job: JobSnapshot, focus: NodeFocus, width: number): string[] {
    let node;
    try {
      node = "nodeId" in focus
        ? this.jobs.getNode(job.jobId, focus.nodeId)
        : this.jobs.getNode(job.jobId, undefined, focus.executionId);
    } catch {
      return [
        this.theme.fg("warning", "This node or execution is no longer in the job's graph."),
        this.theme.fg("muted", "Press Backspace to return to the graph."),
      ];
    }
    // Latest-node results omit the loop iteration; their execution record has it.
    const executions = job.result?.executions ?? job.execution?.executions;
    const iteration = (node as { iteration?: number }).iteration ??
      (node.executionId ? executions?.[node.executionId]?.iteration : undefined);
    return renderNodeResult(iteration === undefined ? node : { ...node, iteration }, true, this.theme, undefined, job.live.progress[node.id], job.live.observedAt)
      .render(width);
  }

  handleInput(data: string): void {
    if (
      matchesKey(data, "escape") ||
      data === "q" ||
      matchesKey(data, "ctrl+c")
    ) {
      this.dispose();
      this.done();
      return;
    }
    const jobs = this.jobs.list();
    const index = Math.max(
      0,
      jobs.findIndex((job) => job.jobId === this.selected),
    );
    if (matchesKey(data, "left") || matchesKey(data, "right")) {
      const step = matchesKey(data, "right") ? 1 : -1;
      this.selected = jobs[(index + step + jobs.length) % jobs.length]?.jobId;
      this.focus = undefined;
      this.offset = 0;
    } else if (matchesKey(data, "backspace") && this.focus) {
      this.focus = undefined;
      this.offset = 0;
    } else if (matchesKey(data, "up"))
      this.offset = Math.max(0, this.offset - 1);
    else if (matchesKey(data, "down"))
      this.offset = Math.min(this.maxOffset, this.offset + 1);
    else if (matchesKey(data, "pageUp"))
      this.offset = Math.max(0, this.offset - 10);
    else if (matchesKey(data, "pageDown"))
      this.offset = Math.min(this.maxOffset, this.offset + 10);
    else if (data === "c" && this.selected) this.jobs.cancel(this.selected);
    this.refresh();
  }

  invalidate(): void {}

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.ticker);
    this.unsubscribe();
  }
}

export function registerBraidCommand(pi: ExtensionAPI, jobs: BraidJobs): void {
  pi.registerCommand("braid", {
    description:
      "Open the live background-job flow panel: /braid [jobId [nodeId|executionId]]",
    getArgumentCompletions: (prefix) => braidCompletions(jobs, prefix),
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui")
        throw new Error(
          "The Braid panel requires interactive Pi. Use braid_status for job status.",
        );
      const [jobId, target] = splitArguments(args.trim());
      if (jobId && !jobs.get(jobId))
        throw jobs.unknownJob(jobId);
      const focus = jobId && target ? resolveFocus(jobs, jobId, target) : undefined;
      let panel: BraidPanel | undefined;
      try {
        await ctx.ui.custom<void>(
          (tui, theme, _keys, done) => {
            panel = new BraidPanel(jobs, tui, theme, done, jobId, focus);
            return panel;
          },
          {
            overlay: true,
            overlayOptions: {
              anchor: "center",
              width: "95%",
              maxHeight: "90%",
            },
          },
        );
      } finally {
        panel?.dispose();
      }
    },
  });
}

/** Job IDs never contain whitespace; node IDs may, so the rest is one target. */
function splitArguments(text: string): [string | undefined, string | undefined] {
  const split = text.search(/\s/);
  if (split < 0) return [text || undefined, undefined];
  const jobId = text.slice(0, split);
  const target = text.slice(split).trim();
  if (!target.startsWith('"')) return [jobId, target || undefined];
  try {
    return [jobId, JSON.parse(target) as string];
  } catch {
    throw new Error('A quoted Braid target must be a valid JSON string, for example " review ".');
  }
}

/** Quote IDs that would otherwise be trimmed, parsed as quotes, or rendered as controls. */
function formatTarget(id: string): string {
  if (id === id.trim() && !id.startsWith('"') && !/[\p{Cc}\u2028\u2029]/u.test(id)) return id;
  return JSON.stringify(id).replace(/\u2028/gu, "\\u2028").replace(/\u2029/gu, "\\u2029");
}

/** Node IDs take precedence; anything else must be an exact execution ID. */
function resolveFocus(jobs: BraidJobs, jobId: string, target: string): NodeFocus {
  try {
    jobs.getNode(jobId, target);
    return { nodeId: target };
  } catch {}
  try {
    jobs.getNode(jobId, undefined, target);
    return { executionId: target };
  } catch {}
  const handle = jobs.get(jobId)?.handle ?? jobId;
  throw new Error(
    `Unknown Braid node or execution "${plain(target)}" in ${handle}. Open /braid ${handle} to see its nodes.`,
  );
}

/** Pi replaces the whole argument text, so node suggestions repeat the job handle. */
function braidCompletions(jobs: BraidJobs, prefix: string): AutocompleteItem[] | null {
  const text = prefix.trimStart();
  const split = text.search(/\s/);
  const jobPrefix = split < 0 ? text : text.slice(0, split);
  if (split < 0) {
    const items = jobs.list()
      .filter((job) => job.handle.startsWith(jobPrefix))
      .map((job) => ({ value: job.handle, label: job.handle, description: `${job.status} · ${plain(job.goal)}` }));
    return items.length ? items : null;
  }
  const nodePrefix = text.slice(split).trimStart();
  const job = jobs.get(jobPrefix);
  if (!job) return null;
  const nodes = job.result?.nodes ?? job.execution?.nodes ?? job.live.nodes;
  const items = Object.values(nodes)
    .flatMap((node) => {
      const target = formatTarget(node.id);
      return node.id.startsWith(nodePrefix) || target.startsWith(nodePrefix)
        ? [{ value: `${job.handle} ${target}`, label: target, description: node.status }]
        : [];
    });
  return items.length ? items : null;
}
