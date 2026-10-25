# Resource limits and deployment responsibility

Braid targets small reasoning graphs. Graph size, prompt/output size, event-log
size, and the number of simultaneous graph submissions have no hard cap. Started and
skipped executions can be capped with `maxExecutions`, and the runs of a node,
including the rounds of a cycle, with its `maxRuns`; both are unlimited by default.
The scheduler rescans the graph as work settles. Consult the
[benchmark](benchmark.md) for measured local overhead rather than treating the
validator's deep-graph tests as a production capacity guarantee.

Submission-local prompt templates reduce graph/tool-call argument size, not
worker context size. Core expands them before execution and checks rendered
prompts are non-empty. There is no raw or rendered prompt length/token cap;
hosts imposing their own size budgets must account for expanded prompts as
well as the compact definition.

| Control | Core default | Pi default |
| --- | --- | --- |
| Active runtime-managed invocations per graph | 4 | 4 |
| Started and skipped executions across rounds/updates | Unlimited (`maxExecutions`) | Unlimited (`maxExecutions`) |
| Started executions of one node, including cycle rounds and reruns | Unlimited (`maxRuns`) | Unlimited (`maxRuns`) |
| Node timeout (starts at admission, stops while suspended) | Unlimited | Unlimited |
| On node timeout (`onNodeTimeout`) | Pause with `startBraid` and an interruptible runner; fail with `braid()` | Pause; the parent gets a reminder to resume or cancel |
| Graph timeout (includes queueing, paused gates, and suspensions) | Unlimited | Unlimited |
| On reaching a limit that is set (`onLimit`) | Pause with `startBraid` (keep a rerun past `maxRuns` pending, or pause the run); fail with `braid()` | Pause; the parent gets a reminder to raise the limit or stop |
| Caller cancellation | `AbortSignal`; `cancelExecutions` for single executions | `braid_cancel` / panel `c`; `braid_cancel` with `executionIds` / panel `x` |
| Pause running work | `pause` / `pauseRun` | `braid_pause` / panel `p` |
| Worker tool loop | Decision continuation / merge Git-tool loop, bounded by deadlines | Unlimited by default; optional `maxToolRounds` and `maxToolCalls` |
| Transient model error retries | Runner-defined | 3 per model request (`maxModelRetries`), within the current execution |
| Result preview | Full result | 50 KB / 2,000 lines of text, then temporary full-text file |
| Token budget | Unlimited (`maxTokens`, checked as executions settle) | Unlimited (`maxTokens`) |
| Monetary budget | Not enforced | Not enforced |

Core and Pi set no time, execution, or token limit by default, which suits
background work. For bounded work, submit explicit `options`, for example:

```json
{ "maxConcurrency": 2, "nodeTimeoutMs": 30000, "graphTimeoutMs": 120000, "maxToolRounds": 12, "maxToolCalls": 32 }
```

The concurrency limit belongs to each graph, not to the process or provider
account. Ten graphs with `maxConcurrency: 4` can collectively start 40 calls.
The host should cap simultaneous submissions and validate graph dimensions and
input sizes before admitting untrusted requests. The core's graph timer starts
after validation; it does not bound validation CPU or input allocation.

Token counts report only usage returned by runners. Missing counts, failed
requests, or timeout-aborted calls can still incur charges. There is no hard cost
ceiling: `maxTokens` counts reported usage as executions settle, so it cannot
prevent running or concurrent calls from overspending. Use provider account quotas, output-token limits in a
custom runner, host admission controls, and finite deadlines where needed.

All events and full results live in memory; handoff events retain output for each
edge. Large fan-out/fan-in graphs and verbose workers increase memory and context
use. Pi retains completed jobs for its session lifetime and full temporary result
files until the host/user removes them. Limit the length of sessions or reload
after exporting needed results. Reloading also cancels outstanding work.

Git worktree preparation, checkpointing, tracked writes, and cleanup add disk,
Git-process, and elapsed-time overhead. Cleanup may extend wall time beyond a
model deadline. Every loop visit creates a new invocation and worktree. Explicit merge/integrate
nodes count toward the same limits; no final integration call is appended.
Updates/resumes never reset the graph deadline or execution counter.
Benchmark results measured outside Git do not include this lifecycle. Recoverable
refs retain Git objects until removed.

An aborted runtime slot can be reused even if an uncooperative provider continues
working. Runners must forward `signal`; neither Braid nor JavaScript can forcibly
stop that remote work. Workspace and tool guards are not a security sandbox. See
[SECURITY.md](../SECURITY.md) before exposing a runner to untrusted input.
