import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const piRoot = join(root, "integrations/pi");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const piManifest = JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8"));
const npm = process.env.npm_execpath;
assert.ok(npm, "Run this check with npm run test:package");
const temp = mkdtempSync(join(tmpdir(), "braid-package-"));
function run(args, cwd = root) {
  return execFileSync(process.execPath, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}
function pack(cwd) {
  const [result] = JSON.parse(run([npm, "pack", "--silent", "--json", "--pack-destination", temp], cwd));
  assert.ok(result.files.some(file => file.path === "LICENSE"));
  assert.ok(!result.files.some(file => /(?:^|\/)(?:node_modules|test|\.env)(?:\/|$)/.test(file.path)));
  return result;
}

try {
  // A removed source file must never survive a rebuild into a published package.
  for (const cwd of [root, piRoot]) {
    mkdirSync(join(cwd, "dist"), { recursive: true });
    writeFileSync(join(cwd, "dist/__stale_build_sentinel.js"), "throw new Error('stale build');\n");
  }
  const core = pack(root);
  const pi = pack(piRoot);
  const expectedCore = readdirSync(join(root, "src"), { recursive: true })
    .filter(path => path.endsWith(".ts"))
    .flatMap(path => ["dist/" + path.replaceAll("\\", "/").replace(/\.ts$/, ".js"), "dist/" + path.replaceAll("\\", "/").replace(/\.ts$/, ".d.ts")]);
  assert.deepEqual(core.files.filter(file => file.path.startsWith("dist/")).map(file => file.path).sort(), expectedCore.sort());
  assert.ok(!pi.files.some(file => file.path.includes("__stale_build_sentinel")));
  assert.equal(manifest.version, piManifest.version, "Core and bundled Pi runtime release together");

  const consumer = join(temp, "consumer");
  mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  const peers = Object.fromEntries(Object.keys(piManifest.peerDependencies).map(name => [name, piManifest.devDependencies[name]]));
  run([npm, "install", "--no-audit", "--no-fund", join(temp, core.filename), join(temp, pi.filename), ...Object.entries(peers).map(([name, version]) => `${name}@${version}`)], consumer);
  const installed = join(consumer, "node_modules", piManifest.name);
  const installedManifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  for (const entry of installedManifest.pi.extensions) {
    assert.ok(readFileSync(resolve(installed, entry)).length > 0);
  }
  writeFileSync(join(consumer, "check.mjs"), `
    import assert from 'node:assert/strict';
    import { braid } from ${JSON.stringify(manifest.name)};
    import { createOpenAICompatibleRunner } from ${JSON.stringify(manifest.name + "/adapters/openai")};
    import extension from ${JSON.stringify(piManifest.name)};
    assert.equal(typeof createOpenAICompatibleRunner(), 'function');
    const tools = new Map();
    const handlers = new Map();
    let finished;
    const completion = new Promise(resolve => { finished = resolve; });
    extension({ registerTool: t => tools.set(t.name, t), registerCommand() {}, on: (event, handler) => handlers.set(event, handler), sendMessage: finished });
    assert.deepEqual([...tools.keys()].sort(), ['braid', 'braid_cancel', 'braid_status']);
    const result = await braid({ goal: 'smoke', nodes: [{ type: 'execute', id: 'a', prompt: 'PASS' }], edges: [] }, { runner: async () => ({ output: 'PASS' }) });
    assert.equal(result.terminalOutputs.a.output, 'PASS');
    assert.equal(result.status, 'completed');
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
  run([join(consumer, "check.mjs")], consumer);
  writeFileSync(join(consumer, "check.mts"), `
    import { braid, type BraidInput, type ModelRunner } from ${JSON.stringify(manifest.name)};
    import { createOpenAICompatibleRunner } from ${JSON.stringify(manifest.name + "/adapters/openai")};
    const input: BraidInput = { goal: 'smoke', nodes: [{ type: 'execute', id: 'a', prompt: 'PASS' }], edges: [] };
    const runner: ModelRunner = createOpenAICompatibleRunner();
    void braid(input, { runner });
  `);
  run([join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--skipLibCheck", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", "check.mts"], consumer);
  console.log(`Package smoke passed: ${core.id} (${core.entryCount} files), ${pi.id} (${pi.entryCount} files). Public imports, types, a Pi background job, and clean builds verified outside the checkout.`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
