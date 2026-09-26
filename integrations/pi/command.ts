import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import { BraidJobs } from "./jobs.js";
import { renderGraphResult } from "./display.js";

// Match the overlay height exactly so Pi never clips the footer or bottom border.
const panelHeight = (rows: number): number =>
  Math.max(1, Math.floor(rows * 0.9));

const plain = (value: string): string =>
  stripTerminalSequences(value).replace(/\p{Cc}/gu, " ");

/** A live, scrollable panel. Closing the panel leaves jobs running. */
export class BraidPanel implements Component {
  private selected: string | undefined;
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
  ) {
    this.selected = jobId ? jobs.get(jobId)?.jobId ?? jobId : undefined;
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
    const heading = current
      ? `Job ${index + 1} of ${jobs.length}  ·  ${this.theme.fg(statusColor, current.status)}`
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
    const content = current
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
    const help =
      contentWidth >= 72
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
    description: "Open the live background-job flow panel: /braid [jobId]",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui")
        throw new Error(
          "The Braid panel requires interactive Pi. Use braid_status for job status.",
        );
      const jobId = args.trim() || undefined;
      if (jobId && !jobs.get(jobId))
        throw jobs.unknownJob(jobId);
      let panel: BraidPanel | undefined;
      try {
        await ctx.ui.custom<void>(
          (tui, theme, _keys, done) => {
            panel = new BraidPanel(jobs, tui, theme, done, jobId);
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
