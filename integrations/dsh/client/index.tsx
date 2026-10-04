import * as React from "react";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-api-gateway/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar-right/client";
import type {} from "@deepseek-ai/dsh-client-ui-tool/client";
import type { PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { PanelApi } from "../panel-types.js";
import { PANEL_PACKAGE, panelDescriptors } from "../panel-contract.js";
import { BraidPanelView } from "./Panel.js";
import { styles, toolStyles } from "./styles.js";
import { BraidToolCall } from "./ToolCall.js";
import { braidToolNames, readNavigation, type BraidNavigation } from "./navigation.js";

declare module "@deepseek-ai/dsh-client-ui-sidebar-right/client" {
  interface SidebarRightTabParamsMap { braid: BraidNavigation }
}

export const inject = ["remote", "slots", "sidebarRight", "sidebarRightTabs"];
export async function apply(ctx: Context): Promise<void> {
  await ctx.remote.$mount({ package: PANEL_PACKAGE, descriptors: panelDescriptors });
  ctx.inject(["remote.braidPanel"], ctx => {
    // Capture traced services inside their declared Cordis scope, not React event stacks.
    const remote = ctx.remote.braidPanel;
    const sidebar = ctx.sidebarRight;
    const api: PanelApi = {
      watch: (request, signal) => remote.watch(request, signal),
      control: async request => { const result = await remote.control(request); if (!result.ok) throw result.error; return result.value; },
      detail: async request => { const result = await remote.detail(request); if (!result.ok) throw result.error; return result.value; },
    };
    ctx.effect(() => {
      const style = document.createElement("style"); style.dataset.plugin = PANEL_PACKAGE; style.textContent = styles + toolStyles;
      document.head.append(style); return () => { style.remove(); };
    });
    ctx.effect(() => ctx.sidebarRightTabs.register({ id: PANEL_PACKAGE, kind: "braid", title: () => "Braid",
      guide: [{ id: "braid", order: 50, title: () => "Braid", description: () => "Live agent graphs, execution details and controls" }],
    }));
    ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
      name: "sidebar.right.pane.tab", key: PANEL_PACKAGE, inject: sessionId => ({ api, sessionId }),
    }, PanelSeat)));
    ctx.effect(() => ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
      name: "conversation.session.header.actions", id: "braid", order: 25,
      inject: () => ({ open: () => { sidebar.openTab("braid"); } }),
    }, HeaderAction)));
    for (const key of braidToolNames) ctx.effect(() => ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
      name: "tool.call.toolview", key,
      inject: sessionId => ({ openBraid: (target: BraidNavigation) => { sidebar.openTabIn(sessionId as SessionId, "braid", { params: target }); } }),
    }, BraidToolCall)));
  });
}
function HeaderAction({ open }: { open: () => void }) {
  return <button className="br-header-action" onClick={open} title="Open Braid graph and execution details" aria-label="Open Braid panel">⎇ Braid</button>;
}
function PanelSeat({ sessionId, api, useTabInfo }: PropsRuntime<"sidebar.right.pane.tab"> & { sessionId: string; api: PanelApi }) {
  const { tab: { navigation } } = useTabInfo();
  return <BraidPanelView key={navigation.revision} sessionId={sessionId} api={api} target={readNavigation(navigation.params)}/>;
}
