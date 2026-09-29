# Resource limits and deployment responsibility

Braid targets small reasoning graphs. Graph size, prompt/output size, event-log
size, and the number of simultaneous graph submissions have no hard cap in 0.1.
The scheduler rescans the graph as work settles. Consult the
[benchmark](benchmark.md) for measured local overhead rather than treating the
validator's deep-graph tests as a production capacity guarantee.

| Control | Core default | Pi default |
| --- | --- | --- |
| Active runtime-managed invocations per graph | 4 | 4 |
| Node timeout (starts at admission) | 60 seconds | Unlimited |
| Graph timeout (includes queueing) | 5 minutes | Unlimited |
| Caller cancellation | `AbortSignal` | `braid_cancel` / panel `c` |
| Worker tool loop | Decision continuation / merge Git-tool loop, bounded by deadlines | Unlimited by default; optional `maxToolRounds` and `maxToolCalls` |
| Result preview | Full result | 50 KB / 2,000 lines, then temporary full-result file |
| Token / monetary budget | Not enforced | Not enforced |

Pi keeps unlimited timeouts for interactive background work. For bounded work,
submit explicit `options`, for example:

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
ceiling, and adding a token counter after completion cannot prevent concurrent
calls from overspending. Use provider account quotas, output-token limits in a
custom runner, host admission controls, and finite deadlines where needed.

All events and full results live in memory; handoff events retain output for each
edge. Large fan-out/fan-in graphs and verbose workers increase memory and context
use. Pi retains completed jobs for its session lifetime and full temporary result
files until the host/user removes them. Limit the length of sessions or reload
after exporting needed results. Reloading also cancels outstanding work.

Git worktree preparation, checkpointing, tracked writes, and cleanup add disk,
Git-process, and elapsed-time overhead. Cleanup may extend wall time beyond a
model deadline. Automatically appended merge agents are additional model calls
and share the graph's remaining time; unchanged worktrees are released without
an automatic merge call, but still incur workspace and checkpoint overhead.
Benchmark results measured outside Git do not include this lifecycle. Recoverable
refs retain Git objects until removed.

An aborted runtime slot can be reused even if an uncooperative provider continues
working. Runners must forward `signal`; neither Braid nor JavaScript can forcibly
stop that remote work. Workspace and tool guards are not a security sandbox. See
[SECURITY.md](../SECURITY.md) before exposing a runner to untrusted input.
