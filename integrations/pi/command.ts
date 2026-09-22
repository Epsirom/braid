import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  stripTerminalSequences,
  truncateToWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import { BraidJobs } from "./jobs.js";
import { renderGraphResult } from "./display.js";

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
    this.selected = jobId;
    this.unsubscribe = jobs.subscribe(() => this.refresh());
    this.ticker = setInterval(() => this.refresh(), 1000);
    this.ticker.unref();
  }

  private refresh(): void {
    if (!this.disposed) this.tui.requestRender();
  }

  render(width: number): string[] {
    const jobs = this.jobs.list();
    const summary = jobs.find((job) => job.jobId === this.selected) ?? jobs[0];
    const current = summary ? this.jobs.get(summary.jobId) : undefined;
    this.selected = current?.jobId;
    const rows = Math.max(4, this.tui.terminal.rows - 2);
    const header = [
      this.theme.fg("accent", this.theme.bold("Braid background jobs")),
      this.theme.fg(
        "dim",
        "←/→ jobs · ↑/↓ scroll · PgUp/PgDn · c cancel job · Esc close",
      ),
    ];
    if (!current)
      return [
        ...header,
        "No Braid jobs in this session. Ask the agent to run a Braid graph.",
      ].map((line) => truncateToWidth(line, width, ""));
    const index = jobs.findIndex((job) => job.jobId === current.jobId);
    header.push(
      this.theme.fg(
        "muted",
        `Job ${index + 1}/${jobs.length} · ${current.status} · ${current.jobId}`,
      ),
    );
    const content = [
      `Goal: ${plain(current.goal)}`,
      ...(current.error ? [this.theme.fg("error", plain(current.error))] : []),
      ...renderGraphResult(
        {
          ...(current.result ?? current.live),
          progress: current.live.progress,
          ...(current.fullOutputPath
            ? { fullOutputPath: current.fullOutputPath }
            : {}),
        },
        true,
        false,
        this.theme,
      ).render(width),
    ];
    const height = Math.max(1, rows - header.length - 1);
    this.maxOffset = Math.max(0, content.length - height);
    this.offset = Math.min(this.offset, this.maxOffset);
    const footer = this.theme.fg(
      "dim",
      `Lines ${this.offset + 1}–${Math.min(content.length, this.offset + height)}/${content.length} · closing this panel keeps jobs running`,
    );
    return [
      ...header,
      ...content.slice(this.offset, this.offset + height),
      footer,
    ].map((line) => truncateToWidth(line, width, ""));
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
        throw new Error(`Unknown Braid job: ${jobId}`);
      let panel: BraidPanel | undefined;
      try {
        await ctx.ui.custom<void>(
          (tui, theme, _keys, done) => {
            panel = new BraidPanel(jobs, tui, theme, done, jobId);
            return panel;
          },
          { overlay: true, overlayOptions: { width: "95%", maxHeight: "95%" } },
        );
      } finally {
        panel?.dispose();
      }
    },
  });
}
