import assert from "node:assert/strict";
import test from "node:test";
import { classifyPullRequest } from "../scripts/classify-pr-label.mjs";

const label = (title, files = ["src/runtime.ts"], author = "Epsirom") => classifyPullRequest({ title, author, changedFiles: files.length, files });

test("release preparation and bot PRs are left out of release notes", () => {
  assert.equal(label("Prepare Braid 0.5.2 release", ["package.json", "CHANGELOG.md"]), "skip-changelog");
  assert.equal(label("Release 0.6.0", ["package.json"]), "skip-changelog");
  assert.equal(label("Update generated files", ["src/version.ts"], "github-actions[bot]"), "skip-changelog");
});

test("breaking changes are marked by title", () => {
  assert.equal(label("feat(pi)!: remove blocking mode"), "breaking-change");
  assert.equal(label("Breaking: pause on node timeout"), "breaking-change");
  assert.equal(label("[breaking-change] Rename events"), "breaking-change");
});

test("fixes are recognized by conventional and imperative titles", () => {
  assert.equal(label("fix(pi): distinguish loop handoffs from retry edges"), "bug");
  assert.equal(label("Prevent duplicate waiting reminders"), "bug");
});

test("documentation, dependency, and maintenance PRs are recognized by their files", () => {
  assert.equal(label("Clarify pause semantics", ["README.md", "docs/execution-control.md"]), "documentation");
  assert.equal(label("Bump the npm-minor-patch group with 3 updates", ["package-lock.json"], "dependabot[bot]"), "dependencies");
  assert.equal(label("Refresh lockfile", ["package.json", "package-lock.json"]), "dependencies");
  assert.equal(label("test: bound suspension test waits by time"), "maintenance");
  assert.equal(label("fix(test): pin Pi's packages in the smoke consumer"), "maintenance");
  assert.equal(label("Widen Pi CLI test timeouts", ["integrations/pi/test/cli.test.ts", "test/helpers.ts"]), "maintenance");
});

test("other changes default to features", () => {
  assert.equal(label("feat(pi): retry transient model errors"), "enhancement");
  assert.equal(label("Wake the parent when a graph has no active work", ["src/runtime.ts", "test/waiting.test.ts"]), "enhancement");
  // An incomplete file list is never treated as docs-only.
  assert.equal(classifyPullRequest({ title: "Large rewrite", author: "Epsirom", changedFiles: 4000, files: ["README.md"] }), "enhancement");
});
