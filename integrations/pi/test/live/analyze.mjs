import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const json = path => JSON.parse(readFileSync(path, 'utf8'));
const rows = path => readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2));
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function analyze(run, capabilities) {
  const scenario = json(join(run, 'invocation.json')).scenario;
  const job = json(join(run, 'braid-result.json'));
  const result = job.result;
  const verification = json(join(run, 'verification.json'));
  const log = rows(join(run, 'nodes.jsonl'));
  const rpc = rows(join(run, 'rpc.jsonl'));
  const calls = json(join(run, 'parent-calls.json'));
  const cwd = join(run, 'fixture');
  const checks = {};
  const check = (name, condition) => { checks[name] = !!condition; };
  const requests = new Map(), responses = new Map(), toolResults = new Map();
  for (const row of log) {
    if (row.kind === 'node_request') {
      if (!requests.has(row.nodeId)) requests.set(row.nodeId, row);
      for (const m of row.messages) if (m.role === 'toolResult') toolResults.set(`${row.nodeId}/${m.toolCallId}`, m);
    }
    if (row.kind === 'node_response') {
      if (!responses.has(row.nodeId)) responses.set(row.nodeId, []);
      responses.get(row.nodeId).push(row);
    }
  }
  const nodes = Object.fromEntries(Object.entries(result.nodes).map(([id, node]) => {
    const replies = responses.get(id) ?? [];
    const tools = replies.flatMap(r => r.content.filter(c => c.type === 'toolCall'));
    return [id, { status: node.status, error: node.error, modelCalls: replies.length, toolCalls: tools.length, tools,
      availableTools: requests.get(id)?.tools.map(t => t.name) ?? [], workspace: node.workspace }];
  }));
  const errors = [...toolResults.entries()].filter(([, m]) => m.isError).map(([id, m]) => ({ id, tool: m.toolName, content: m.content }));
  check('one braid submission', calls.filter(c => c.tool === 'braid').length === 1);
  check('completion reminder delivered', rpc.some(e => e.message?.customType === 'braid-completed'));
  check('exact short handles used', calls.filter(c => ['braid_status', 'braid_cancel'].includes(c.tool)).every(c => c.args.jobId === 'job-1'));
  check('no parent mutation tools', calls.every(c => ['braid', 'braid_status', 'braid_cancel', 'read', 'ls'].includes(c.tool)));
  check('finite time reminders', log.filter(r => r.kind === 'node_request').every(r => r.systemPrompt.includes('<system-reminder>') && r.systemPrompt.includes('time budget:')));
  check('no missing dependency execution errors', errors.every(e => !/could not be downloaded|no longer available/.test(JSON.stringify(e))));
  for (const [id, req] of requests) {
    const names = req.tools.map(t => t.name);
    if (capabilities) {
      check(`${id}:find capability accurate`, names.includes('find') === capabilities.find);
      check(`${id}:grep capability accurate`, names.includes('grep') === capabilities.grep);
      check(`${id}:missing capability guidance`, (capabilities.find || req.systemPrompt.includes('find (fd)')) && (capabilities.grep || req.systemPrompt.includes('grep (rg)')));
    }
    for (const c of nodes[id].tools) {
      if (c.name === 'git' && c.arguments.args?.[0] === c.arguments.command) {
        const output = toolResults.get(`${id}/${c.id}`);
        check(`${id}/${c.id}:duplicate rejected before Git`, output?.isError && JSON.stringify(output.content).includes('DUPLICATE_GIT_COMMAND'));
      }
    }
    const sources = req.payload.mergeSources;
    if (sources) {
      const ids = sources.map(s => s.executionId);
      const schema = req.tools.find(t => t.name === 'finish_merge').parameters.properties.dispositions;
      check(`${id}:scoped finish schema`, equal(schema.items.properties.executionId.enum ?? [], ids) && schema.minItems === ids.length && schema.maxItems === ids.length);
      check(`${id}:bounded previews supplied`, sources.every(s => s.changes && s.changes.diff.text.length <= 6000 && !s.changes.files.some(f => ['user.txt','notes.txt'].includes(f))));
      if (nodes[id].workspace.mode === 'integrate') check(`${id}:source status supplied`, req.payload.sourceCheckoutStatus?.dirty === (scenario !== 'real-conflict'));
      check(`${id}:only current sources finalized`, nodes[id].tools.filter(c => c.name === 'finish_merge').every(c => equal(c.arguments.dispositions.map(d => d.executionId).sort(), [...ids].sort())));
    }
  }
  if (scenario !== 'non-git') {
    check('no leaked registered worktrees', verification.worktrees.split('\n').filter(l => l.startsWith('worktree ')).length === 1);
    const workspaces = Object.values(result.workspaces).filter(w => w.worktreeRoot);
    check('node directories removed', workspaces.every(w => !existsSync(w.worktreeRoot)));
    check('temporary workspace roots removed', workspaces.every(w => !existsSync(dirname(w.worktreeRoot))));
    if (scenario !== 'real-conflict') {
      check('staged user data preserved', git(cwd, 'show', ':user.txt') === 'staged user content');
      check('unstaged user data preserved', verification.files['user.txt'] === 'unstaged user content\n');
      check('untracked user data preserved', verification.files['notes.txt'] === 'non-ignored user note\n');
    }
  }
  if (scenario === 'selective-merge') {
    check('expected topology', equal(Object.keys(nodes).sort(), ['numeric','alternative','docs','select','apply'].sort()));
    check('all nodes completed', job.status === 'completed' && Object.values(nodes).every(n => n.status === 'completed'));
    check('correct source selected', nodes.select.workspace.dispositions.some(d => d.executionId === result.nodes.numeric.executionId && d.disposition === 'integrated') && nodes.select.workspace.dispositions.some(d => d.executionId === result.nodes.alternative.executionId && d.disposition === 'discarded'));
    check('explicit integrate applied docs', nodes.apply.workspace.dispositions.some(d => d.executionId === result.nodes.docs.executionId && d.disposition === 'integrated') && verification.files['README.md'].includes('Supports numeric strings.'));
    check('actual arithmetic correct', equal(verification.addValues, [5,5]));
    const initial = log.find(r => r.kind === 'source_before_merge_agent' && r.nodeId === 'select');
    check('no integration before agent starts', initial?.files['calculator.cjs'] === 'exports.add = (a, b) => a - b;\n' && initial?.files['README.md'] === '# Calculator\n');
    const snapshot = nodes.numeric.workspace.snapshotCommit;
    check('dirty snapshot captured', git(cwd, 'show', `${snapshot}:user.txt`) === 'unstaged user content' && git(cwd, 'show', `${snapshot}:notes.txt`) === 'non-ignored user note');
    check('ignored file excluded', git(cwd, 'ls-tree', '--name-only', snapshot, 'ignored.txt') === '');
    check('distinct node worktrees', new Set(['numeric','alternative','docs'].map(id => nodes[id].workspace.worktreeRoot)).size === 3);
  } else if (scenario === 'partial-failure') {
    check('injected failure retained', job.status === 'completed' && nodes.fragile.error?.code === 'MODEL_ERROR' && nodes.fragile.error?.message === 'LIVE_TEST_INJECTED_PROVIDER_FAILURE_AFTER_WRITE');
    check('downstream agents executed', nodes.reviewer.status === 'completed' && nodes.recover.status === 'completed');
    check('both partial files recovered', verification.files['partial.txt'] === 'recoverable partial change\n' && verification.files['review.txt']?.includes('LIVE_TEST_INJECTED_PROVIDER_FAILURE_AFTER_WRITE'));
    check('both sources integrated', ['fragile','reviewer'].every(id => nodes.recover.workspace.dispositions.some(d => d.executionId === result.nodes[id].executionId && ['integrated','discarded'].includes(d.disposition))));
  } else if (scenario === 'non-git') {
    check('read only tools', nodes.probe.availableTools.includes('read') && nodes.probe.availableTools.includes('ls') && nodes.probe.availableTools.every(n => ['read','ls','grep','find'].includes(n)));
    check('no forbidden write', !existsSync(join(cwd, 'forbidden.txt')));
    check('read-only without a worktree', job.status === 'completed' && equal(Object.keys(nodes), ['probe']) && Object.values(result.workspaces ?? {}).every(workspace => !workspace.worktreeRoot));
  } else if (scenario === 'real-conflict') {
    check('actual Git conflict observed', errors.some(e => JSON.stringify(e).includes('CONFLICT')));
    check('agent continued cherry-pick', nodes.resolve.tools.some(c => c.name === 'git' && c.arguments.command === 'cherry-pick' && c.arguments.args.includes('--continue')));
    check('both changes preserved', job.status === 'completed' && equal(verification.settings, { precision: 3, label: 'shipping' }));
    check('no unmerged index entries', verification.unmerged === '');
    check('both sources integrated', ['left','right'].every(id => nodes.resolve.workspace.dispositions.some(d => d.executionId === result.nodes[id].executionId && d.disposition === 'integrated')));
  } else if (scenario === 'merge-failure' || scenario === 'cancel') {
    const file = scenario === 'cancel' ? 'cancelled.txt' : 'salvage.txt';
    const expected = scenario === 'cancel' ? 'recoverable cancelled change' : 'recoverable merge failure change';
    check('checkpoint archived', nodes.worker.workspace.state === 'archived');
    check('file recoverable from checkpoint', git(cwd, 'show', `${nodes.worker.workspace.checkpointRef}:${file}`) === expected);
    check('source not modified', !existsSync(join(cwd, file)));
    if (scenario === 'merge-failure') {
      check('merge error retained', job.status === 'failed' && nodes.broken_merge.error?.message === 'LIVE_TEST_INJECTED_MERGE_PROVIDER_FAILURE');
      check('real tool before injected failure', [...toolResults].some(([id, m]) => id.startsWith('broken_merge/') && m.toolName === 'git' && !m.isError));
    } else {
      check('cancel invoked once', calls.filter(c => c.tool === 'braid_cancel').length === 1);
      check('cancel preserved', job.status === 'cancelled' && nodes.worker.error?.code === 'CANCELLED');
      check('no unrequested integration', equal(Object.keys(nodes), ['worker']));
      check('real write before pause', log.some(r => r.kind === 'injected_pause'));
    }
  } else if (scenario === 'git-arguments') {
    const findCall = (command, args) => nodes.probe.tools.find(c => c.name === 'git' && c.arguments.command === command && equal(c.arguments.args, args));
    const output = c => c ? toolResults.get(`probe/${c.id}`) : undefined;
    const text = c => JSON.stringify(output(c)?.content ?? '');
    check('intentional bad status rejected', output(findCall('status',['status']))?.isError && text(findCall('status',['status'])).includes('DUPLICATE_GIT_COMMAND'));
    check('intentional bad diff rejected', output(findCall('diff',['diff','--stat']))?.isError && text(findCall('diff',['diff','--stat'])).includes('DUPLICATE_GIT_COMMAND'));
    check('full status reveals changes', !output(findCall('status',['--short']))?.isError && text(findCall('status',['--short'])).includes('probe-change.txt') && text(findCall('status',['--short'])).includes('status'));
    check('explicit same named path works', output(findCall('status',['--','status']))?.isError === false && text(findCall('status',['--','status'])).includes('status') && !text(findCall('status',['--','status'])).includes('probe-change.txt'));
    check('test changes intentionally discarded', job.status === 'completed' && nodes.cleanup.workspace.dispositions.some(d => d.executionId === result.nodes.probe.executionId && d.disposition === 'discarded') && !existsSync(join(cwd,'probe-change.txt')) && !existsSync(join(cwd,'status')));
    for (const name of ['find','grep']) if (nodes.probe.availableTools.includes(name)) {
      check(`${name}:available search actually succeeds`, [...toolResults].some(([id,m]) => id.startsWith('probe/') && m.toolName === name && !m.isError && JSON.stringify(m.content).includes(name === 'grep' ? 'argument guard marker' : 'probe-change.txt')));
    }
  }
  const summary = { case: scenario, jobId: job.jobId, status: job.status, graphStatus: result.status, latencyMs: result.metadata.latencyMs,
    parentCalls: calls.map(c => c.tool), nodes, toolErrors: errors, checks, passed: Object.values(checks).every(Boolean) };
  save(join(run, 'braid-call.json'), calls.filter(c => c.tool === 'braid').map(c => c.args));
  save(join(run, 'assertions.json'), checks); save(join(run, 'summary.json'), summary);
  return summary;
}

export function writeReport(root, runs, baseline, driverErrors = []) {
  const config = json(join(root, 'config.json'));
  const implementation = existsSync(join(root, 'implementation.json')) ? json(join(root, 'implementation.json')) : undefined;
  const summaries = runs.map(run => ({ run, ...json(join(run,'summary.json')) }));
  const link = (title, path) => `[${title}](${path})`;
  const total = key => summaries.reduce((sum,s) => sum + Object.values(s.checks).filter(key).length, 0);
  const lines = ['**Braid tool reliability: local Pi end-to-end report**', '',
    `${summaries.filter(s => s.passed).length}/${summaries.length} scenarios met expectations; ${total(Boolean)}/${total(() => true)} assertions passed.`, '',
    `Pi ${config.piVersion ?? '(see configuration)'}, model ${config.model}; detected search tools: grep=${config.searchTools?.grep}, find=${config.searchTools?.find}.`, '',
    'The parent agent and nodes call real models through local Pi. This suite checks that repeated Git commands are rejected before execution, same-named files can be queried explicitly, tool availability matches local dependencies, and worktrees are cleaned up after integration, failure, or cancellation.', '',
    'For partial-failure and merge-failure, the recorder injects provider failures after real tool operations. For cancel, it pauses the provider request after a real write to create a predictable cancellation window. The Git conflict comes from actual cherry-picks; model responses are not fabricated.', '',
    '| Scenario | Pi status | Node model responses / tool calls | Duration | Assertions |', '|---|---|---:|---:|---|'];
  if (driverErrors.length) lines.splice(3, 0, `Driver errors: ${driverErrors.length}. The table includes only scenarios with complete results; the overall suite failed. See driver-errors.json for details.`, '');
  const guarded = summaries.flatMap(s => s.toolErrors).filter(e => JSON.stringify(e).includes('DUPLICATE_GIT_COMMAND')).length;
  const intentional = summaries.filter(s => s.case === 'git-arguments').flatMap(s => s.toolErrors).filter(e => JSON.stringify(e).includes('DUPLICATE_GIT_COMMAND')).length;
  const dependencyErrors = summaries.flatMap(s => s.toolErrors).filter(e => /could not be downloaded|no longer available/.test(JSON.stringify(e))).length;
  const cleaned = summaries.filter(s => s.case !== 'non-git').every(s => s.checks['no leaked registered worktrees'] && s.checks['node directories removed'] && s.checks['temporary workspace roots removed']);
  const worktreeCount = summaries.flatMap(s => Object.values(s.nodes)).filter(n => n.workspace?.worktreeRoot).length;
  lines.splice(6, 0, `Repeated-command requests rejected: ${guarded} (${intentional} were intentional requests in the dedicated scenario). Execution errors due to missing search dependencies: ${dependencyErrors}. Node worktrees: ${worktreeCount}; all cleaned up: ${cleaned ? 'yes' : 'no'}.`, '');
  lines.splice(6, 0, 'Implementation: shared Git argument validation rejects requests whose first argument repeats the command before execution. Pi builds the search tool list from local dependencies and checks availability again before execution. The live test driver, prompts, assertions, and report generator are included in the repository.', `To rerun: ${link('test instructions',join(dirname(config.extension),'test/live/README.md'))}.`, '');
  if (implementation) lines.splice(6, 0, `Regression tests passed: ${implementation.coreTests} core tests and ${implementation.piTests} Pi tests. Implementation record: ${link('implementation.json',join(root,'implementation.json'))}.`, '');
  for (const s of summaries) {
    const nodes=Object.values(s.nodes);
    lines.push(`| ${s.case} | ${s.status} | ${nodes.reduce((n,v)=>n+v.modelCalls,0)} / ${nodes.reduce((n,v)=>n+v.toolCalls,0)} | ${(s.latencyMs/1000).toFixed(1)}s | ${s.passed?'passed':'failed'} |`);
  }
  lines.push('', 'failed/cancelled may be expected terminal states in failure scenarios. Cancellation is represented as failed + CANCELLED in core and cancelled in Pi. Durations exclude the parent agent\'s graph construction and reporting; model response counts exclude requests intercepted by injected failures or pauses. Individual model runs vary, so durations and call counts are not a stable performance benchmark.', '');
  if (baseline && existsSync(baseline)) {
    lines.push('Comparison with matching scenarios from the previous run:', '', '| Scenario | Duration: previous → current | Node tool calls: previous → current | Identical prompt |', '|---|---:|---:|---|');
    for (const s of summaries) {
      const before = readdirSync(baseline).find(name=>name.startsWith(s.case+'-') && existsSync(join(baseline,name,'summary.json')));
      if (!before) continue;
      const a=json(join(baseline,before,'summary.json'));
      lines.push(`| ${s.case} | ${(a.latencyMs/1000).toFixed(1)}s → ${(s.latencyMs/1000).toFixed(1)}s | ${Object.values(a.nodes).reduce((n,v)=>n+v.toolCalls,0)} → ${Object.values(s.nodes).reduce((n,v)=>n+v.toolCalls,0)} | ${readFileSync(join(baseline,before,'prompt.txt'),'utf8') === readFileSync(join(s.run,'prompt.txt'),'utf8') ? 'yes' : 'no'} |`);
    }
    lines.push('');
  }
  lines.push(`Run configuration: ${link('config.json',join(root,'config.json'))}. Tests cover controlled termination only; they do not cover forced process termination, cross-process merge coordination, cleanup permission failures, or a model choosing to archive changes after abandoning conflict resolution.`, '');
  for (const s of summaries) {
    lines.push(`**${s.case}**`, '', 'Full test prompt:', '', '```text', readFileSync(join(s.run,'prompt.txt'),'utf8'), '```', '',
      'Actual braid arguments:', '', '```json', readFileSync(join(s.run,'braid-call.json'),'utf8'), '```', '',
      '| Node | Status | Model responses | Tool calls | Workspace disposition |', '|---|---|---:|---:|---|');
    for (const [id,n] of Object.entries(s.nodes)) lines.push(`| \`${id}\` | ${n.status} | ${n.modelCalls} | ${n.toolCalls} | ${n.workspace?.worktreeRoot ? n.workspace.state : '—'} |`);
    lines.push('', `Parent tool sequence: ${s.parentCalls.join(' → ')}`, '',
      ['prompt.txt','braid-call.json','nodes.jsonl','rpc.jsonl','verification.json','braid-result.json','assertions.json','summary.json'].map(name=>link(name,join(s.run,name))).join(' · '), '',
      'Tool errors (including expected argument rejections and conflicts, deduplicated by toolCallId):', '', '```json', JSON.stringify(s.toolErrors,null,2), '```', '');
    const failures=Object.entries(s.checks).filter(([,ok])=>!ok).map(([name])=>name);
    if (failures.length) lines.push('Failed assertions: '+failures.join('; '),'');
  }
  save(join(root,'driver-errors.json'),driverErrors);
  save(join(root,'suite-summary.json'),summaries);
  writeFileSync(join(root,'report.md'),lines.join('\n'));
  return driverErrors.length === 0 && summaries.length > 0 && summaries.every(s=>s.passed);
}
