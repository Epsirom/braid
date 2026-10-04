import type { InvocationDescriptor, RemoteResult } from "@deepseek-ai/dsh-typert-protocol";
import type { ControlRequest, DetailRequest, PanelDetail, PanelFrame, PanelRequest } from "./panel-types.js";

/** One descriptor table shared by Host registration and Client Remote mounting. */
export const PANEL_PACKAGE = "@chrok/dsh-braid";
function parseRequest(value: unknown, method: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Braid panel request");
  const r = value as Record<string, unknown>;
  const id = (key: string) => typeof r[key] === "string" && (r[key] as string).length > 0 && (r[key] as string).length <= 1024;
  if (!id("sessionId") || (r.jobId !== undefined && !id("jobId"))) throw new Error("Invalid session or job ID");
  if (r.createdBefore !== undefined && (!Number.isSafeInteger(r.createdBefore) || Number(r.createdBefore) < 0)) throw new Error("Invalid call timestamp");
  if (method !== "watch" && !id("jobId")) throw new Error("A job ID is required");
  if (method === "control" && (
    !["cancel", "resume"].includes(String(r.action)) || !Number.isSafeInteger(r.revision) || Number(r.revision) < 0 ||
    !Array.isArray(r.executionIds) || r.executionIds.length > 10000 || r.executionIds.some(v => typeof v !== "string" || !v || v.length > 1024)
  )) throw new Error("Invalid Braid control request");
  if (method === "detail" && (!id("executionId") || !Number.isSafeInteger(r.offset) || Number(r.offset) < 0)) throw new Error("Invalid execution or offset");
  return value;
}
export const panelDescriptors: InvocationDescriptor[] = ["watch", "control", "detail"].map(method => ({
  id: `${PANEL_PACKAGE}#braidPanel/${method}`, service: "braidPanel", namespace: "braidPanel", method,
  invocation: { kind: "direct" },
  parameters: [{ name: "request", wire: "request", source: "json", codec: {
    mode: "strict", typeSymbol: `${PANEL_PACKAGE}/${method}Request`, create: () => ({ parse: value => parseRequest(value, method) }),
  } }],
  result: { mode: "src-json" },
  ...(method === "watch" ? { mode: "stream" as const, cancellation: { parameter: "signal" as const } } : {}),
}));
export interface PanelRemote {
  watch(request: PanelRequest, signal?: AbortSignal): AsyncIterable<PanelFrame>;
  control(request: ControlRequest): Promise<RemoteResult<PanelFrame>>;
  detail(request: DetailRequest): Promise<RemoteResult<PanelDetail>>;
}
declare module "@deepseek-ai/dsh-typert-protocol" {
  interface TypertRemoteNamespaceMap { braidPanel: PanelRemote }
  interface RemoteErrorDetailsMap { "braid/panel": { sessionId: string } }
}
