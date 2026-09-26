import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { analyze, writeReport } from './analyze.mjs';

const here=dirname(fileURLToPath(import.meta.url));
const repo=resolve(here,'../../../..');
const { values }=parseArgs({ options: {
  pi:{type:'string',default:process.env.BRAID_PI ?? 'pi'}, model:{type:'string'}, out:{type:'string'},
  cases:{type:'string',default:'selective-merge,partial-failure,non-git,real-conflict,merge-failure,cancel,git-arguments'},
  baseline:{type:'string'}, analyze:{type:'boolean',default:false}, help:{type:'boolean',default:false},
} });
if(values.help) {
  console.log('node integrations/pi/test/live/run.mjs --pi /path/to/pi --model provider/model [--out /tmp/results] [--cases case1,case2] [--baseline /tmp/previous] [--analyze]');
  process.exit(0);
}
const root=values.out ? resolve(values.out) : mkdtempSync(join(tmpdir(),'braid-live-'));
mkdirSync(root,{recursive:true});
const cases=values.cases.split(',');
const known=readdirSync(join(here,'prompts')).map(name=>name.replace(/\.txt$/,''));
if(!cases.length || cases.some(name=>!known.includes(name)) || new Set(cases).size!==cases.length) throw new Error('Choose distinct cases from: '+known.join(', '));
let config;
const configPath=join(root,'config.json');
if(existsSync(configPath)) {
  config=JSON.parse(readFileSync(configPath,'utf8'));
  if(values.model && config.model!==values.model) throw new Error('Existing output directory has a different model; choose a new --out directory.');
} else {
  if(!values.model) throw new Error('--model provider/model is required for live provider calls');
  config={pi:values.pi,model:values.model,extension:join(repo,'integrations/pi/index.ts')};
}
if(!values.analyze) {
  // Inspect only tool availability, without reading or exporting Pi credentials.
  const moduleUrl=pathToFileURL(join(repo,'integrations/pi/read-tools.ts')).href;
  config.searchTools=JSON.parse(execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',
    `import {detectSearchTools} from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(await detectSearchTools()));`],{cwd:repo,encoding:'utf8'}));
  config.piVersion=execFileSync(config.pi,['--version'],{encoding:'utf8'}).trim();
  config.nodeVersion=process.version;
  config.startedAt=new Date().toISOString();
  writeFileSync(configPath,JSON.stringify(config,null,2));
}
const driverErrors=[];
console.log('Artifacts:',root);
for(const scenario of cases) {
  const existing=readdirSync(root).find(name=>name.startsWith(scenario+'-') && existsSync(join(root,name,'verification.json')));
  if(existing || values.analyze) continue;
  console.log(new Date().toISOString(),'Starting',scenario);
  const stream=createWriteStream(join(root,scenario+'-console.log'),{flags:'a'});
  const child=spawn(process.execPath,[join(here,'run-case.mjs'),root,scenario],{cwd:repo,stdio:['ignore','pipe','pipe']});
  child.stdout.pipe(stream,{end:false});child.stderr.pipe(stream,{end:false});
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  stream.end();
  console.log(new Date().toISOString(),'Finished',scenario,'exit',code);
  if(code!==0) { driverErrors.push({case:scenario,error:`Pi harness exited with ${code}`}); process.exitCode=1; }
}
const runs=[];
for(const scenario of known) {
  const match=readdirSync(root).find(name=>name.startsWith(scenario+'-') && existsSync(join(root,name,'verification.json')));
  if(!match) { if(cases.includes(scenario)) { console.error('Missing result:',scenario);driverErrors.push({case:scenario,error:'Missing terminal result'});process.exitCode=1; } continue; }
  const run=join(root,match);
  try {
    const summary=analyze(run,config.searchTools);runs.push(run);
    console.log(scenario,summary.status,Object.values(summary.checks).filter(Boolean).length+'/'+Object.keys(summary.checks).length,'assertions');
    if(!summary.passed) process.exitCode=1;
  } catch(error) { console.error('Analysis failed:',scenario,error);driverErrors.push({case:scenario,error:String(error)});process.exitCode=1; }
}
if(!writeReport(root,runs,values.baseline ? resolve(values.baseline) : undefined, driverErrors)) process.exitCode=1;
console.log('Report:',join(root,'report.md'));
