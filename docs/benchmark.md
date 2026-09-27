# Scheduler benchmark

Run `npm ci`, then `npm run bench`. For a short sanity run, use
`npm run bench -- --quick`. The script prints JSON; keep the JSON portion when
comparing machines. [Raw sample measurements](benchmark-results.json) are included.

The benchmark covers chains and fan-out/join graphs at 10, 100, and 1,000 nodes,
with concurrency 1, 4, and 16. Every case has one warm-up and seven measured runs.
The runner executes in a temporary non-Git directory and immediately returns two
bytes of text; no Git worktrees, network, provider latency,
tool loop, or model billing is involved. Node is started with `--expose-gc` and
garbage collection is requested before each run. Deadlines are disabled.

## Sample run — 2026-09-27

Environment: Apple M5, darwin/arm64, Node v25.9.0.
The following subset uses concurrency 4:

| Graph | Nodes | Concurrency | Median elapsed ms | Largest observed heap delta MiB |
| --- | ---: | ---: | ---: | ---: |
| chain | 10 | 4 | 0.374 | 0.597 |
| chain | 100 | 4 | 2.039 | 4.240 |
| chain | 1000 | 4 | 39.575 | 56.839 |
| fan-out/join | 10 | 4 | 0.338 | 0.303 |
| fan-out/join | 100 | 4 | 1.866 | 2.787 |
| fan-out/join | 1000 | 4 | 24.574 | 37.812 |

Elapsed time covers validation, scheduling, context snapshots, events, and result
construction. Heap delta is the change in `heapUsed` across a run, not peak RSS,
retained memory, or a memory limit. GC timing, JIT, and other machine activity
can affect both measurements. The complete JSON includes the maximum time and
all concurrency settings.

These are synthetic observations, not throughput guarantees or model-speed
claims. Chains cannot become parallel merely by raising concurrency. Large
outputs, dense edges, read tools, event observers, and Pi's UI/session retention
are not represented. Measure your actual graphs and output sizes before setting
host admission limits. Start with small reasoning graphs; use the
[resource-limit guide](resource-limits.md) to bound work at the host/provider.
