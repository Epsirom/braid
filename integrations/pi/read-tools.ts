import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";
import { createFindTool, createGrepTool, createLsTool, createReadTool, getAgentDir } from "@earendil-works/pi-coding-agent";

const exec = promisify(execFile);
export interface SearchEnvironment {
  binDir?: string;
  path?: string;
}

/** Match Pi's local-bin/PATH precedence without calling its downloading ensureTool(). */
export async function detectSearchTools(environment: SearchEnvironment = {}): Promise<{ grep: boolean; find: boolean }> {
  const binDir = environment.binDir ?? join(getAgentDir(), "bin");
  const directories = (environment.path ?? process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const suffix = process.platform === "win32" ? ".exe" : "";
  const available = async (name: string, aliases: string[]): Promise<boolean> => {
    const cached = join(binDir, name + suffix);
    // Pi prefers an existing cached binary even when it is broken. Do not advertise
    // a working PATH fallback that the actual SDK tool would never select.
    const candidates = existsSync(cached) ? [cached] : aliases.flatMap(alias => directories.map(dir => resolve(dir, alias + suffix)));
    for (const binary of candidates) {
      if (!existsSync(binary)) continue;
      try {
        await exec(binary, ["--version"], { timeout: 1_500, maxBuffer: 16_384 });
        return true;
      } catch { /* Missing, non-executable, or broken dependencies stay unavailable. */ }
    }
    return false;
  };
  const [grep, find] = await Promise.all([available("rg", ["rg"]), available("fd", ["fd", "fdfind"])]);
  return { grep, find };
}

export async function createAvailableReadTools(cwd: string, environment: SearchEnvironment = {}) {
  const available = await detectSearchTools(environment);
  const guarded = <T extends ReturnType<typeof createFindTool> | ReturnType<typeof createGrepTool>>(tool: T, name: "find" | "grep"): T => {
    const execute = tool.execute;
    return { ...tool, async execute(...args: Parameters<T["execute"]>) {
      // A dependency may have disappeared since the node received its tool schema.
      args[2]?.throwIfAborted();
      if (!(await detectSearchTools(environment))[name])
        throw new Error(`${name} dependency is no longer available. Use ls and read; Braid will not install it for this call.`);
      args[2]?.throwIfAborted();
      return execute(args[0], args[1], args[2], args[3]);
    } };
  };
  const tools = [
    createReadTool(cwd),
    ...(available.grep ? [guarded(createGrepTool(cwd), "grep")] : []),
    ...(available.find ? [guarded(createFindTool(cwd), "find")] : []),
    createLsTool(cwd),
  ];
  const missing = [!available.find && "find (fd)", !available.grep && "grep (rg)"].filter(Boolean);
  const guidance = `You may inspect the project with ${tools.map(tool => tool.name).join(", ")}. ` +
    (missing.length ? `Unavailable dependencies: ${missing.join(", ")}. These tools are not exposed; use ls to discover paths and read to inspect contents. Do not try to install tools. ` : "");
  return { tools, guidance };
}
