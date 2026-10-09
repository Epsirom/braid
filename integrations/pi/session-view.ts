import {
  AssistantMessageComponent,
  getMarkdownTheme,
  ToolExecutionComponent,
  UserMessageComponent,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences, Text, type TUI } from "@earendil-works/pi-tui";
import type { PiTranscript } from "./transcript.js";

const plain = (value: string): string => stripTerminalSequences(value).replace(/\p{Cc}/gu, " ");

/**
 * Renders a worker conversation with Pi's own chat components, applying only
 * what changed since the last sync, the way Pi's interactive mode streams.
 */
export class NodeSessionView {
  private readonly chat = new Container();
  private transcript: PiTranscript | undefined;
  private version = -1;
  private rendered = 0;
  private streaming: AssistantMessageComponent | undefined;
  private readonly tools = new Map<string, ToolExecutionComponent>();
  private readonly partials = new Map<string, unknown>();
  private expanded = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Pick<Theme, "fg">,
  ) {}

  /** Tool output expansion, like Pi's ctrl+o. */
  toggleExpanded(): void {
    this.expanded = !this.expanded;
    for (const tool of this.tools.values()) tool.setExpanded(this.expanded);
    this.version = -1;
  }

  render(transcript: PiTranscript, width: number): string[] {
    this.sync(transcript);
    // Pi marks its own prompts for terminal shell integration; these are not prompts.
    return this.chat.render(width).map(line => line.replace(/\x1b\]133;[^\x07\x1b]*(?:\x07|\x1b\\)/g, ""));
  }

  private sync(transcript: PiTranscript): void {
    if (transcript !== this.transcript) this.reset(transcript);
    if (transcript.version === this.version) return;
    this.version = transcript.version;
    for (; this.rendered < transcript.messages.length; this.rendered++) {
      const message = transcript.messages[this.rendered]!;
      if (message.role === "toolResult") {
        this.tools.get(message.toolCallId)?.updateResult(message);
        this.partials.delete(message.toolCallId);
        continue;
      }
      // The final message replaces the streamed partial in the same component.
      const component = this.streaming ?? this.add(new AssistantMessageComponent(undefined, false, getMarkdownTheme()));
      this.streaming = undefined;
      component.updateContent(message, false);
      this.toolCalls(message, transcript, true);
    }
    if (transcript.streaming) {
      this.streaming ??= this.add(new AssistantMessageComponent(undefined, false, getMarkdownTheme()));
      this.streaming.updateContent(transcript.streaming, true);
      this.toolCalls(transcript.streaming, transcript, false);
    }
    for (const [callId, partial] of transcript.running) {
      const tool = this.tools.get(callId);
      if (!tool || this.partials.get(callId) === partial) continue;
      this.partials.set(callId, partial);
      tool.markExecutionStarted();
      if (partial) tool.updateResult({ ...partial, isError: false }, true);
    }
  }

  private toolCalls(message: NonNullable<PiTranscript["streaming"]>, transcript: PiTranscript, complete: boolean): void {
    for (const block of message.content) {
      if (block.type !== "toolCall") continue;
      let tool = this.tools.get(block.id);
      if (!tool) {
        tool = new ToolExecutionComponent(block.name, block.id, block.arguments, undefined,
          transcript.renderers.get(block.name), this.tui, transcript.cwd);
        tool.setExpanded(this.expanded);
        this.tools.set(block.id, tool);
        this.add(tool);
      } else if (!complete) tool.updateArgs(block.arguments);
      if (complete) {
        if (message.stopReason === "aborted" || message.stopReason === "error") {
          tool.updateResult({ content: [{ type: "text", text: message.errorMessage || "Error" }], isError: true });
        } else {
          tool.updateArgs(block.arguments);
          tool.setArgsComplete();
        }
      }
    }
  }

  private reset(transcript: PiTranscript): void {
    this.transcript = transcript;
    this.chat.clear();
    this.tools.clear();
    this.partials.clear();
    this.streaming = undefined;
    this.rendered = 0;
    this.version = -1;
    const intro = transcript.intro;
    this.add(new UserMessageComponent(intro.prompt, getMarkdownTheme()));
    this.add(new Text(this.theme.fg("dim", [
      `goal: ${plain(intro.goal)}`,
      `context: ${intro.predecessors} predecessor output${intro.predecessors === 1 ? "" : "s"} · workspace ${plain(intro.workspace)}`,
    ].join("\n")), 1, 0));
  }

  private add<T extends AssistantMessageComponent | ToolExecutionComponent | UserMessageComponent | Text>(component: T): T {
    this.chat.addChild(component);
    return component;
  }
}
