import * as React from "react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { PanelActivity, PanelActivityEntry, PanelApi, PanelDetail, PanelExecution, PanelFrame, PanelJob } from "../panel-types.js";
import { layoutGraph } from "./layout.js";
import type { BraidNavigation } from "./navigation.js";

const number = (n: number) => n.toLocaleString();
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const duration = (ms: number) => {
  const value = Math.max(0, ms);
  return value < 60_000 ? `${(value / 1000).toFixed(1)}s` : `${Math.floor(value / 60_000)}m ${Math.floor((value % 60_000) / 1000)}s`;
};

/** Host time for this frame, advanced locally so idle times keep counting between frames. */
function useHostClock(job: PanelJob, live: boolean): number {
  const receivedAt = useMemo(() => Date.now(), [job]);
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    setClock(Date.now());
    if (!live) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [job, live]);
  return job.observedAt + Math.max(0, clock - receivedAt);
}

function ActivityView({ activity, entries, now, loadEarlier }: { activity: PanelActivity; entries?: PanelActivityEntry[]; now: number; loadEarlier?: () => void }) {
  const end = activity.finishedAt ?? now;
  const model = activity.model;
  const running = activity.finishedAt === undefined;
  return <div className="br-activity" aria-label="Live activity">
    <div className="br-detail-grid">
      <div><span>Phase</span>{activity.phase} · {duration(end - activity.phaseStartedAt)}</div>
      <div><span>Last activity</span>{running ? `${duration(now - activity.lastActivityAt)} ago` : "—"} · {activity.lastActivity}</div>
      <div><span>Total</span>{duration(end - activity.startedAt)}</div>
      {model && <div><span>Model request #{model.round}</span>{model.completedAt !== undefined
        ? `returned after ${duration(model.completedAt - model.startedAt)}`
        : model.firstStreamAt === undefined
          ? `sent ${duration(now - model.startedAt)} ago · no stream events yet`
          : `streaming ${model.receiving ?? "output"}${model.toolName ? ` (${model.toolName})` : ""} · ${number(model.receivedChars)} chars · last ${duration(now - (model.lastStreamAt ?? model.firstStreamAt))} ago`}</div>}
      {activity.tools.map(tool => <div key={tool.callId}><span>Running tool</span>{tool.name} · {duration(now - tool.startedAt)} · {tool.lastOutputAt === undefined ? "no output yet" : `last output ${duration(now - tool.lastOutputAt)} ago`}</div>)}
    </div>
    {model?.completedAt === undefined && model?.tail && <pre className="br-output br-tail" aria-label="Latest streamed output">…{model.tail}</pre>}
    {activity.tools.map(tool => <details key={tool.callId}><summary>{tool.name} arguments{tool.outputTail ? " and latest output" : ""}</summary><pre className="br-output">{tool.arguments}{tool.outputTail ? `\n\n…${tool.outputTail}` : ""}</pre></details>)}
    {activity.limitations.map(text => <p className="br-note" key={text}>Unavailable: {text}</p>)}
    {running && <p className="br-note">Times since the last observed signal are diagnostic; a quiet worker is not necessarily stalled.</p>}
    {entries && <details open={running}><summary>Activity history ({activity.sequence})</summary>
      {(entries[0]?.sequence ?? activity.sequence + 1) > activity.droppedEntries + 1 && loadEarlier && <button onClick={loadEarlier}>Load earlier activity</button>}
      {activity.droppedEntries > 0 && (entries[0]?.sequence ?? 0) <= activity.droppedEntries + 1 && <p className="br-note">{activity.droppedEntries} earlier entries were trimmed to bound memory.</p>}
      <ol className="br-events br-activity-log">{entries.map(entry => <li key={entry.sequence} data-error={entry.isError ? "" : undefined}>
        <time>+{duration(entry.timestamp - activity.startedAt)}</time>
        <div><p>{entry.summary}</p>{entry.detail && entry.detail !== entry.summary && <details><summary>Details{entry.detailLength ? ` (${number(entry.detailLength)} characters, preview)` : ""}</summary><pre className="br-output">{entry.detail}</pre></details>}</div>
      </li>)}</ol>
    </details>}
  </div>;
}
export function Status({ status }: { status: string }) {
  return <span className="br-status" data-status={status}>{status}</span>;
}

export function Graph({ job, selected, select }: { job: PanelJob; selected: string; select: (id: string) => void }) {
  const layout = useMemo(() => layoutGraph(job.nodes, job.edges), [job.nodes, job.edges]);
  const [zoom, setZoom] = useState(1);
  const arrow = useId().replaceAll(":", "");
  const selectedButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { selectedButton.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" }); }, [selected]);
  return <section className="br-section" aria-label="Execution graph">
    <div className="br-section-head"><h3>Execution graph</h3><div className="br-toolbar">
      <button aria-label="Zoom out" disabled={zoom <= .5} onClick={() => setZoom(v => Math.max(.5, v - .25))}>−</button>
      <button aria-label="Reset zoom" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
      <button aria-label="Zoom in" disabled={zoom >= 1.5} onClick={() => setZoom(v => Math.min(1.5, v + .25))}>+</button>
    </div></div>
    <div className="br-graph"><div style={{ width: layout.width * zoom, height: layout.height * zoom }}>
      <div className="br-graph-canvas" style={{ width: layout.width, height: layout.height, transform: `scale(${zoom})`, transformOrigin: "top left" }}>
        <svg width={layout.width} height={layout.height} aria-hidden="true"><defs><marker id={arrow} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" style={{ fill: "var(--br-muted)" }}/></marker></defs>
          {job.edges.map((edge, i) => {
            const a = layout.positions.get(edge.from), b = layout.positions.get(edge.to);
            if (!a || !b) return null;
            const x = a.x + 77, y = a.y + 72, endX = b.x + 77, endY = b.y;
            const d = edge.feedback ? `M ${a.x} ${a.y + 36} C 6 ${a.y + 36}, 6 ${b.y + 36}, ${b.x} ${b.y + 36}` : `M ${x} ${y} C ${x} ${y + 26}, ${endX} ${endY - 26}, ${endX} ${endY}`;
            return <g key={i}><path d={d} strokeDasharray={edge.feedback ? "4 4" : undefined} markerEnd={`url(#${arrow})`}><title>{edge.from} → {edge.to}{edge.choice ? ` (${edge.choice})` : ""}{edge.feedback ? ` · loop ${edge.feedback}` : ""}{edge.executionId ? ` · ${edge.executionId}` : ""}</title></path>
              {edge.choice && !edge.feedback && <text x={(x + endX) / 2 + 5} y={(y + endY) / 2 - 4}>{edge.choice.slice(0, 22)}</text>}</g>;
          })}
        </svg>
        {job.nodes.map(node => { const p = layout.positions.get(node.id)!; return <button key={node.id} ref={selected === node.id ? selectedButton : undefined} className="br-node" style={{ left: p.x, top: p.y }} aria-pressed={selected === node.id} onClick={() => select(node.id)} title={`${node.id} · ${node.type} · ${node.status}`}>
          <small>{node.type}</small><strong>{node.id}</strong><Status status={node.status}/>
        </button>; })}
      </div>
    </div></div>
    <div className="br-legend"><span>Solid · dependency</span><span>Dashed · loop feedback</span><span>Click a node to inspect</span></div>
    {job.loops.map(loop => <p className="br-note" key={loop.id}>Loop {loop.id} · entry {loop.entry} · maximum {loop.maxIterations} iterations</p>)}
  </section>;
}

function ExecutionDetail({ api, sessionId, job, execution }: { api: PanelApi; sessionId: string; job: PanelJob; execution: PanelExecution }) {
  const [detail, setDetail] = useState<PanelDetail>();
  const [error, setError] = useState("");
  const [offset, setOffset] = useState(0);
  const [retry, setRetry] = useState(0);
  const [activityBefore, setActivityBefore] = useState<number>();
  const [earlier, setEarlier] = useState<PanelActivityEntry[]>([]);
  // New activity refreshes the detail in place; the view is keyed by execution.
  const sequence = execution.activity?.sequence;
  useEffect(() => {
    let active = true;
    setError("");
    void api.detail({ sessionId, jobId: job.jobId, executionId: execution.executionId, offset }).then(value => {
      if (active) setDetail(value);
    }, e => { if (active) setError(message(e)); });
    return () => { active = false; };
  }, [api, sessionId, job.jobId, job.status, execution.executionId, execution.status, offset, retry, sequence]);
  useEffect(() => {
    if (activityBefore === undefined) return;
    let active = true;
    void api.detail({ sessionId, jobId: job.jobId, executionId: execution.executionId, offset: 0, activityBefore }).then(value => {
      if (active) setEarlier(previous => [...(value.activity?.entries ?? []), ...previous]);
    }, e => { if (active) setError(message(e)); });
    return () => { active = false; };
  }, [api, sessionId, job.jobId, execution.executionId, activityBefore]);
  const p = execution.progress;
  const activity = execution.activity ?? detail?.activity;
  const now = useHostClock(job, execution.status === "running");
  // Keep the view contiguous: once earlier pages load, live refreshes extend the
  // range instead of sliding the latest-entries window away from them.
  const seen = useRef(new Map<number, PanelActivityEntry>());
  const latest = detail?.activity?.entries ?? [];
  const from = earlier[0]?.sequence ?? latest[0]?.sequence ?? Infinity;
  for (const entry of [...earlier, ...latest]) seen.current.set(entry.sequence, entry);
  for (const sequence of seen.current.keys()) if (sequence < from) seen.current.delete(sequence);
  const entries = [...seen.current.values()].sort((a, b) => a.sequence - b.sequence);
  return <>
    <div className="br-detail-grid">
      <div><span>Execution</span>{execution.executionId}</div><div><span>Revision / iteration</span>r{execution.revision} / {execution.iteration ?? "—"}</div>
      <div><span>Elapsed</span>{execution.latencyMs === undefined ? "—" : `${(execution.latencyMs / 1000).toFixed(1)}s`}</div>
      <div><span>Worker</span>{p?.phase ?? execution.status}</div>
      <div><span>Context ({p?.contextSource ?? "unreported"})</span>{p ? `${number(p.contextTokens)}${p.contextWindow ? ` / ${number(p.contextWindow)}` : ""}` : "—"}</div>
      <div><span>Tool calls / rounds</span>{p ? `${p.toolCalls} / ${p.toolRounds}` : "—"}</div>
    </div>
    {activity ? <ActivityView activity={activity} now={now} {...(detail?.activity ? { entries } : {})}
      loadEarlier={() => { if (entries[0]) setActivityBefore(entries[0].sequence); }}/>
      : execution.status === "running" && <p className="br-muted" role="status">No worker activity observed yet.</p>}
    {error && <div role="alert">{error} <button onClick={() => setRetry(v => v + 1)}>Retry output</button></div>}
    {!detail && !error && <p className="br-muted" role="status">Loading output…</p>}
    {detail && <>
      {detail.error && <p role="alert">{detail.error}</p>}
      {detail.decision && <p>Decision: <strong>{detail.decision}</strong></p>}
      <pre className="br-output" aria-label="Execution output">{detail.output || (execution.status === "running" ? "Output will appear when this execution finishes." : "No output for this execution.")}</pre>
      {detail.total > 32768 && <div className="br-toolbar"><button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 32768))}>Previous output</button><small className="br-muted">{number(detail.offset)}–{number(detail.next)} / {number(detail.total)} characters</small><button disabled={detail.next >= detail.total} onClick={() => setOffset(detail.next)}>Next output</button></div>}
      {detail.workspace && <details><summary>Workspace and recovery refs</summary><pre className="br-output">{detail.workspace}</pre></details>}
    </>}
  </>;
}

function JobView({ job, api, sessionId, connected, act, busy, target }: { job: PanelJob; api: PanelApi; sessionId: string; connected: boolean; act: (action: "cancel" | "resume", ids: string[]) => void; busy: boolean; target: BraidNavigation | undefined }) {
  const [selected, setSelected] = useState(() => job.executions.find(e => e.executionId === target?.executionId)?.id
    ?? target?.nodeId ?? (target?.executionId ? "" : job.nodes[0]?.id ?? ""));
  const [chosenExecution, setChosenExecution] = useState(target?.executionId ?? "");
  const [tab, setTab] = useState("output");
  const executions = job.executions.filter(e => e.id === selected);
  const execution = chosenExecution ? executions.find(e => e.executionId === chosenExecution) : executions.at(-1);
  const paused = execution && job.pausedExecutionIds.includes(execution.executionId);
  return <>
    <div className="br-stats"><div><strong>{job.executions.filter(e => e.status === "completed").length}/{job.executions.length}</strong><span>Executions complete</span></div><div><strong>{number(job.usage.inputTokens)}</strong><span>Input tokens</span></div><div><strong>{number(job.usage.outputTokens)}</strong><span>Output tokens</span></div><div><strong>{number(job.usage.cacheReadTokens + job.usage.cacheWriteTokens)}</strong><span>Cache tokens</span></div></div>
    {job.error && <div className="br-notice" role="alert">{job.error}</div>}
    {job.pausedExecutionIds.length > 0 && <div className="br-notice"><strong>{job.pausedExecutionIds.length} execution(s) paused</strong><p className="br-note">Inspect the output, then resume outgoing scheduling. Job deadlines continue while paused.</p><button className="br-primary" disabled={!connected || busy || job.status !== "running"} onClick={() => act("resume", job.pausedExecutionIds)}>Resume all paused</button></div>}
    <Graph job={job} selected={selected} select={id => { setSelected(id); setChosenExecution(""); setTab("output"); }}/>
    <section className="br-section" aria-label="Execution details"><div className="br-section-head"><h3>{selected || "Execution details"}</h3>{execution && <Status status={paused ? "waiting" : execution.status}/>}</div>
      {chosenExecution && !execution && <p role="status">The requested execution ({chosenExecution}) is no longer available. Select a node to inspect its current history.</p>}
      {executions.length > 0 ? <label><span className="br-muted">Execution history</span><select className="br-select" aria-label="Execution history" value={execution?.executionId ?? ""} onChange={e => setChosenExecution(e.target.value)}>{executions.map(e => <option key={e.executionId} value={e.executionId}>{e.executionId} · {e.status}{e.iteration === undefined ? "" : ` · iteration ${e.iteration}`}</option>)}</select></label> : <p className="br-muted">This node has not run yet.</p>}
      {paused && <button className="br-primary" disabled={!connected || busy || job.status !== "running"} onClick={() => act("resume", [execution!.executionId])}>Resume this execution</button>}
      <div className="br-tabs"><button aria-pressed={tab === "output"} onClick={() => setTab("output")}>Output & details</button><button aria-pressed={tab === "events"} onClick={() => setTab("events")}>Event log ({job.events.length})</button></div>
      {tab === "output" && execution && <ExecutionDetail key={execution.executionId} api={api} sessionId={sessionId} job={job} execution={execution}/>}
      {tab === "events" && <><p className="br-note">Latest 80 lifecycle events. Full results remain available through braid_status.</p><ol className="br-events">{[...job.events].reverse().map(event => <li key={event.sequence}><time>{new Date(event.timestamp).toLocaleTimeString([], { hour12: false })}</time><div><p>{event.message}</p><small>#{event.sequence}{event.nodeId ? ` · ${event.nodeId}` : ""}{event.executionId ? ` · ${event.executionId}` : ""}</small></div></li>)}</ol></>}
      <p className="br-note">Cache read {number(job.usage.cacheReadTokens)} · cache write {number(job.usage.cacheWriteTokens)}. Usage is reported by DSH; monetary cost is not estimated.</p>
    </section>
  </>;
}

/** The session key deliberately resets every local selection and request generation. */
export function BraidPanelView(props: { sessionId: string; api: PanelApi; target?: BraidNavigation }) {
  return <SessionPanel key={props.sessionId} {...props}/>;
}
function SessionPanel({ sessionId, api, target }: { sessionId: string; api: PanelApi; target?: BraidNavigation }) {
  const [jobId, setJobId] = useState<string | undefined>(target?.jobId);
  const [createdBefore, setCreatedBefore] = useState<number | undefined>(target?.createdBefore);
  const [frame, setFrame] = useState<PanelFrame>();
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setConnected(false); setFrame(undefined); setError(""); setActionError("");
    void (async () => {
      for (let attempt = 0; !controller.signal.aborted; attempt++) {
        try {
          for await (const value of api.watch({ sessionId, ...(jobId ? { jobId } : {}), ...(createdBefore === undefined ? {} : { createdBefore }) }, controller.signal)) {
            if (controller.signal.aborted) return;
            setFrame(value); setConnected(true); setError(""); attempt = 0;
          }
          if (!controller.signal.aborted) throw new Error("Braid connection closed");
        } catch (e) {
          if (controller.signal.aborted) return;
          setConnected(false); setError(`${message(e)}${attempt < 2 ? " · reconnecting…" : ""}`);
          if (attempt >= 2) return;
          await new Promise<void>(resolve => {
            const done = () => { clearTimeout(timer); controller.signal.removeEventListener("abort", done); resolve(); };
            const timer = setTimeout(done, 1000 * 2 ** attempt);
            controller.signal.addEventListener("abort", done, { once: true });
          });
        }
      }
    })();
    return () => { controller.abort(); };
  }, [api, sessionId, jobId, createdBefore, retry]);
  const job = frame?.job;
  // In-flight mutations only affect their mounted job view; stream frames remain authoritative.
  const [actionOwner, setActionOwner] = useState("");
  const act = async (action: "cancel" | "resume", executionIds: string[]) => {
    if (!job || !connected || busy) return;
    const owner = job.jobId;
    setBusy(true); setActionOwner(owner); setActionError("");
    try { await api.control({ sessionId, jobId: owner, action, executionIds, revision: job.revision }); }
    catch (e) { setActionError(message(e)); }
    finally { setBusy(false); }
  };
  return <div className="braid-panel">
    <header className="br-header"><div className="br-eyebrow">Agent orchestration</div><div className="br-heading"><h2>Braid</h2><small role="status">{connected ? "● Live" : error ? "○ Disconnected" : "Connecting…"}</small></div>
      {frame && frame.rows.length > 0 && <><select className="br-select" aria-label="Braid job" disabled={busy} value={job?.jobId ?? ""} onChange={e => { setJobId(e.target.value); setCreatedBefore(undefined); setActionError(""); }}>{frame.rows.map(row => <option key={row.jobId} value={row.jobId}>{row.handle} · {row.status} · {row.goal.slice(0, 70)}</option>)}</select>
        {job && <><p className="br-goal">{job.goal}</p><div className="br-toolbar"><Status status={job.phase === "waiting" ? "waiting" : job.status}/><small className="br-muted">r{job.revision} · {job.nodes.length} nodes</small><button className="br-danger" style={{ marginLeft: "auto" }} disabled={!connected || busy || job.status !== "running"} onClick={() => void act("cancel", [])}>{busy ? "Working…" : "Cancel job"}</button></div></>}
      </>}
    </header>
    {error && <div className="br-notice" role="alert">{error}<div className="br-toolbar"><button onClick={() => setRetry(v => v + 1)}>Reconnect</button><button onClick={() => { setJobId(undefined); setCreatedBefore(undefined); setRetry(v => v + 1); }}>Latest job</button></div></div>}
    {actionError && actionOwner === job?.jobId && <div className="br-notice" role="alert">{actionError}</div>}
    {connected && frame?.rows.length === 0 && <div className="br-empty"><h3>No Braid jobs in this session</h3><p>Ask the agent to use Braid for a parallel or multi-step task. Its graph, execution history and results will appear here.</p></div>}
    {job && <JobView key={job.jobId} job={job} api={api} sessionId={sessionId} connected={connected} act={(action, ids) => void act(action, ids)} busy={busy}
      target={target?.jobId && [job.jobId, job.handle].includes(target.jobId) ? target : undefined}/>}
  </div>;
}
