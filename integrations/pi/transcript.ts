import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/** What the worker received, summarized; the raw request JSON is not a readable message. */
export interface PiTranscriptIntro {
  prompt: string;
  goal: string;
  predecessors: number;
  workspace: string;
}

/** Partial output of a running tool, as Pi tools report it through onUpdate. */
export interface PiToolPartial {
  content: ToolResultMessage["content"];
  details?: unknown;
}

/** One worker conversation, in the shapes Pi's own chat components render. */
export interface PiTranscript {
  executionId: string;
  nodeId: string;
  cwd: string;
  intro: PiTranscriptIntro;
  /** Completed assistant messages and tool results, in order. */
  messages: (AssistantMessage | ToolResultMessage)[];
  /** The assistant message being streamed; Pi mutates it in place. */
  streaming?: AssistantMessage;
  /** Tools that started and have not returned, with their latest partial output. */
  running: Map<string, PiToolPartial | undefined>;
  /** Renderers for tools with Pi definitions (read, bash, edit, …). */
  renderers: ReadonlyMap<string, ToolDefinition>;
  /** Increments on every change, so views can skip identical frames. */
  version: number;
  finished: boolean;
}

/**
 * Live worker conversations keyed by execution ID. Running executions and the
 * newest finished ones are retained; older transcripts are dropped to bound memory.
 */
export class PiTranscripts {
  private readonly transcripts = new Map<string, PiTranscript>();
  private readonly finishedIds: string[] = [];
  private pending: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly onChange: () => void = () => {},
    private readonly maxFinished = 20,
  ) {}

  get(executionId: string): PiTranscript | undefined {
    return this.transcripts.get(executionId);
  }

  start(executionId: string, nodeId: string, cwd: string, intro: PiTranscriptIntro, renderers: ReadonlyMap<string, ToolDefinition>): void {
    this.transcripts.set(executionId, {
      executionId, nodeId, cwd, intro, messages: [], running: new Map(), renderers, version: 0, finished: false,
    });
    this.changed();
  }

  streaming(executionId: string, partial: AssistantMessage): void {
    this.update(executionId, transcript => { transcript.streaming = partial; }, true);
  }

  assistant(executionId: string, message: AssistantMessage): void {
    this.update(executionId, transcript => {
      delete transcript.streaming;
      transcript.messages.push(message);
    });
  }

  toolStart(executionId: string, callId: string): void {
    this.update(executionId, transcript => { transcript.running.set(callId, undefined); });
  }

  toolUpdate(executionId: string, callId: string, partial: PiToolPartial): void {
    this.update(executionId, transcript => {
      if (transcript.running.has(callId)) transcript.running.set(callId, partial);
    }, true);
  }

  toolResult(executionId: string, result: ToolResultMessage): void {
    this.update(executionId, transcript => {
      transcript.running.delete(result.toolCallId);
      transcript.messages.push(result);
    });
  }

  /** Close interrupted streams and tools so the view does not show them as still running. */
  finish(executionId: string | undefined, reason = "Execution ended before this step finished"): void {
    if (executionId === undefined) return;
    this.update(executionId, transcript => {
      if (transcript.streaming) {
        transcript.messages.push({ ...transcript.streaming, stopReason: "aborted", errorMessage: reason });
        delete transcript.streaming;
      }
      for (const callId of transcript.running.keys()) {
        const call = transcript.messages.flatMap(message => message.role === "assistant" ? message.content : [])
          .find(block => block.type === "toolCall" && block.id === callId);
        transcript.messages.push({
          role: "toolResult", toolCallId: callId, toolName: call?.type === "toolCall" ? call.name : "tool",
          content: [{ type: "text", text: reason }], isError: true, timestamp: Date.now(),
        });
      }
      transcript.running.clear();
      transcript.finished = true;
      if (!this.finishedIds.includes(executionId)) this.finishedIds.push(executionId);
      while (this.finishedIds.length > this.maxFinished) this.transcripts.delete(this.finishedIds.shift()!);
    });
  }

  /** Token and output bursts coalesce into at most one notification per 100 ms. */
  private update(executionId: string, change: (transcript: PiTranscript) => void, burst = false): void {
    const transcript = this.transcripts.get(executionId);
    if (!transcript || transcript.finished) return;
    try {
      change(transcript);
      transcript.version++;
    } catch {
      // Display state must never affect node execution.
    }
    if (!burst) this.changed();
    else if (!this.pending) {
      this.pending = setTimeout(() => this.changed(), 100);
      this.pending.unref?.();
    }
  }

  private changed(): void {
    clearTimeout(this.pending);
    this.pending = undefined;
    try { this.onChange(); }
    catch { /* Observers cannot fail a worker. */ }
  }
}
