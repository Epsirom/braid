import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";
import * as cordis from "@deepseek-ai/cordis";
import * as React from "react";
import * as jsx from "react/jsx-runtime";
const require = createRequire(import.meta.url);
function bundle(file) {
  let plugin;
  const shared = { "@deepseek-ai/cordis": cordis, react: React, "react/jsx-runtime": jsx };
  new Function("window", readFileSync(file, "utf8"))({ __ModuleLoader__: { load({ factory }) {
    plugin = factory(id => { assert.ok(id in shared, `Unexpected browser external: ${id}`); return shared[id]; });
  } } });
  assert.equal(typeof plugin.apply, "function"); return plugin;
}

test("built browser factory mounts native Remote namespace and tool/sidebar slots; unload withdraws services/styles", async () => {
  const dom = new JSDOM("<html><head></head><body></body></html>");
  globalThis.document = dom.window.document;
  const ctx = new cordis.Context();
  const entries = new Map(), tabs = new Map(), calls = [];
  const frame = { rows: [], job: null };
  try {
    await ctx.plugin(bundle(require.resolve("@deepseek-ai/dsh-typert-registry/client")));
    ctx.provide("connection", {
      registerGenerationSource: () => () => {}, start: () => ({ stop() {} }),
      rpc: {
        async call(base, endpoint, payload) { calls.push({ base, endpoint, payload }); return { ok: true, value: frame }; },
        async *open(base, endpoint, payload, signal) {
          calls.push({ base, endpoint, payload }); yield frame;
          if (!signal.aborted) await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
        },
      },
    });
    await ctx.plugin(bundle(require.resolve("@deepseek-ai/dsh-api-gateway/client")));
    // Slot owner boundaries are represented here; the real browser renderer supplies their props.
    ctx.provide("slots", {
      inject: (_name, register) => register(),
      register: (definition, Component) => { entries.set(`${definition.name}/${definition.key ?? ""}`, { definition, Component }); return () => { entries.delete(`${definition.name}/${definition.key ?? ""}`); }; },
    });
    let opened;
    ctx.provide("sidebarRight", { openTab: kind => { opened = kind; }, openTabIn: (sessionId, kind, options) => { opened = { sessionId, kind, options }; } });
    ctx.provide("sidebarRightTabs", { register: definition => { tabs.set(definition.id, definition); return () => { tabs.delete(definition.id); }; } });
    const fiber = await ctx.plugin(bundle(new URL("../dist/client.js", import.meta.url)));
    for (let i = 0; i < 30 && entries.size !== 7; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(entries.size, 7); assert.equal(tabs.get("@chrok/dsh-braid").kind, "braid");
    entries.get("conversation.session.header.actions/").definition.inject().open();
    assert.equal(opened, "braid");
    for (const name of ["braid", "braid_status", "braid_update", "braid_resume", "braid_cancel"]) {
      const entry = entries.get(`tool.call.toolview/${name}`);
      assert.ok(entry, `Missing tool renderer: ${name}`);
      entry.definition.inject("tool-owner").openBraid({ jobId: "recorded-job", executionId: "review@1" });
      assert.deepEqual(opened, { sessionId: "tool-owner", kind: "braid", options: { params: { jobId: "recorded-job", executionId: "review@1" } } });
    }
    const face = entries.get("sidebar.right.pane.tab/@chrok/dsh-braid").definition.inject("owner-session");
    assert.equal(face.sessionId, "owner-session");
    const request = { sessionId: face.sessionId, jobId: "job-uuid", revision: 2, action: "resume", executionIds: ["review@1"] };
    assert.deepEqual(await face.api.control(request), frame);
    assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), { base: "/api", endpoint: "braidPanel/control", payload: { args: { request } } });
    const abort = new AbortController();
    const iterator = face.api.watch({ sessionId: face.sessionId }, abort.signal)[Symbol.asyncIterator]();
    assert.deepEqual((await iterator.next()).value, frame);
    abort.abort(); await iterator.return();
    assert.ok(document.querySelector('style[data-plugin="@chrok/dsh-braid"]'));
    await fiber.dispose();
    assert.equal(entries.size, 0); assert.equal(tabs.size, 0);
    assert.equal(document.querySelector('style[data-plugin="@chrok/dsh-braid"]'), null);
    assert.equal(ctx.get("remote.braidPanel"), undefined);
  } finally { await ctx.fiber.dispose(); dom.window.close(); delete globalThis.document; }
});
