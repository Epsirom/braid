import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scannerError = {
  exitCode: 2,
  message: "Dependency scanner failed; no complete audit result is available. See the npm output for details.",
};

/** npm uses exit 1 for both findings and scanner errors; require a complete report. */
export function auditOutcome(result) {
  if (result.error || result.signal || ![0, 1].includes(result.status)) return scannerError;
  let report;
  try { report = JSON.parse(result.stdout); }
  catch { return scannerError; }
  const counts = report?.metadata?.vulnerabilities;
  const severities = ["info", "low", "moderate", "high", "critical"];
  if (report?.error || report?.auditReportVersion !== 2 || !counts
    || !report.vulnerabilities || typeof report.vulnerabilities !== "object"
    || Array.isArray(report.vulnerabilities)
    || ![...severities, "total"].every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0)
    || severities.reduce((sum, key) => sum + counts[key], 0) !== counts.total
    || Object.keys(report.vulnerabilities).length !== counts.total) return scannerError;
  if (counts.total > 0) {
    return {
      exitCode: 1,
      message: `Dependency vulnerabilities found (including development dependencies): ${counts.total} affected packages; ${severities.map(key => `${counts[key]} ${key}`).join(", ")}.`,
    };
  }
  if (result.status !== 0) return scannerError;
  return { exitCode: 0, message: "Dependency audit completed: no known vulnerabilities found (including development dependencies)." };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const npm = process.env.npm_execpath;
  const result = npm ? spawnSync(process.execPath, [npm, "audit", "--json",
    "--include=dev", "--include=optional", "--include=peer", "--audit-level=info"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    encoding: "utf8", timeout: 120_000, maxBuffer: 10 * 1024 * 1024,
  }) : { error: new Error("Run this check with npm run audit:dependencies") };
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) console.error(result.error.message);
  const outcome = auditOutcome(result);
  console.log(outcome.message);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Dependency security\n\n${outcome.message}\n`);
  }
  process.exitCode = outcome.exitCode;
}
