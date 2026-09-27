import { writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BraidJobs } from "../integrations/pi/jobs.js";
import { BraidPanel } from "../integrations/pi/command.js";

const jobs = new BraidJobs();
const cwd = await mkdtemp(join(tmpdir(), "braid-panel-demo-"));
const model = { provider: "demo", id: "offline", contextWindow: 100_000 };
const ctx = {
  cwd, model,
  modelRegistry: {
    find: () => model,
    complete: async (): Promise<unknown> => ({
      role: "assistant", api: "fake" as never, provider: "demo", model: "offline",
      content: [{ type: "text", text: "Review complete; include cache-miss and error-path tests." }],
      stopReason: "stop", timestamp: 0,
      usage: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 30,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    }),
  },
} as unknown as Parameters<BraidJobs["start"]>[2];
const job = jobs.start({
  goal: "Review a cache change: independent checks, one recommendation",
  nodes: [
    { type: "execute", id: "correctness", prompt: "Review correctness." },
    { type: "execute", id: "tests", prompt: "Review test coverage." },
    { type: "execute", id: "review", prompt: "Synthesize both reviews." },
  ],
  edges: [{ from: "correctness", to: "review" }, { from: "tests", to: "review" }],
}, {}, ctx);
await jobs.wait(job.jobId);
const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text } as never;
const panel = new BraidPanel(jobs, { requestRender() {}, terminal: { rows: 38 } } as never, theme, () => {});
const lines = panel.render(106).map(line => line.replace(job.jobId, "demo-job (deterministic offline fixture)").replace(/\d+(?:\.\d+)?ms/g, "<1ms"));
panel.dispose(); jobs.dispose();
await rm(cwd, { recursive: true, force: true });
const escape = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1120" height="${lines.length * 20 + 90}" viewBox="0 0 1120 ${lines.length * 20 + 90}" role="img" aria-labelledby="title desc">
<title id="title">Braid Pi flow panel</title><desc id="desc">Actual panel renderer with a completed three-node offline review graph.</desc>
<rect width="100%" height="100%" rx="14" fill="#101722"/>
<text x="28" y="30" fill="#92b9ff" font-family="monospace" font-size="15">/braid · rendered offline demo · no model requests</text>
<g fill="#dbe6f5" font-family="Menlo, Consolas, monospace" font-size="16" xml:space="preserve">
${lines.map((line, i) => [...line].map((char, col) => char === " " ? "" : `<text x="${28 + col * 9.8}" y="${64 + i * 20}">${escape(char)}</text>`).join("")).join("\n")}
</g></svg>\n`;
await mkdir(new URL("../docs/assets/", import.meta.url), { recursive: true });
await writeFile(new URL("../docs/assets/pi-panel.svg", import.meta.url), svg);
console.log("Wrote docs/assets/pi-panel.svg from the actual Pi renderer.");
