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
      availableTools: requests.get(id)?.tools.map(t => t.name) ?? [], workspace: result.workspaces?.[id] }];
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
      const ids = sources.map(s => s.nodeId);
      const schema = req.tools.find(t => t.name === 'finish_merge').parameters.properties.dispositions;
      check(`${id}:scoped finish schema`, equal(schema.items.properties.nodeId.enum ?? [], ids) && schema.minItems === ids.length && schema.maxItems === ids.length);
      check(`${id}:bounded previews supplied`, sources.every(s => s.changes && s.changes.diff.text.length <= 6000 && !s.changes.files.some(f => ['user.txt','notes.txt'].includes(f))));
      check(`${id}:source status supplied`, req.payload.sourceCheckoutStatus?.dirty === (scenario !== 'real-conflict'));
      check(`${id}:only current sources finalized`, nodes[id].tools.filter(c => c.name === 'finish_merge').every(c => equal(c.arguments.dispositions.map(d => d.nodeId).sort(), [...ids].sort())));
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
    check('expected topology', equal(Object.keys(nodes).sort(), ['numeric','alternative','docs','select','__braid_merge__'].sort()));
    check('all nodes completed', job.status === 'completed' && Object.values(nodes).every(n => n.status === 'completed'));
    check('correct source selected', nodes.numeric.workspace.state === 'integrated' && nodes.alternative.workspace.state === 'discarded');
    check('automatic merge integrated docs', nodes.docs.workspace.state === 'integrated' && verification.files['README.md'].includes('Supports numeric strings.'));
    check('actual arithmetic correct', equal(verification.addValues, [5,5]));
    const initial = log.find(r => r.kind === 'source_before_merge_agent' && r.nodeId === 'select');
    check('no integration before agent starts', initial?.files['calculator.cjs'] === 'exports.add = (a, b) => a - b;\n' && initial?.files['README.md'] === '# Calculator\n');
    const snapshot = nodes.numeric.workspace.snapshotCommit;
    check('dirty snapshot captured', git(cwd, 'show', `${snapshot}:user.txt`) === 'unstaged user content' && git(cwd, 'show', `${snapshot}:notes.txt`) === 'non-ignored user note');
    check('ignored file excluded', git(cwd, 'ls-tree', '--name-only', snapshot, 'ignored.txt') === '');
    check('distinct node worktrees', new Set(['numeric','alternative','docs'].map(id => nodes[id].workspace.worktreeRoot)).size === 3);
  } else if (scenario === 'partial-failure') {
    check('injected failure retained', job.status === 'failed' && nodes.fragile.error?.code === 'MODEL_ERROR' && nodes.fragile.error?.message === 'LIVE_TEST_INJECTED_PROVIDER_FAILURE_AFTER_WRITE');
    check('downstream agents executed', nodes.reviewer.status === 'completed' && nodes.recover.status === 'completed');
    check('both partial files recovered', verification.files['partial.txt'] === 'recoverable partial change\n' && verification.files['review.txt']?.includes('LIVE_TEST_INJECTED_PROVIDER_FAILURE_AFTER_WRITE'));
    check('both sources integrated', ['fragile','reviewer'].every(id => nodes[id].workspace.state === 'integrated'));
  } else if (scenario === 'non-git') {
    check('read only tools', nodes.probe.availableTools.includes('read') && nodes.probe.availableTools.includes('ls') && nodes.probe.availableTools.every(n => ['read','ls','grep','find'].includes(n)));
    check('no forbidden write', !existsSync(join(cwd, 'forbidden.txt')));
    check('no worktree or automatic merge', job.status === 'completed' && equal(Object.keys(nodes), ['probe']) && !Object.keys(result.workspaces ?? {}).length);
  } else if (scenario === 'real-conflict') {
    check('actual Git conflict observed', errors.some(e => JSON.stringify(e).includes('CONFLICT')));
    check('agent continued cherry-pick', nodes.resolve.tools.some(c => c.name === 'git' && c.arguments.command === 'cherry-pick' && c.arguments.args.includes('--continue')));
    check('both changes preserved', job.status === 'completed' && equal(verification.settings, { precision: 3, label: 'shipping' }));
    check('no unmerged index entries', verification.unmerged === '');
    check('both sources integrated', ['left','right'].every(id => nodes[id].workspace.state === 'integrated'));
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
      check('no automatic merge', equal(Object.keys(nodes), ['worker']));
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
    check('test changes intentionally discarded', job.status === 'completed' && nodes.probe.workspace.state === 'discarded' && !existsSync(join(cwd,'probe-change.txt')) && !existsSync(join(cwd,'status')));
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
  const lines = ['**Braid 工具可靠性：本机 Pi 端到端报告**', '',
    `${summaries.filter(s => s.passed).length}/${summaries.length} 个场景符合预期；${total(Boolean)}/${total(() => true)} 项断言通过。`, '',
    `Pi ${config.piVersion ?? '见配置'}，模型 ${config.model}；检测到 grep=${config.searchTools?.grep}、find=${config.searchTools?.find}。`, '',
    '父 agent 和节点均通过本机 Pi 调用真实模型。本轮检查重复 Git 命令不会执行、同名文件可以显式查询、工具列表与本机依赖相符，以及合并/失败/取消后的工作树清理。', '',
    'partial-failure 和 merge-failure 的 provider 故障为记录器在真实工具操作后注入；cancel 在真实写入后暂停 provider 请求以稳定制造取消窗口。Git 冲突是真实 cherry-pick 产生，模型回复未伪造。', '',
    '| 场景 | Pi 状态 | 节点模型响应 / 工具调用 | 耗时 | 断言 |', '|---|---|---:|---:|---|'];
  if (driverErrors.length) lines.splice(3, 0, `驱动错误：${driverErrors.length} 项。下表只统计有完整结果的场景；整轮测试失败。详情见 driver-errors.json。`, '');
  const guarded = summaries.flatMap(s => s.toolErrors).filter(e => JSON.stringify(e).includes('DUPLICATE_GIT_COMMAND')).length;
  const intentional = summaries.filter(s => s.case === 'git-arguments').flatMap(s => s.toolErrors).filter(e => JSON.stringify(e).includes('DUPLICATE_GIT_COMMAND')).length;
  const dependencyErrors = summaries.flatMap(s => s.toolErrors).filter(e => /could not be downloaded|no longer available/.test(JSON.stringify(e))).length;
  const cleaned = summaries.filter(s => s.case !== 'non-git').every(s => s.checks['no leaked registered worktrees'] && s.checks['node directories removed'] && s.checks['temporary workspace roots removed']);
  const worktreeCount = summaries.flatMap(s => Object.values(s.nodes)).filter(n => n.workspace?.worktreeRoot).length;
  lines.splice(6, 0, `本轮重复命令拒绝 ${guarded} 次（${intentional} 次是专项场景的故意请求）；缺失搜索依赖的执行错误 ${dependencyErrors} 次。共 ${worktreeCount} 个节点 worktree，全部清理：${cleaned ? '是' : '否'}。`, '');
  lines.splice(6, 0, '本轮实现：共享 Git 参数校验在执行前拒绝首个参数与命令重复的请求；Pi 按本机依赖生成搜索工具列表，并在执行前复查；真实测试驱动、原始 prompt、断言和报告生成器已纳入仓库。', `复跑方法：${link('测试说明',join(dirname(config.extension),'test/live/README.md'))}。`, '');
  if (implementation) lines.splice(6, 0, `回归测试：core ${implementation.coreTests} 项、Pi ${implementation.piTests} 项通过。实现记录：${link('implementation.json',join(root,'implementation.json'))}。`, '');
  for (const s of summaries) {
    const nodes=Object.values(s.nodes);
    lines.push(`| ${s.case} | ${s.status} | ${nodes.reduce((n,v)=>n+v.modelCalls,0)} / ${nodes.reduce((n,v)=>n+v.toolCalls,0)} | ${(s.latencyMs/1000).toFixed(1)}s | ${s.passed?'通过':'失败'} |`);
  }
  lines.push('', 'failed/cancelled 可以是故障测试的预期终态；取消在 core 中为 failed + CANCELLED，在 Pi 显示为 cancelled。耗时不含父 agent 构图/汇报，模型响应计数不含被注入故障或暂停拦截的请求。单次模型运行存在波动，耗时和调用数不能视为稳定性能基准。', '');
  if (baseline && existsSync(baseline)) {
    lines.push('与上一轮相同场景对比：', '', '| 场景 | 耗时：上轮 → 本轮 | 节点工具调用：上轮 → 本轮 | Prompt 一致 |', '|---|---:|---:|---|');
    for (const s of summaries) {
      const before = readdirSync(baseline).find(name=>name.startsWith(s.case+'-') && existsSync(join(baseline,name,'summary.json')));
      if (!before) continue;
      const a=json(join(baseline,before,'summary.json'));
      lines.push(`| ${s.case} | ${(a.latencyMs/1000).toFixed(1)}s → ${(s.latencyMs/1000).toFixed(1)}s | ${Object.values(a.nodes).reduce((n,v)=>n+v.toolCalls,0)} → ${Object.values(s.nodes).reduce((n,v)=>n+v.toolCalls,0)} | ${readFileSync(join(baseline,before,'prompt.txt'),'utf8') === readFileSync(join(s.run,'prompt.txt'),'utf8') ? '是' : '否'} |`);
    }
    lines.push('');
  }
  lines.push(`运行配置：${link('config.json',join(root,'config.json'))}。测试仅覆盖可控终止；不覆盖进程强杀、跨进程合并协调、清理权限故障或模型放弃冲突解决后主动归档。`, '');
  for (const s of summaries) {
    lines.push(`**${s.case}**`, '', '完整测试 prompt：', '', '```text', readFileSync(join(s.run,'prompt.txt'),'utf8'), '```', '',
      '实际 braid 参数：', '', '```json', readFileSync(join(s.run,'braid-call.json'),'utf8'), '```', '',
      '| 节点 | 状态 | 模型响应 | 工具调用 | 工作区 disposition |', '|---|---|---:|---:|---|');
    for (const [id,n] of Object.entries(s.nodes)) lines.push(`| \`${id}\` | ${n.status} | ${n.modelCalls} | ${n.toolCalls} | ${n.workspace?.worktreeRoot ? n.workspace.state : '—'} |`);
    lines.push('', `父工具序列：${s.parentCalls.join(' → ')}`, '',
      ['prompt.txt','braid-call.json','nodes.jsonl','rpc.jsonl','verification.json','braid-result.json','assertions.json','summary.json'].map(name=>link(name,join(s.run,name))).join(' · '), '',
      '工具错误（包含预期的参数拒绝/冲突，按 toolCallId 去重）：', '', '```json', JSON.stringify(s.toolErrors,null,2), '```', '');
    const failures=Object.entries(s.checks).filter(([,ok])=>!ok).map(([name])=>name);
    if (failures.length) lines.push('未通过断言：'+failures.join('；'),'');
  }
  save(join(root,'driver-errors.json'),driverErrors);
  save(join(root,'suite-summary.json'),summaries);
  writeFileSync(join(root,'report.md'),lines.join('\n'));
  return driverErrors.length === 0 && summaries.length > 0 && summaries.every(s=>s.passed);
}
