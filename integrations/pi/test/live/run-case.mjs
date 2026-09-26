import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const root = process.argv[2];
const config = JSON.parse(readFileSync(join(root, 'config.json')));
const scenario = process.argv[3];
if (!['selective-merge','partial-failure','non-git','real-conflict','merge-failure','cancel','git-arguments'].includes(scenario)) throw new Error('Unknown case');
const run = join(root, `${scenario}-${Date.now()}`);
const cwd = join(run, 'fixture');
mkdirSync(cwd, { recursive: true });
const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
if (scenario !== 'non-git') {
  git('init','-b','main'); git('config','user.name','Braid live test'); git('config','user.email','live-test@localhost');
  git('config','commit.gpgsign','false');
  writeFileSync(join(cwd,'calculator.cjs'), scenario === 'real-conflict' ? 'exports.settings = { precision: 2, label: "base" };\n' : 'exports.add = (a, b) => a - b;\n');
  writeFileSync(join(cwd,'README.md'), '# Calculator\n');
  writeFileSync(join(cwd,'user.txt'), 'original user content\n');
  writeFileSync(join(cwd,'.gitignore'), 'ignored.txt\n');
  git('add','.'); git('commit','-m','fixture baseline');
  if (scenario !== 'real-conflict') {
  writeFileSync(join(cwd,'user.txt'), 'staged user content\n'); git('add','user.txt');
  writeFileSync(join(cwd,'user.txt'), 'unstaged user content\n');
  writeFileSync(join(cwd,'notes.txt'), 'non-ignored user note\n');
  writeFileSync(join(cwd,'ignored.txt'), 'ignored source file must not be copied\n');
  }
  writeFileSync(join(run,'index-before'),readFileSync(join(cwd,'.git/index')));
  writeFileSync(join(run,'status-before.txt'), git('status','--porcelain=v1'));
} else writeFileSync(join(cwd,'input.txt'),'read-only fixture\n');
const prompt = readFileSync(join(here, 'prompts', scenario + '.txt'), 'utf8');
writeFileSync(join(run,'prompt.txt'),prompt);
const args = ['--mode','rpc','--no-session','--offline','--no-extensions','--no-skills','--no-prompt-templates','--no-themes','--no-context-files',
  '--model',config.model,'--extension',config.extension,'--extension',join(here,'recorder.ts'), '--tools','braid,braid_status,braid_cancel,read,ls'];
writeFileSync(join(run,'invocation.json'),JSON.stringify({executable:config.pi,args,cwd,scenario},null,2));
console.log(JSON.stringify({kind:'started',run,cwd,scenario,model:config.model}));
const child = spawn(config.pi,args,{cwd,env:{...process.env,BRAID_LIVE_LOG:join(run,'nodes.jsonl'),BRAID_LIVE_CASE:scenario,PI_TELEMETRY:'0'},stdio:['pipe','pipe','pipe']});
let buffer='', terminal, promptSent=false, closing=false;
const calls=[];
const clean = value => Array.isArray(value) ? value.filter(item => item?.type !== 'thinking').map(clean) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => !['thinking','thinkingSignature'].includes(key)).map(([key,item]) => [key,clean(item)])) : value;
function send(value) { if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(value)+'\n'); }
function finish() {
  if (closing) return;
  closing=true;
  send({id:'messages',type:'get_messages'});
  setTimeout(()=>child.stdin.end(),500);
}
child.stderr.on('data',chunk=>appendFileSync(join(run,'stderr.log'),chunk));
child.stdout.on('data',chunk=> {
 buffer += chunk.toString();
 while (buffer.includes('\n')) {
  const index=buffer.indexOf('\n'); const line=buffer.slice(0,index); buffer=buffer.slice(index+1);
  let event; try { event=JSON.parse(line); } catch { appendFileSync(join(run,'stdout-other.log'),line+'\n'); continue; }
  if(event.type!=='message_update') appendFileSync(join(run,'rpc.jsonl'),JSON.stringify(clean(event))+'\n');
  if(event.type==='response' && event.id==='ready' && !promptSent) {
    promptSent=true; writeFileSync(join(run,'initial-state.json'),JSON.stringify(event,null,2)); send({id:'test',type:'prompt',message:prompt});
  }
  if(event.type==='tool_execution_start') {
    calls.push({tool:event.toolName,args:event.args,toolCallId:event.toolCallId});
    console.log(JSON.stringify({kind:'parent_tool',tool:event.toolName,args:event.args}));
  }
  if(event.type==='tool_execution_end' && event.toolName==='braid_status' && event.result?.details?.status!=='running' && event.result?.details?.result) {
    terminal=event.result.details; writeFileSync(join(run,'braid-result.json'),JSON.stringify(terminal,null,2));
    console.log(JSON.stringify({kind:'braid_finished',jobId:terminal.jobId,status:terminal.status,nodes:Object.fromEntries(Object.entries(terminal.result.nodes).map(([id,n])=>[id,n.status]))}));
  }
  if(event.type==='agent_settled') {
    console.log(JSON.stringify({kind:'parent_settled',hasResult:!!terminal}));
    if(terminal) finish();
  }
  if(event.type==='message_end' && event.message?.role==='assistant' && event.message?.stopReason==='error') {
    console.log(JSON.stringify({kind:'parent_error',message:event.message.errorMessage}));
  }
 }
});
send({id:'ready',type:'get_state'});
const timeout=setTimeout(()=>{console.log(JSON.stringify({kind:'harness_timeout'}));send({type:'abort'});child.stdin.end();},600_000);
child.on('exit',(code,signal)=>{
 clearTimeout(timeout);
 writeFileSync(join(run,'parent-calls.json'),JSON.stringify(calls,null,2));
 const files={}; for(const name of ['calculator.cjs','README.md','user.txt','notes.txt','ignored.txt','partial.txt','review.txt','input.txt','forbidden.txt','salvage.txt','cancelled.txt','probe-change.txt','status'])
  if(existsSync(join(cwd,name))) files[name]=readFileSync(join(cwd,name),'utf8');
 const verification={exitCode:code,signal,files,hasBraidResult:!!terminal};
 if(scenario!=='non-git') {
   verification.worktrees=git('worktree','list','--porcelain');
   verification.status=git('status','--porcelain=v1');
   verification.unmerged=git('ls-files','--unmerged');
   if (scenario==='real-conflict') verification.settings=JSON.parse(execFileSync(process.execPath,['-e','console.log(JSON.stringify(require(process.argv[1]).settings));',join(cwd,'calculator.cjs')],{encoding:'utf8'}));
   verification.cachedDiff=git('diff','--cached','--','user.txt');
   verification.refs=git('for-each-ref','--format=%(refname)','refs/braid/');
   if(scenario==='selective-merge') {
     try { verification.addValues=JSON.parse(execFileSync(process.execPath,['-e','const {add}=require(process.argv[1]);console.log(JSON.stringify([add(2,3),add("2","3")]));',join(cwd,'calculator.cjs')],{encoding:'utf8'})); } catch(error) { verification.addError=error.message; }
   }
 }
 writeFileSync(join(run,'verification.json'),JSON.stringify(verification,null,2));
 console.log(JSON.stringify({kind:'done',run,...verification}));
 process.exitCode=terminal ? 0 : 1;
});
