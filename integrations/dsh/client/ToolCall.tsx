import * as React from "react";
import type { ToolCallOwnerProps } from "@deepseek-ai/dsh-client-ui-tool/client";
import { toolNavigation, toolPresentation, type BraidNavigation } from "./navigation.js";

export type BraidToolCallProps = ToolCallOwnerProps & { openBraid: (target: BraidNavigation) => void };

/** The main row opens the graph; a separate disclosure preserves the raw tool evidence. */
export function BraidToolCall(props: BraidToolCallProps) {
  const { toolName, phase, block, openBraid, useDisclosure, inspect } = props;
  const { expanded, toggle } = useDisclosure();
  const target = toolNavigation(toolName, props);
  const model = toolPresentation(toolName, props);
  const failed = phase === "result" && block.isError;
  const state = failed ? "failed" : phase === "result" ? "completed" : phase === "preparing" ? "preparing" : "running";
  const raw = phase === "result" ? block.call?.argsRaw : phase === "start" ? block.argsRaw : undefined;
  const output = phase === "result" ? block.content.filter(c => c.type === "text").map(c => c.text).join("\n") : "";
  return <div className="br-tool-call" data-state={state}>
    <button type="button" className="br-tool-open" disabled={!target} onClick={() => { if (target) openBraid(target); }}
      aria-label={`Open Braid view for ${toolName}`} title={target ? "Open Braid graph and execution details" : "Waiting for a Braid job receipt"}>
      <span aria-hidden="true">⎇</span><span className="br-tool-main"><strong>{toolName}</strong>
        <span className="br-tool-target">{model.label}{target?.executionId ? ` / ${target.executionId}` : target?.nodeId ? ` / ${target.nodeId}` : ""}</span>
        <span className="br-tool-summary">{model.summary}</span></span><span aria-hidden="true">↗</span>
    </button>
    {model.changes.length > 0 && <div className="br-tool-changes" aria-label={failed ? "Changes not applied" : "Operation details"}>{model.changes.map((change, i) => <span key={i}>{change}</span>)}</div>}
    {model.jobs.length > 0 && <ul className="br-tool-jobs">{model.jobs.map(job => <li key={job.target.jobId}><button type="button" onClick={() => openBraid(job.target)} aria-label={`View ${job.label}`}>{job.label} <span>{job.status}</span> ↗</button></li>)}</ul>}
    {phase === "result" && target && <p className="br-tool-note">Recorded result · open the graph for live state</p>}
    {failed && <p role="alert" className="br-tool-error">{block.error?.reason ?? block.error?.code ?? (output.slice(0, 600) || "Braid tool call failed. Expand the result for details.")}</p>}
    <div className="br-tool-actions"><button type="button" aria-expanded={expanded} onClick={toggle}>{expanded ? "Hide" : "Show"} tool details</button>
      {inspect && <button type="button" onClick={inspect}>Inspect call</button>}
    </div>
    {expanded && <div className="br-tool-details"><strong>Arguments</strong><pre>{raw ?? "Arguments are being prepared…"}</pre>
      {phase === "result" && <><strong>Result</strong><pre>{output || "No text result."}</pre></>}
    </div>}
  </div>;
}
