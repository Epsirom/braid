import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  matchesKey,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type AutocompleteItem,
  type Component,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { BraidJobs, type JobSnapshot } from "./jobs.js";
import { executionLayout, renderGraphResult, renderNodeDetails, renderSessionHeader, SELECTED_NODE_MARK, type GraphView } from "./display.js";
import { NodeSessionView } from "./session-view.js";
import type { AssistantModel } from "./assistant.js";
import type { NodeExecution } from "@chrok/braid";

// Match the overlay height exactly so Pi never clips the footer or bottom border.
const panelHeight = (rows: number): number =>
  Math.max(1, Math.floor(rows * 0.9));

const plain = (value: string): string =>
  stripTerminalSequences(value).replace(/\p{Cc}/gu, " ");

/** Below this content width the graph and the assistant share the body, switched with Tab. */
const SPLIT_WIDTH = 100;
/** Marks a separator row so it can span the whole panel or only the left column. */
const SEPARATOR = "\u0000separator";

/** A node definition (latest invocation) or one exact execution. */
export type NodeFocus = { nodeId: string } | { executionId: string };

/**
 * A live, scrollable panel. Esc steps back one level: session → node selection →
 * graph → close. Closing the panel leaves jobs running. Tab toggles an assistant
 * that answers questions about the job and can message running executions. g
 * switches between the live executions and the timeline of every execution.
 */
export class BraidPanel implements Component {
  private selected: string | undefined;
  private focus: NodeFocus | undefined;
  /** Execution highlighted in selection mode (`v`); undefined in the plain graph view. */
  private choosing: string | undefined;
  /** Kept for the life of the panel, across jobs and sessions. */
  private view: GraphView = "live";
  /** The timeline expands every generation instead of the most recent ones. */
  private allHistory = false;
  /** Keep the newest transcript lines in view until the user scrolls up. */
  private follow = true;
  /** The selection last scrolled into view, so manual scrolling is not overridden. */
  private revealed: string | undefined;
  private offset = 0;
  private maxOffset = 0;
  private disposed = false;
  /** While open, the assistant receives keys; it shares a wide panel and fills a narrow one. */
  private assistantOpen = false;
  /** Where the body sits in the last frame, for routing mouse wheel events. */
  private layout: { top: number; height: number; chatLeft?: number } | undefined;
  /** Assistant lines scrolled up from the newest. */
  private chatOffset = 0;
  private chatMaxOffset = 0;
  private chatScope: string | undefined;
  /** The outcome of the last pause, resume, or cancel key, until the next key. */
  private notice: string | undefined;
  /** An execution x was pressed for once; a second x cancels it. */
  private cancelling: string | undefined;
  private readonly input: Input;
  private readonly session: NodeSessionView;
  private readonly chat: NodeSessionView;
  private readonly unsubscribe: () => void;
  private readonly ticker: ReturnType<typeof setInterval>;

  constructor(
    private readonly jobs: BraidJobs,
    private readonly tui: Pick<TUI, "requestRender" | "terminal">,
    private readonly theme: Theme,
    private readonly done: () => void,
    jobId?: string,
    focus?: NodeFocus,
    private readonly assistantModel: () => AssistantModel = () => ({ registry: { complete: () => Promise.reject(new Error("No Pi model registry")) } }),
  ) {
    this.selected = jobId ? jobs.get(jobId)?.jobId ?? jobId : undefined;
    this.focus = focus;
    // Pi's tool components only request renders through the TUI.
    this.session = new NodeSessionView(tui as TUI, theme);
    this.chat = new NodeSessionView(tui as TUI, theme);
    this.input = new Input({
      prompt: theme.fg("accent", "› "),
      placeholder: "Ask, or say how to steer…",
      placeholderStyle: text => theme.fg("dim", text),
    });
    this.input.onSubmit = value => {
      if (!value.trim() || !this.selected) return;
      const job = this.jobs.get(this.selected);
      if (!job) return;
      this.jobs.assistant(job.jobId, this.assistantNode(job)).send(value, this.describeView(job), this.assistantModel());
      this.input.setValue("");
      this.chatOffset = 0;
      this.refresh();
    };
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
      : this.choosing !== undefined ? "select an execution" : "";
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
        rule("╭", "╮", `Braid · ${this.view} view`),
        ...compact.slice(0, rows - 3).map(row),
        row("Esc close"),
        rule("╰", "╯"),
      ];
    }
    const title = `Braid · ${this.view} view`;
    const header = [
      rule("╭", "╮", title),
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
      // A finished execution leaves the live view: follow its node's next one, if any.
      const nodeId = this.executions(current)[this.choosing]?.id;
      const ids = this.nodeIds(current);
      this.choosing = ids.find(id => this.executions(current)[id]?.id === nodeId) ?? (this.view === "timeline" ? ids.at(-1) : ids[0]);
    }
    if (!current) this.assistantOpen = false;
    const available = rows - header.length - 4;
    const open = current !== undefined && this.assistantOpen;
    const split = open && contentWidth >= SPLIT_WIDTH;
    const leftWidth = split ? Math.floor((contentWidth - 3) * 0.6) : contentWidth;
    const chatWidth = split ? contentWidth - leftWidth - 3 : contentWidth;
    const graph = !open || split ? this.renderGraphPane(current, leftWidth, available) : undefined;
    const chat = open ? this.renderAssistant(current, chatWidth, available) : [];
    // Columns: border and gutter, then the left pane, " │ ", then the assistant.
    this.layout = { top: header.length, height: available,
      ...(open ? { chatLeft: split ? 2 + leftWidth + 3 : 2 } : {}) };
    const body = split
      ? graph!.lines.map((line, at) =>
        (line === SEPARATOR ? border("─".repeat(leftWidth)) : truncateToWidth(line, leftWidth, "…", true)) +
        " " + border("│") + " " + (chat[at] ?? ""))
      : graph?.lines ?? chat;
    const tab = current ? "Tab assistant   " : "";
    const timeline = this.view === "timeline";
    const toggle = timeline ? "g live view" : "g timeline view";
    const expand = timeline ? `   e ${this.allHistory ? "recent" : "all"} history` : "";
    const noun = "execution";
    // Longest first; the footer shows the first that fits.
    const hints = open
      ? ["Enter send   Esc stop or hide   Tab hide   PgUp/PgDn or wheel scroll   ctrl+c close",
        "Enter send · Esc hide · Tab hide", "Enter send · Tab hide"]
      : this.focus
      ? [`${tab}Esc back   ←/→ executions   ↑/↓ scroll   End follow   ctrl+o tools   p pause   h hold   x cancel execution   c cancel job   q close`,
        "Esc back   ←/→ executions   ↑/↓ scroll   End follow   ctrl+o tools   p pause   h hold   x cancel   q close",
        "Esc back · ←/→ executions · p pause · q close", "Esc back · q close"]
      : this.choosing !== undefined
      ? [`${tab}↑/↓/←/→ choose ${noun}   Enter open session   ${toggle}${expand}   p pause   h hold   x cancel execution   Esc back   PgUp/PgDn page   q close`,
        `↑/↓ choose ${noun}   Enter open session   ${toggle}${expand}   p pause   h hold   x cancel   Esc back`,
        `↑/↓ choose · Enter open · ${toggle} · Esc back`, "Enter open · Esc back"]
      : [`${tab}v select ${noun}   ${toggle}${expand}   ←/→ jobs   ↑/↓ scroll   p pause job   c cancel   Esc close`,
        `v select ${noun}   ${toggle}${expand}   ←/→ jobs   p pause job   c cancel   Esc close`,
        `v select · ${toggle} · ←/→ jobs · Esc close`, `v select · g ${timeline ? "live" : "timeline"} · Esc close`];
    const help = hints.find(hint => visibleWidth(hint) <= contentWidth) ?? hints.at(-1)!;
    const status = graph ? graph.range : "Assistant";
    return [
      ...header,
      ...body.map(line => line === SEPARATOR ? rule("├", "┤") : row(line)),
      rule("├", "┤"),
      row(
        this.theme.fg(
          "dim",
          this.notice ? plain(this.notice) : `${status}${contentWidth >= 60 ? "  ·  Jobs keep running when this panel closes" : ""}`,
        ),
      ),
      row(this.theme.fg("muted", help)),
      rule("╰", "╯"),
    ];
  }

  /** The graph, node selection, or a node session: pinned summary, separator, scrolled body. */
  private renderGraphPane(current: JobSnapshot | undefined, width: number, available: number): { lines: string[]; range: string } {
    // The node summary (or the selected node) stays pinned while the body scrolls.
    const focused = current && this.focus ? this.renderFocus(current, this.focus, width) : undefined;
    let pinned = focused?.pinned ?? (current && this.choosing !== undefined ? [this.choosingLine(current)] : []);
    const maxPinned = Math.max(2, Math.floor(available / 2));
    if (pinned.length > maxPinned) {
      pinned = [...pinned.slice(0, maxPinned - 1), this.theme.fg("dim", `… ${pinned.length - maxPinned + 1} more summary lines`)];
    }
    const content = focused
      ? [...focused.body, ...(current && focused.executionId ? this.pendingLines(current, focused.executionId) : [])]
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
              executions: this.executions(current),
            },
            true,
            false,
            this.theme,
            "",
            false,
            this.choosing,
            { view: this.view, allHistory: this.allHistory },
          ).render(width),
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
    return {
      lines: [...(pinned.length ? [...pinned, SEPARATOR] : []), ...body],
      range: `Lines ${this.offset + 1}–${Math.min(content.length, this.offset + height)}/${content.length}`,
    };
  }

  /** The job's assistant conversation, newest lines at the bottom, above its input line. */
  private renderAssistant(job: JobSnapshot, width: number, height: number): string[] {
    const nodeId = this.assistantNode(job);
    const assistant = this.jobs.assistant(job.jobId, nodeId);
    // Each scope has its own conversation; a new one starts at its newest lines.
    const scope = JSON.stringify([job.jobId, nodeId ?? null]);
    if (scope !== this.chatScope) {
      this.chatScope = scope;
      this.chatOffset = 0;
    }
    const title = this.theme.fg("accent", this.theme.bold(nodeId === undefined ? "Assistant · job" : `Assistant · node ${plain(nodeId)}`)) +
      this.theme.fg("muted", assistant.busy ? " · working… Esc to stop" : " · Tab to hide");
    let lines: string[];
    try {
      lines = assistant.conversation.messages.length
        ? this.chat.render(assistant.conversation, width)
        : [
            // Wrapped, not truncated, and kept off the input line like a finished reply.
            ...[
              nodeId === undefined
                ? "Ask what a node is doing, why it failed, or what it produced."
                : `Ask what ${plain(nodeId)} is doing, why it failed, or what it produced.`,
              "To change a running execution's direction, say what it should do; the assistant messages that execution for you.",
            ].flatMap(hint => wrapTextWithAnsi(this.theme.fg("dim", hint), width)),
            "",
          ];
    } catch (error) {
      lines = [this.theme.fg("error", `Assistant view unavailable: ${plain(error instanceof Error ? error.message : String(error))}`)];
    }
    const visible = Math.max(1, height - 3);
    this.chatMaxOffset = Math.max(0, lines.length - visible);
    this.chatOffset = Math.min(this.chatOffset, this.chatMaxOffset);
    const end = lines.length - this.chatOffset;
    const body = lines.slice(Math.max(0, end - visible), end);
    while (body.length < visible) body.unshift("");
    this.input.focused = true;
    const input = this.input.render(width)[0] ?? "";
    return [title, this.theme.fg("borderMuted", "─".repeat(width)), ...body, input].slice(0, height);
  }

  /** Messages the assistant sent that this execution has not received yet. */
  private pendingLines(job: JobSnapshot, executionId: string): string[] {
    let pending: readonly { text: string }[] = [];
    try { pending = this.jobs.pendingInputs(job.jobId, executionId); }
    catch { /* The job was removed; show nothing. */ }
    if (!pending.length) return [];
    return [
      ...pending.map(input => this.theme.fg("warning", `⧗ pending human input · ${plain(input.text)}`)),
      this.theme.fg("dim", "  Delivered before the worker's next model request; running tools are not interrupted."),
    ];
  }

  /** The node whose conversation the assistant shows: the open session's, or the selected one. */
  private assistantNode(job: JobSnapshot): string | undefined {
    if (!this.focus) return this.choosing === undefined ? undefined : this.executions(job)[this.choosing]?.id;
    if ("nodeId" in this.focus) return this.focus.nodeId;
    try { return this.jobs.getNode(job.jobId, undefined, this.focus.executionId).id; }
    catch { return undefined; }
  }

  /** What the user is looking at, so "this node" means something to the assistant. */
  private describeView(job: JobSnapshot): string {
    if (this.focus) {
      try {
        const node = "nodeId" in this.focus ? this.jobs.getNode(job.jobId, this.focus.nodeId) : this.jobs.getNode(job.jobId, undefined, this.focus.executionId);
        return `session of node ${JSON.stringify(node.id)}${node.executionId ? `, execution ${node.executionId}` : ""} (${node.status})`;
      } catch {
        return "a node that is no longer in the graph";
      }
    }
    const scope = this.view === "live" ? "live executions (pending, running, held)" : "timeline of every execution";
    if (this.choosing !== undefined) {
      const execution = this.executions(job)[this.choosing];
      return `job graph, ${scope}, with execution ${this.choosing} of node ${JSON.stringify(execution?.id)} selected (${execution?.status ?? "unknown"})`;
    }
    return `job graph, ${scope} (${job.status})`;
  }

  /** Every instance of the job, oldest first, including removed and superseded ones. */
  private executions(job: JobSnapshot): Record<string, NodeExecution> {
    return job.result?.executions ?? job.execution?.executions ?? {};
  }

  /** The executions the current view draws, in the flowchart's declaration order. */
  private nodeIds(job: JobSnapshot): string[] {
    return executionLayout(this.executions(job), this.view, this.allHistory).shown.map(record => record.executionId);
  }

  private choosingLine(job: JobSnapshot): string {
    const execution = this.choosing === undefined ? undefined : this.executions(job)[this.choosing];
    const ids = this.nodeIds(job);
    return this.theme.fg("warning", `${SELECTED_NODE_MARK} Selected ${ids.indexOf(this.choosing ?? "") + 1}/${ids.length}: `) +
      this.theme.bold(plain(this.choosing ?? "")) + this.theme.fg("muted", ` · ${execution?.status ?? "pending"} · Enter to open this execution's session`);
  }

  /**
   * g switches views. A selection that the other view also draws stays; otherwise
   * it moves to the newest drawn execution of the same node, or selection ends.
   * Leaving a session does the same.
   */
  private toggleView(job: JobSnapshot | undefined): void {
    this.view = this.view === "live" ? "timeline" : "live";
    this.offset = 0;
    this.revealed = undefined;
    if (this.choosing === undefined || !job) return;
    const nodeId = this.executions(job)[this.choosing]?.id;
    this.choosing = nodeId === undefined ? undefined : this.drawn(job, nodeId, this.choosing);
  }

  /** The execution if the current view draws it, otherwise the newest drawn one of its node. */
  private drawn(job: JobSnapshot, nodeId: string, executionId: string | undefined): string | undefined {
    const ids = this.nodeIds(job);
    if (executionId !== undefined && ids.includes(executionId)) return executionId;
    return ids.filter(id => this.executions(job)[id]?.id === nodeId).at(-1);
  }

  /** A focused node can disappear after a live graph update; say so instead of failing. */
  private renderFocus(job: JobSnapshot, focus: NodeFocus, width: number): { pinned: string[]; body: string[]; executionId?: string } {
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
    const activity = node.executionId ? this.jobs.getActivity(job.jobId, node.executionId) : undefined;
    const transcript = node.executionId ? this.jobs.getTranscript(job.jobId, node.executionId) : undefined;
    const siblings = this.executionsOf(job, node.id);
    const position = node.executionId ? siblings.indexOf(node.executionId) : -1;
    const header = [
      ...renderSessionHeader(node, this.theme, job.live.observedAt, job.live.progress[node.id], activity),
      ...(siblings.length > 1 ? [this.theme.fg("dim", `execution ${position + 1} of ${siblings.length} for this node · ←/→ to switch`)] : []),
    ];
    let failure: string | undefined;
    if (transcript) {
      try {
        return { pinned: header, body: this.session.render(transcript, width), executionId: node.executionId! };
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

  private open(executionId: string): void {
    this.focus = { executionId };
    this.follow = true;
    this.offset = 0;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "ctrl+c")) {
      this.close();
      return;
    }
    if (matchesKey(data, "tab") && this.selected) {
      this.assistantOpen = !this.assistantOpen;
      this.refresh();
      return;
    }
    if (this.assistantOpen) {
      this.assistantInput(data);
      this.refresh();
      return;
    }
    if (data === "q") {
      this.close();
      return;
    }
    const jobs = this.jobs.list();
    const index = Math.max(
      0,
      jobs.findIndex((job) => job.jobId === this.selected),
    );
    const job = this.selected ? this.jobs.get(this.selected) : undefined;
    this.notice = undefined;
    const confirming = this.cancelling;
    this.cancelling = undefined;
    if (data === "p" && job) {
      this.togglePause(job);
      this.refresh();
      return;
    }
    if (data === "h" && job && (this.focus || this.choosing !== undefined)) {
      this.toggleHold(job);
      this.refresh();
      return;
    }
    if (data === "x" && job && (this.focus || this.choosing !== undefined)) {
      this.cancelExecution(job, confirming);
      this.refresh();
      return;
    }
    if (!this.focus && data === "g") this.toggleView(job);
    else if (!this.focus && data === "e" && this.view === "timeline") {
      this.allHistory = !this.allHistory;
      this.notice = this.allHistory ? "Showing every generation" : "Showing recent generations · older settled executions are folded";
    } else if (this.focus) this.sessionInput(data, job);
    else if (this.choosing !== undefined && job) this.chooseInput(data, job);
    else if (matchesKey(data, "escape")) {
      this.close();
      return;
    } else if (data === "v" && job) {
      const ids = this.nodeIds(job);
      // Start at a running execution; otherwise the timeline starts at the newest one.
      this.choosing = ids.find(id => this.executions(job)[id]?.status === "running") ?? (this.view === "timeline" ? ids.at(-1) : ids[0]);
      if (this.choosing === undefined) this.notice = "Nothing to select · press g for the timeline";
    } else if (matchesKey(data, "left") || matchesKey(data, "right")) {
      const step = matchesKey(data, "right") ? 1 : -1;
      this.selected = jobs[(index + step + jobs.length) % jobs.length]?.jobId;
      this.offset = 0;
    } else this.scroll(data);
    if (data === "c" && this.selected) this.jobs.cancel(this.selected);
    this.refresh();
  }

  /**
   * p pauses or resumes what is in view: the open execution, the selected
   * node's latest execution, or the whole job. The parent agent gets a notice.
   */
  private togglePause(job: JobSnapshot): void {
    const execution = job.execution;
    try {
      if (!execution || job.status !== "running") throw new Error("Only a running job can be paused");
      const executionId = this.executionInView(job);
      if (!this.focus && this.choosing === undefined) {
        if (execution.pause) { this.jobs.resumeJob(job.jobId, "user"); this.notice = "Job resumed"; }
        else { this.jobs.pause(job.jobId, undefined, "user"); this.notice = "Job paused · no new executions start; running ones stop before their next model request"; }
        return;
      }
      if (!executionId) throw new Error("This node has not run yet");
      const record = execution.executions[executionId];
      if (record?.suspension && record.suspension.state !== "resuming") {
        this.jobs.resume(job.jobId, [executionId], execution.revision, "user");
        this.notice = "Execution resumed";
      } else {
        this.jobs.pause(job.jobId, [executionId], "user");
        this.notice = "Pausing · the execution stops before its next model request";
      }
    } catch (error) {
      this.notice = `Cannot pause or resume: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /**
   * h toggles the hold on the execution in view: a running one keeps running and
   * is held when it finishes; a held result is released. The parent agent gets a notice.
   */
  private toggleHold(job: JobSnapshot): void {
    const execution = job.execution;
    try {
      if (!execution || job.status !== "running") throw new Error("Only a running job can hold results");
      const executionId = this.executionInView(job);
      if (!executionId) throw new Error("This node has not run yet");
      if (execution.pausedExecutionIds.includes(executionId)) {
        this.jobs.resume(job.jobId, [executionId], execution.revision, "user");
        this.notice = "Released · the result goes downstream";
      } else if (execution.executions[executionId]?.holdAfter) {
        this.jobs.holdAfter(job.jobId, [executionId], false, "user");
        this.notice = "Hold removed · the result goes downstream when the execution finishes";
      } else {
        this.jobs.holdAfter(job.jobId, [executionId], true, "user");
        this.notice = "Holding · the execution keeps running; its result waits for release when it finishes";
      }
    } catch (error) {
      this.notice = `Cannot hold or release: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /** The open execution, the selected execution, or the selected node's latest one. */
  private executionInView(job: JobSnapshot): string | undefined {
    if (this.focus) return "executionId" in this.focus ? this.focus.executionId : this.executionsOf(job, this.focus.nodeId).at(-1);
    return this.choosing;
  }

  /**
   * x cancels the execution in view after a second x: only it fails, and its
   * successors follow the usual failure rules. The parent agent gets a notice.
   */
  private cancelExecution(job: JobSnapshot, confirming: string | undefined): void {
    try {
      if (!job.execution || job.status !== "running") throw new Error("The job is not running");
      const executionId = this.executionInView(job);
      if (!executionId) throw new Error("This node has not run yet");
      if (confirming !== executionId) {
        this.cancelling = executionId;
        this.notice = "Press x again to cancel this execution · it fails and its successors follow the failure rules";
        return;
      }
      this.jobs.cancelExecutions(job.jobId, [executionId], "user");
      this.notice = "Execution cancelled";
    } catch (error) {
      this.notice = `Cannot cancel: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private chooseInput(data: string, job: JobSnapshot): void {
    const ids = this.nodeIds(job);
    const at = Math.max(0, ids.indexOf(this.choosing!));
    if (matchesKey(data, "escape") || matchesKey(data, "backspace")) this.choosing = undefined;
    else if (matchesKey(data, "up") || matchesKey(data, "left")) this.choosing = ids[(at - 1 + ids.length) % ids.length];
    else if (matchesKey(data, "down") || matchesKey(data, "right")) this.choosing = ids[(at + 1) % ids.length];
    else if (matchesKey(data, "enter") && this.choosing !== undefined) this.open(this.choosing);
    else this.scroll(data);
  }

  private sessionInput(data: string, job: JobSnapshot | undefined): void {
    if (matchesKey(data, "escape") || matchesKey(data, "backspace")) {
      // Return to selection on the same execution, so another is one keypress away.
      const focus = this.focus!;
      let node;
      try {
        node = job && ("nodeId" in focus ? this.jobs.getNode(job.jobId, focus.nodeId) : this.jobs.getNode(job.jobId, undefined, focus.executionId));
      } catch { /* The node was removed; fall back to the plain graph. */ }
      this.focus = undefined;
      this.choosing = node && job ? this.drawn(job, node.id, node.executionId) : undefined;
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

  /** The wheel scrolls whichever side it is over; other mouse events are left to Pi. */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const layout = this.layout;
    if (event.type !== "wheel" || !event.wheelDelta || !layout) return undefined;
    if (event.y < layout.top || event.y >= layout.top + layout.height) return undefined;
    if (layout.chatLeft !== undefined && event.x >= layout.chatLeft - 1) {
      this.chatOffset = Math.max(0, Math.min(this.chatMaxOffset, this.chatOffset - event.wheelDelta));
    } else {
      const before = this.offset;
      this.offset = Math.max(0, Math.min(this.maxOffset, this.offset + event.wheelDelta));
      if (this.offset < before) this.follow = false;
      else if (this.offset >= this.maxOffset) this.follow = true;
    }
    this.refresh();
    return { handled: true };
  }

  /** Every key belongs to the question, including q and c. */
  private assistantInput(data: string): void {
    const job = this.selected ? this.jobs.get(this.selected) : undefined;
    const assistant = job ? this.jobs.assistant(job.jobId, this.assistantNode(job)) : undefined;
    if (matchesKey(data, "escape")) {
      if (assistant?.busy) assistant.abort();
      else this.assistantOpen = false;
    } else if (matchesKey(data, "pageUp")) this.chatOffset = Math.min(this.chatMaxOffset, this.chatOffset + 10);
    else if (matchesKey(data, "pageDown")) this.chatOffset = Math.max(0, this.chatOffset - 10);
    else this.input.handleInput(data);
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
  // Clearing hides the jobs present at that moment; jobs submitted later still show.
  const cleared = new Set<string>();
  let lastCleared: string[] = [];
  const shown = () => jobs.list().filter(job => !cleared.has(job.jobId));
  let refresh = () => {};
  let dispose = () => {};
  const clear = () => {
    dispose();
    dispose = () => {};
    refresh = () => {};
  };
  pi.registerCommand("braid:clear", {
    description: "Clear the Braid progress widget; run again while it is empty to restore it",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui")
        throw new Error("The Braid progress widget requires interactive Pi.");
      const visible = shown();
      if (visible.length) {
        lastCleared = visible.map(job => job.jobId);
        for (const jobId of lastCleared) cleared.add(jobId);
        ctx.ui.notify("Cleared Braid progress. Run /braid:clear again to restore it.", "info");
      } else if (lastCleared.length) {
        for (const jobId of lastCleared) cleared.delete(jobId);
        lastCleared = [];
        ctx.ui.notify("Restored Braid progress.", "info");
      } else {
        ctx.ui.notify("No Braid progress to clear.", "info");
        return;
      }
      refresh();
    },
  });
  pi.on("session_start", (_event, ctx) => {
    clear();
    if (ctx.mode !== "tui") return;
    refresh = () => {
      if (!shown().length) {
        ctx.ui.setWidget("braid-status", undefined);
        return;
      }
      ctx.ui.setWidget("braid-status", (_tui, theme) => ({
        render(width) {
          const all = shown();
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
    const unsubscribe = jobs.subscribe(() => refresh());
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
            // The assistant uses whichever model the main session has selected when asked.
            panel = new BraidPanel(jobs, tui, theme, done, jobId, focus,
              () => ({ registry: ctx.modelRegistry, ...(ctx.model ? { model: ctx.model } : {}) }));
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
