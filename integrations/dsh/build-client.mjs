import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const directory = fileURLToPath(new URL(".", import.meta.url));
const result = spawnSync(process.execPath, [fileURLToPath(new URL("../../node_modules/typescript/bin/tsc", import.meta.url)),
  "-p", `${directory}tsconfig.client.json`, "--noEmit", "false", "--emitDeclarationOnly"], { stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
// DSH loads a closure factory, with React supplied by its shared module table.
await build({ entryPoints: [`${directory}client/index.tsx`], outfile: `${directory}dist/client.js`,
  bundle: true, platform: "browser", format: "cjs", target: "es2022", jsx: "automatic", sourcemap: true,
  external: ["react", "react/jsx-runtime"],
  banner: { js: 'window.__ModuleLoader__.load({ id: "@chrok/dsh-braid", factory: (require) => { var module = { exports: {} }; var exports = module.exports;' },
  footer: { js: "return module.exports; } });" },
});
