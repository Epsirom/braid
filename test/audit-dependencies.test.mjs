import assert from "node:assert/strict";
import test from "node:test";
import { auditOutcome } from "../scripts/audit-dependencies.mjs";

function report(high = 0) {
  return {
    auditReportVersion: 2,
    vulnerabilities: high ? { "brace-expansion": { severity: "high", nodes: [
      "node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion",
    ] } } : {},
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high, critical: 0, total: high } },
  };
}
function result(data, status = 0) {
  return { status, stdout: JSON.stringify(data) };
}

test("only a successful, complete, empty audit is clean", () => {
  assert.equal(auditOutcome(result(report())).exitCode, 0);
});

test("development-tree findings fail even if npm exits zero", () => {
  for (const status of [0, 1]) {
    const outcome = auditOutcome(result(report(1), status));
    assert.equal(outcome.exitCode, 1);
    assert.match(outcome.message, /vulnerabilities found.*development dependencies.*1 high/);
  }
});

test("scanner crashes and registry errors are not classified as findings or a clean scan", () => {
  for (const failure of [
    result({ error: { summary: "Maximum call stack size exceeded" } }, 1),
    result({ error: { code: "ENOTFOUND", summary: "Registry unavailable" } }, 1),
    result({ ...report(), error: { code: "E500" } }),
    { status: 1, stdout: "" },
    { status: 0, stdout: "not JSON" },
    { ...result(report()), error: new Error("spawn failed") },
    { ...result(report()), error: new Error("ETIMEDOUT") },
    { ...result(report()), signal: "SIGTERM" },
    result(report(), null),
    result(report(), 2),
    result(report(), 1),
  ]) {
    const outcome = auditOutcome(failure);
    assert.equal(outcome.exitCode, 2);
    assert.match(outcome.message, /scanner failed/);
  }
});

test("incomplete or inconsistent audit reports cannot silently pass", () => {
  const missingCounts = report();
  delete missingCounts.metadata.vulnerabilities.high;
  for (const data of [
    null, {}, [], { metadata: { vulnerabilities: { total: 0 } } },
    { ...report(), auditReportVersion: 1 },
    { ...report(), vulnerabilities: [] },
    { ...report(1), vulnerabilities: {} },
    { ...report(), vulnerabilities: report(1).vulnerabilities },
    { ...report(), metadata: { vulnerabilities: { ...report().metadata.vulnerabilities, high: 1 } } },
    { ...report(), metadata: { vulnerabilities: { ...report().metadata.vulnerabilities, total: "0" } } },
    report(-1), missingCounts,
  ]) assert.equal(auditOutcome(result(data)).exitCode, 2);
});
