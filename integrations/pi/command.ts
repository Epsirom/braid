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
import { renderGraphResult, renderNodeDetails, renderSessionHeader, SELECTED_NODE_MARK } from "./display.js";
import { NodeSessionView } from "./session-view.js";

// Match the overlay height exactly so Pi never clips the footer or bottom border.
const panelHeight = (rows: number): number =>
  Math.max(1, Math.floor(rows * 0.9));

const plain = (value: string): string =>
  stripTerminalSequences(value).replace(/\p{Cc}/gu, " ");

/** A node definition (latest invocation) or one exact execution. */
export type NodeFocus = { nodeId: string } | { executionId: string };

/**
 * A live, scrollable panel. Esc steps back one level: session → node selection →
 * graph → close. Closing the panel leaves jobs running.
 */
export class BraidPanel implements Component {
  private selected: string | undefined;
  private focus: NodeFocus | undefined;
  /** Node highlighted in selection mode (`v`); undefined in the plain graph view. */
  private choosing: string | undefined;
  /** Keep the newest transcript lines in view until the user scrolls up. */
  private follow = true;
  /** The selection last scrolled into view, so manual scrolling is not overridden. */
  private revealed: string | undefined;
  private offset = 0;
  private maxOffset = 0;
  private disposed = false;
  private readonly session: NodeSessionView;
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
    // Pi's tool components only request renders through the TUI.
    this.session = new NodeSessionView(tui as TUI, theme);
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
      : this.choosing !== undefined ? "select a node" : "";
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
    if (current && this.choosing !== undefined && !this.nodeIds(current).includes(this.choosing)) {
      this.choosing = this.nodeIds(current)[0];
    }
    // The node summary (or the selected node) stays pinned while the body scrolls.
    const focused = current && this.focus ? this.renderFocus(current, this.focus, contentWidth) : undefined;
    let pinned = focused?.pinned ?? (current && this.choosing !== undefined ? [this.choosingLine(current)] : []);
    const available = rows - header.length - 4;
    const maxPinned = Math.max(2, Math.floor(available / 2));
    if (pinned.length > maxPinned) {
      pinned = [...pinned.slice(0, maxPinned - 1), this.theme.fg("dim", `… ${pinned.length - maxPinned + 1} more summary lines`)];
    }
    const content = focused
      ? focused.body
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
            "",
            false,
            this.choosing,
          ).render(contentWidth),
        ]
      : ["No Braid jobs in this session."];
    const height = available - (pinned.length ? pinned.length + 1 : 0);
    this.maxOffset = Math.max(0, content.length - height);
    this.offset = this.focus && this.follow ? this.maxOffset : Math.min(this.offset, this.maxOffset);
    if (!this.focus && this.choosing !== undefined && this.choosing !== this.revealed) {
      // Bring a newly selected node's box into view in a tall flowchart.
      this.revealed = this.choosing;
      const line = content.findIndex(text => stripTerminalSequences(text).includes(SELECTED_NODE_MARK));
      if (line >= 0 && (line < this.offset || line > this.offset + height - 3)) {
        this.offset = Math.max(0, Math.min(this.maxOffset, line - Math.floor(height / 3)));
      }
    }
    if (this.choosing === undefined) this.revealed = undefined;
    const body = content.slice(this.offset, this.offset + height);
    while (body.length < height) body.push("");
    const range = `Lines ${this.offset + 1}–${Math.min(content.length, this.offset + height)}/${content.length}`;
    const [wide, medium, narrow] = this.focus
      ? ["Esc back   ←/→ executions   ↑/↓ scroll   End follow   ctrl+o tools   c cancel   q close",
        "Esc back · ←/→ executions · ↑/↓ scroll · q close", "Esc back · q close"]
      : this.choosing !== undefined
      ? ["↑/↓/←/→ choose node   Enter open session   Esc back   PgUp/PgDn page   q close",
        "↑/↓ choose · Enter open · Esc back", "Enter open · Esc back"]
      : ["v select node   ←/→ jobs   ↑/↓ scroll   PgUp/PgDn page   c cancel   Esc close",
        "v select node · ←/→ jobs · ↑/↓ scroll · Esc close", "v select · Esc close"];
    const help = contentWidth >= 80 ? wide : contentWidth >= 42 ? medium : narrow;
    return [
      ...header,
      ...(pinned.length ? [...pinned.map(row), rule("├", "┤")] : []),
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

  /** Graph definition order, which is also the flowchart's declaration order. */
  private nodeIds(job: JobSnapshot): string[] {
    return Object.keys(job.result?.nodes ?? job.live.nodes);
  }

  private choosingLine(job: JobSnapshot): string {
    const nodes = job.result?.nodes ?? job.live.nodes;
    const node = this.choosing !== undefined ? nodes[this.choosing] : undefined;
    const ids = this.nodeIds(job);
    return this.theme.fg("warning", `${SELECTED_NODE_MARK} Selected ${ids.indexOf(this.choosing ?? "") + 1}/${ids.length}: `) +
      this.theme.bold(plain(this.choosing ?? "")) + this.theme.fg("muted", ` · ${node?.status ?? "pending"} · Enter to open its session`);
  }

  /** A focused node can disappear after a live graph update; say so instead of failing. */
  private renderFocus(job: JobSnapshot, focus: NodeFocus, width: number): { pinned: string[]; body: string[] } {
    let node;
    try {
      node = "nodeId" in focus
        ? this.jobs.getNode(job.jobId, focus.nodeId)
        : this.jobs.getNode(job.jobId, undefined, focus.executionId);
    } catch {
      return { pinned: [], body: [
        this.theme.fg("warning", "This node or execution is no longer in the job's graph."),
        this.theme.fg("muted", "Press Esc to return to the graph."),
      ] };
    }
    // Latest-node results omit the loop iteration; their execution record has it.
    const executions = job.result?.executions ?? job.execution?.executions;
    const iteration = (node as { iteration?: number }).iteration ??
      (node.executionId ? executions?.[node.executionId]?.iteration : undefined);
    const withIteration = iteration === undefined ? node : { ...node, iteration };
    const activity = node.executionId ? this.jobs.getActivity(job.jobId, node.executionId) : undefined;
    const transcript = node.executionId ? this.jobs.getTranscript(job.jobId, node.executionId) : undefined;
    const siblings = this.executionsOf(job, node.id);
    const position = node.executionId ? siblings.indexOf(node.executionId) : -1;
    const header = [
      ...renderSessionHeader(withIteration, this.theme, job.live.observedAt, job.live.progress[node.id], activity),
      ...(siblings.length > 1 ? [this.theme.fg("dim", `execution ${position + 1} of ${siblings.length} for this node · ←/→ to switch`)] : []),
    ];
    let failure: string | undefined;
    if (transcript) {
      try {
        return { pinned: header, body: this.session.render(transcript, width) };
      } catch (error) {
        // A rendering failure must not take down the overlay; fall back to the summary.
        failure = this.theme.fg("error", `Session view unavailable: ${plain(error instanceof Error ? error.message : String(error))}`);
      }
    }
    // Pending, recorded before this session, or evicted: show details and history instead.
    const note = failure ?? (node.executionId
      ? this.theme.fg("muted", "The live session for this execution is no longer retained; showing its details and activity history.")
      : this.theme.fg("muted", "This node has not run yet."));
    return { pinned: header, body: [note, ...renderNodeDetails(node, this.theme, job.live.observedAt, activity)] };
  }

  private executionsOf(job: JobSnapshot, nodeId: string): string[] {
    const executions = job.result?.executions ?? job.execution?.executions ?? {};
    return Object.values(executions).filter(execution => execution.id === nodeId).map(execution => execution.executionId);
  }

  private open(job: JobSnapshot, nodeId: string): void {
    const executionId = this.executionsOf(job, nodeId).at(-1);
    this.focus = executionId ? { executionId } : { nodeId };
    this.follow = true;
    this.offset = 0;
  }

  handleInput(data: string): void {
    if (data === "q" || matchesKey(data, "ctrl+c")) {
      this.close();
      return;
    }
    const jobs = this.jobs.list();
    const index = Math.max(
      0,
      jobs.findIndex((job) => job.jobId === this.selected),
    );
    const job = this.selected ? this.jobs.get(this.selected) : undefined;
    if (this.focus) this.sessionInput(data, job);
    else if (this.choosing !== undefined && job) this.chooseInput(data, job);
    else if (matchesKey(data, "escape")) {
      this.close();
      return;
    } else if (data === "v" && job) {
      const ids = this.nodeIds(job);
      this.choosing = ids.find(id => (job.result?.nodes ?? job.live.nodes)[id]?.status === "running") ?? ids[0];
    } else if (matchesKey(data, "left") || matchesKey(data, "right")) {
      const step = matchesKey(data, "right") ? 1 : -1;
      this.selected = jobs[(index + step + jobs.length) % jobs.length]?.jobId;
      this.offset = 0;
    } else this.scroll(data);
    if (data === "c" && this.selected) this.jobs.cancel(this.selected);
    this.refresh();
  }

  private chooseInput(data: string, job: JobSnapshot): void {
    const ids = this.nodeIds(job);
    const at = Math.max(0, ids.indexOf(this.choosing!));
    if (matchesKey(data, "escape") || matchesKey(data, "backspace")) this.choosing = undefined;
    else if (matchesKey(data, "up") || matchesKey(data, "left")) this.choosing = ids[(at - 1 + ids.length) % ids.length];
    else if (matchesKey(data, "down") || matchesKey(data, "right")) this.choosing = ids[(at + 1) % ids.length];
    else if (matchesKey(data, "enter") && this.choosing !== undefined) this.open(job, this.choosing);
    else this.scroll(data);
  }

  private sessionInput(data: string, job: JobSnapshot | undefined): void {
    if (matchesKey(data, "escape") || matchesKey(data, "backspace")) {
      // Return to selection on the same node, so another node is one keypress away.
      const focus = this.focus!;
      let nodeId: string | undefined;
      try { nodeId = job && ("nodeId" in focus ? focus.nodeId : this.jobs.getNode(job.jobId, undefined, focus.executionId).id); }
      catch { /* The node was removed; fall back to the plain graph. */ }
      this.focus = undefined;
      this.choosing = nodeId !== undefined && job && this.nodeIds(job).includes(nodeId) ? nodeId : undefined;
      this.offset = 0;
    } else if ((matchesKey(data, "left") || matchesKey(data, "right")) && job) {
      let node;
      try { node = "nodeId" in this.focus! ? this.jobs.getNode(job.jobId, this.focus.nodeId) : this.jobs.getNode(job.jobId, undefined, this.focus!.executionId); }
      catch { return; }
      const siblings = this.executionsOf(job, node.id);
      const at = node.executionId ? siblings.indexOf(node.executionId) : -1;
      const next = siblings[at + (matchesKey(data, "right") ? 1 : -1)];
      if (next) { this.focus = { executionId: next }; this.follow = true; }
    } else if (matchesKey(data, "end")) this.follow = true;
    else if (matchesKey(data, "ctrl+o")) this.session.toggleExpanded();
    else this.scroll(data);
  }

  private scroll(data: string): void {
    const before = this.offset;
    if (matchesKey(data, "up")) this.offset = Math.max(0, this.offset - 1);
    else if (matchesKey(data, "down")) this.offset = Math.min(this.maxOffset, this.offset + 1);
    else if (matchesKey(data, "pageUp")) this.offset = Math.max(0, this.offset - 10);
    else if (matchesKey(data, "pageDown")) this.offset = Math.min(this.maxOffset, this.offset + 10);
    else if (matchesKey(data, "home")) this.offset = 0;
    else return;
    // Scrolling up pauses following; reaching the bottom resumes it.
    if (this.offset < before) this.follow = false;
    else if (this.offset >= this.maxOffset) this.follow = true;
  }

  private close(): void {
    this.dispose();
    this.done();
  }

  invalidate(): void {}

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.ticker);
    this.unsubscribe();
  }
}

export function registerBraidWidget(pi: ExtensionAPI, jobs: BraidJobs): () => void {
  let dispose = () => {};
  const clear = () => {
    dispose();
    dispose = () => {};
  };
  pi.on("session_start", (_event, ctx) => {
    clear();
    if (ctx.mode !== "tui") return;
    const refresh = () => {
      if (!jobs.list().length) {
        ctx.ui.setWidget("braid-status", undefined);
        return;
      }
      ctx.ui.setWidget("braid-status", (_tui, theme) => ({
        render(width) {
          const all = jobs.list();
          const active = all.filter(job => job.status === "running");
          const selected = active.length ? active.slice(0, 3) : all.slice(0, 1);
          const lines = selected.map(job => {
            const progress = jobs.progress(job.jobId)!;
            const status = job.status === "running" && progress.paused && !progress.running.length
              ? "paused" : job.status;
            const color = status === "completed" ? "success"
              : status === "failed" ? "error"
              : status === "cancelled" ? "muted" : "warning";
            const parts = [
              theme.fg("accent", `Braid ${job.handle}`),
              theme.fg(color, status),
              `${progress.done}/${progress.total} done`,
            ];
            if (progress.failed) parts.push(theme.fg("error", `${progress.failed} failed`));
            if (progress.paused && status !== "paused")
              parts.push(theme.fg("warning", `${progress.paused} paused`));
            parts.push(plain(progress.running.length ? progress.running.join(", ") : job.goal));
            return truncateToWidth(parts.join(" · "), width, "…");
          });
          if (active.length > selected.length) lines.push(truncateToWidth(
            theme.fg("muted", `Braid · +${active.length - selected.length} active jobs · /braid details`),
            width, "…",
          ));
          return lines;
        },
        invalidate() {},
      }), { placement: "aboveEditor" });
    };
    const unsubscribe = jobs.subscribe(refresh);
    dispose = () => {
      unsubscribe();
      ctx.ui.setWidget("braid-status", undefined);
    };
    refresh();
  });
  return clear;
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
