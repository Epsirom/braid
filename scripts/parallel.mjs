import { spawn } from "node:child_process";

// Runs each argument as a shell command at the same time. Output is buffered per
// command and printed when it finishes, so concurrent logs never interleave.
const commands = process.argv.slice(2);
const results = await Promise.all(commands.map(command => new Promise(resolve => {
  const started = Date.now();
  const child = spawn(command, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
  const output = [];
  child.stdout.on("data", chunk => output.push(chunk));
  child.stderr.on("data", chunk => output.push(chunk));
  child.on("error", error => output.push(Buffer.from(`${error.stack}\n`)));
  child.on("close", code => {
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    process.stdout.write(`\n=== ${command} (${code === 0 ? "passed" : `failed with ${code}`}, ${seconds}s)\n`);
    process.stdout.write(Buffer.concat(output));
    resolve(code);
  });
})));
const failed = results.filter(code => code !== 0).length;
if (failed) {
  console.error(`\n${failed} of ${commands.length} parallel commands failed.`);
  process.exit(1);
}
