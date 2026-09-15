import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const REQUIRED =
  "The user armed /braid for this request. Call the braid tool as your first action with a complete DAG. " +
  "Braid nodes can inspect files read-only. Do not use other tools or substitute a direct answer before Braid runs.";

function hasStartedGraph(details: unknown): boolean {
  if (
    !details ||
    typeof details !== "object" ||
    !("events" in details) ||
    !Array.isArray(details.events)
  )
    return false;
  return (
    details.events.some((event) => event?.type === "graph_created") &&
    details.events.some((event) => event?.type === "node_started")
  );
}

/** One-turn first-tool guard. No persistent settings or global tool-list changes. */
export function registerBraidCommand(pi: ExtensionAPI): void {
  let armed = false;
  let required = false;
  let reminded = false;
  let blocked = 0;
  let turnSignal: AbortSignal | undefined;

  const clear = (ctx: ExtensionContext): void => {
    required = false;
    reminded = false;
    blocked = 0;
    turnSignal = undefined;
    if (ctx.hasUI) ctx.ui.setStatus("braid-next", undefined);
  };

  pi.registerCommand("braid", {
    description:
      "Require Braid for the next prompt; /braid off cancels the requirement",
    handler: async (args, ctx) => {
      if (args.trim() === "off") {
        armed = false;
        clear(ctx);
        if (ctx.hasUI) ctx.ui.notify("Braid requirement cleared", "info");
        return;
      }
      if (args.trim()) throw new Error("Usage: /braid or /braid off");
      if (!ctx.isIdle())
        throw new Error(
          "Wait for the current response to finish before arming /braid",
        );
      if (!pi.getActiveTools().includes("braid"))
        throw new Error(
          "The braid tool is disabled. Enable it before using /braid.",
        );
      armed = true;
      if (ctx.hasUI) {
        ctx.ui.setStatus("braid-next", "Braid: next prompt");
        ctx.ui.notify("Braid armed for the next prompt", "info");
      }
    },
  });

  pi.on("input", (event, ctx) => {
    // Commands, blank input, and extension-injected messages do not consume the arm.
    if (
      event.source === "extension" ||
      !event.text.trim() ||
      event.text.trimStart().startsWith("/")
    )
      return;
    // An armed request must start from idle, not become a mid-turn steering message.
    if (!ctx.isIdle()) return;
    clear(ctx);
    if (!armed) return;
    armed = false;
    required = true;
    if (ctx.hasUI)
      ctx.ui.setStatus("braid-next", "Braid: required this prompt");
    return { action: "transform", text: `${event.text}\n\n[${REQUIRED}]` };
  });

  pi.on("before_agent_start", (event) => {
    if (!required) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n## Mandatory Braid turn\n${REQUIRED}`,
    };
  });
  pi.on("agent_start", (_event, ctx) => {
    if (required) turnSignal = ctx.signal;
  });
  pi.on("message_end", (event, ctx) => {
    if (
      required &&
      event.message.role === "assistant" &&
      (event.message.stopReason === "aborted" ||
        event.message.stopReason === "error")
    )
      clear(ctx);
  });

  pi.on("tool_call", (event, ctx) => {
    if (!required) return;
    if (ctx.signal?.aborted) {
      clear(ctx);
      return;
    }
    if (event.toolName === "braid") return; // Preflight is NOT evidence of a valid run.
    blocked++;
    return {
      block: true,
      reason:
        "Braid is required for this prompt. Call braid first; other tools are blocked until that run returns.",
      ...(blocked >= 8 ? { terminate: true } : {}),
    };
  });
  pi.on("tool_result", (event, ctx) => {
    // Release only after this adapter returned evidence of a validated, started run.
    // A malformed/blocked braid call cannot unlock sibling tools in the same batch.
    if (
      required &&
      event.toolName === "braid" &&
      hasStartedGraph(event.details)
    )
      clear(ctx);
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!required) return;
    if (
      turnSignal?.aborted ||
      ctx.signal?.aborted ||
      ctx.hasPendingMessages()
    ) {
      clear(ctx);
      return;
    }
    if (!reminded) {
      reminded = true;
      blocked = 0;
      // A custom follow-up avoids disguising an automatic reminder as user input.
      pi.sendMessage(
        {
          customType: "braid-required",
          display: true,
          content:
            "Braid has not started for the armed request. Make the braid call now; this is the single automatic reminder.",
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
      return;
    }
    clear(ctx);
    pi.sendMessage({
      customType: "braid-required",
      display: true,
      content:
        "Braid did not start after one reminder. The requirement is cleared; no successful Braid run is claimed. Use /braid to try again.",
    });
  });
  pi.on("session_shutdown", (_event, ctx) => {
    armed = false;
    clear(ctx);
  });
}
