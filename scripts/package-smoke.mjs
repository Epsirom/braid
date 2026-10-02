import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const root = fileURLToPath(new URL("../", import.meta.url));
const piRoot = join(root, "integrations/pi");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const piManifest = JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8"));
const npm = process.env.npm_execpath;
assert.ok(npm, "Run this check with npm run test:package");
const temp = mkdtempSync(join(tmpdir(), "braid-package-"));
function run(args, cwd = root) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, stdio: ["ignore", "pipe", "inherit"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => { output += chunk; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(output) : reject(new Error(`Command failed (${code}): ${args.join(" ")}\n${output}`)));
  });
}
async function pack(cwd) {
  const [result] = JSON.parse(await run([npm, "pack", "--silent", "--json", "--pack-destination", temp], cwd));
  assert.ok(result.files.some(file => file.path === "LICENSE"));
  assert.ok(!result.files.some(file => /(?:^|\/)(?:node_modules|test|\.env)(?:\/|$)/.test(file.path)));
  return result;
}
let registry;

try {
  // A removed source file must never survive a rebuild into a published package.
  for (const cwd of [root, piRoot]) {
    mkdirSync(join(cwd, "dist"), { recursive: true });
    writeFileSync(join(cwd, "dist/__stale_build_sentinel.js"), "throw new Error('stale build');\n");
  }
  const core = await pack(root);
  const pi = await pack(piRoot);
  const expectedCore = readdirSync(join(root, "src"), { recursive: true })
    .filter(path => path.endsWith(".ts"))
    .flatMap(path => ["dist/" + path.replaceAll("\\", "/").replace(/\.ts$/, ".js"), "dist/" + path.replaceAll("\\", "/").replace(/\.ts$/, ".d.ts")]);
  assert.deepEqual(core.files.filter(file => file.path.startsWith("dist/")).map(file => file.path).sort(), expectedCore.sort());
  assert.ok(!pi.files.some(file => file.path.includes("__stale_build_sentinel")));
  assert.equal(manifest.version, piManifest.version, "Core and Pi release together");
  assert.equal(piManifest.dependencies[manifest.name], manifest.version);
  const expectedPi = readdirSync(piRoot).filter(path => path.endsWith(".ts"))
    .map(path => "dist/" + path.replace(/\.ts$/, ".js"));
  assert.deepEqual(pi.files.filter(file => file.path.startsWith("dist/")).map(file => file.path).sort(), expectedPi.sort());
  for (const file of expectedPi) {
    assert.ok(!/from ["'][^"']*(?:\.\.\/src|\.\.\/\.\.\/src)/.test(readFileSync(join(piRoot, file), "utf8")));
  }

  // Serve only this unpublished core tarball. npm must fetch it transitively
  // from Pi's normal version dependency; the consumer never installs core explicitly.
  let origin;
  let downloads = 0;
  registry = createServer((request, response) => {
    const path = decodeURIComponent(request.url.split("?")[0]);
    if (path === `/${manifest.name}`) {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ name: manifest.name, "dist-tags": { latest: manifest.version },
        versions: { [manifest.version]: { ...manifest, dist: {
          tarball: `${origin}/core.tgz`, integrity: core.integrity, shasum: core.shasum,
        } } },
      }));
    } else if (path === "/core.tgz") {
      downloads++;
      response.end(readFileSync(join(temp, core.filename)));
    } else { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => registry.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${registry.address().port}`;


  const consumer = join(temp, "consumer");
  mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  const peers = Object.fromEntries(Object.keys(piManifest.peerDependencies).map(name => [name, piManifest.devDependencies[name]]));
  await run([npm, "install", "--no-audit", "--no-fund", `--@chrok:registry=${origin}`, "--cache", join(temp, "npm-cache"), join(temp, pi.filename), ...Object.entries(peers).map(([name, version]) => `${name}@${version}`)], consumer);
  assert.ok(downloads > 0, "Pi installation must download its core dependency");
  const consumerManifest = JSON.parse(readFileSync(join(consumer, "package.json"), "utf8"));
  assert.ok(!consumerManifest.dependencies[manifest.name], "Core must be transitive");
  assert.equal(JSON.parse(readFileSync(join(consumer, "node_modules", manifest.name, "package.json"))).version, manifest.version);
  const installed = join(consumer, "node_modules", piManifest.name);
  const installedManifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  for (const entry of installedManifest.pi.extensions) {
    assert.ok(readFileSync(resolve(installed, entry)).length > 0);
  }
  writeFileSync(join(consumer, "check.mjs"), `
    import assert from 'node:assert/strict';
    import { braid, startBraid, formatBudgetReminder, gitToolDefinition, finishMergeToolDefinition,
      mergeInstructions, parseGitToolArguments, parseFinishMergeArguments } from ${JSON.stringify(manifest.name)};
    for (const helper of [formatBudgetReminder, gitToolDefinition, finishMergeToolDefinition,
      mergeInstructions, parseGitToolArguments, parseFinishMergeArguments]) assert.equal(typeof helper, 'function');
    import { createOpenAICompatibleRunner } from ${JSON.stringify(manifest.name + "/adapters/openai")};
    import extension from ${JSON.stringify(piManifest.name)};
    assert.equal(typeof createOpenAICompatibleRunner(), 'function');
    const tools = new Map();
    const handlers = new Map();
    let finished;
    const completion = new Promise(resolve => { finished = resolve; });
    extension({ registerTool: t => tools.set(t.name, t), registerCommand() {}, on: (event, handler) => handlers.set(event, handler), sendMessage: finished });
    assert.deepEqual([...tools.keys()].sort(), ['braid', 'braid_cancel', 'braid_resume', 'braid_status', 'braid_update']);
    const result = await braid({ goal: 'smoke', nodes: [{ type: 'execute', id: 'a', prompt: 'PASS' }], edges: [] }, { runner: async () => ({ output: 'PASS' }) });
    assert.equal(result.terminalOutputs.a.output, 'PASS');
    assert.equal(result.status, 'completed');
    assert.equal(typeof startBraid, 'function');
    assert.equal(Object.keys(result.executions).length, 1);
    assert.equal(result.terminalExecutionIds[0], result.nodes.a.executionId);
    const model = { provider: 'fake', id: 'model', contextWindow: 10000 };
    const context = { cwd: process.cwd(), model, modelRegistry: {
      find: () => model,
      complete: async () => ({ role: 'assistant', api: 'fake', provider: 'fake', model: 'model',
        content: [{ type: 'text', text: 'PI PASS' }], stopReason: 'stop', timestamp: 0,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }),
    } };
    const submitted = await tools.get('braid').execute('smoke', { goal: 'smoke', nodes: [{ type: 'execute', id: 'a', prompt: 'PASS' }], edges: [] }, undefined, undefined, context);
    let timer;
    try {
      await Promise.race([completion, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Packaged Pi job did not finish')), 10000); })]);
      const final = await tools.get('braid_status').execute('status', { jobId: submitted.details.jobId });
      assert.equal(final.details.result.status, 'completed');
      assert.equal(final.details.result.terminalOutputs.a.output, 'PI PASS');
    } finally { clearTimeout(timer); handlers.get('session_shutdown')(); }
  `);
  await run([join(consumer, "check.mjs")], consumer);
  writeFileSync(join(consumer, "check.mts"), `
    import { braid, startBraid, formatBudgetReminder, gitToolDefinition, finishMergeToolDefinition, mergeInstructions, parseGitToolArguments, parseFinishMergeArguments, type BraidInput, type BraidNode, type BraidInputNode, type NodePrompt, type PromptTemplateReference, type ModelRunner, type BraidRun, type GraphUpdate, type NodeExecution, type IntegrateNode } from ${JSON.stringify(manifest.name)};
    import { createOpenAICompatibleRunner } from ${JSON.stringify(manifest.name + "/adapters/openai")};
    const node: BraidNode = { type: 'execute', id: 'a', prompt: 'PASS' };
    const input: BraidInput = { goal: 'smoke', nodes: [node], edges: [] };
    const integration: IntegrateNode = { type: 'integrate', id: 'apply', requireSuccess: true };
    const patch: GraphUpdate = { expectedRevision: 0, upsertNodes: [integration] };
    const run: BraidRun = startBraid(input, { runner: async () => ({ output: 'ok' }) });
    run.update(patch);
    const reference: PromptTemplateReference = { template: 'inspect', variables: { target: 'runtime' } };
    const prompt: NodePrompt = reference;
    const templated: BraidInputNode = { type: 'execute', id: 'a', prompt };
    const runner: ModelRunner = createOpenAICompatibleRunner();
    void braid(input, { runner });
    void braid({ goal: 'smoke', promptTemplates: { inspect: 'Inspect {{target}}.' }, nodes: [templated], edges: [] }, { runner });
    const request: Parameters<ModelRunner>[0] = { goal: 'smoke', node, predecessors: [], execution: { runId: 'smoke', rootRunId: 'smoke' }, signal: new AbortController().signal };
    const rendered: string = request.node.prompt!;
    const reminder: string = formatBudgetReminder(request);
    const instructions: string = mergeInstructions(request);
    const args: { args: string[]; input?: string } = parseGitToolArguments({ command: 'status', args: [] }, false);
    gitToolDefinition(false); finishMergeToolDefinition(['a']);
    parseFinishMergeArguments({ dispositions: [{ executionId: 'a', disposition: 'discarded', reason: 'test' }] }, ['a']);
  `);
  await run([join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--skipLibCheck", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", "check.mts"], consumer);
  console.log(`Package smoke passed: ${core.id} (${core.entryCount} files), ${pi.id} (${pi.entryCount} files). Public imports, types, a Pi background job, and clean builds verified outside the checkout.`);
} finally {
  if (registry) await new Promise((resolve, reject) => registry.close(error => error ? reject(error) : resolve()));
  rmSync(temp, { recursive: true, force: true });
}
