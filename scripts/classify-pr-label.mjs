import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Labels that place a PR in a section of the generated release notes (.github/release.yml). */
export const RELEASE_LABELS = ["breaking-change", "enhancement", "bug", "documentation", "dependencies", "maintenance", "skip-changelog"];

const RELEASE_TITLE = /^(prepare|release)\b.*\bv?\d+\.\d+\.\d+\b/i;
const BREAKING_TITLE = /^(breaking(?:[ -]change)?\s*[:!-]|\[breaking(?:[ -]change)?\]|\w+(\([^)]*\))?!:)/i;
const DOCS_TITLE = /^docs(\([^)]*\))?:/i;
const DEPENDENCY_TITLE = /^(bump\b|(build|chore)\(deps(-dev)?\):|(update|upgrade)\s+(dependencies|dependency|packages?)\b)/i;
const MAINTENANCE_TITLE = /^((test|ci|build|chore|refactor|style)(\([^)]*\))?|\w+\((tests?|ci)\)):/i;
const FIX_TITLE = /^(fix(\([^)]*\))?:|(fix|repair|restore|prevent|correct|resolve|harden)\b)/i;

const isDocumentation = path => path.endsWith(".md") || path === "LICENSE" || path.startsWith("docs/") || path.startsWith(".github/ISSUE_TEMPLATE/");
const isDependency = path => path === "package.json" || path.endsWith("/package.json") || path === "package-lock.json" || path === ".github/dependabot.yml";
// Repository tooling and tests that never reach a published package.
const isMaintenance = path => /^(test|scripts|\.github)\//.test(path) || /^integrations\/[^/]+\/test\//.test(path) || /^(\.editorconfig|\.gitignore|\.env\.example|tsconfig[^/]*\.json)$/.test(path);

/** Pick the release-note label for a PR from its title, author, and changed files. */
export function classifyPullRequest({ title, author, changedFiles, files }) {
  title = title.trim();
  if (author === "github-actions[bot]" || RELEASE_TITLE.test(title)) return "skip-changelog";
  if (BREAKING_TITLE.test(title)) return "breaking-change";
  // The files API stops at 3,000 files; classify an incomplete list by title only.
  const complete = files.length > 0 && files.length === changedFiles;
  if (DOCS_TITLE.test(title) || complete && files.every(isDocumentation)) return "documentation";
  if (author === "dependabot[bot]" || DEPENDENCY_TITLE.test(title) || complete && files.every(isDependency)) return "dependencies";
  if (MAINTENANCE_TITLE.test(title)) return "maintenance";
  if (FIX_TITLE.test(title)) return "bug";
  if (complete && files.every(path => isMaintenance(path) || isDocumentation(path))) return "maintenance";
  return "enhancement";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = JSON.parse(readFileSync(0, "utf8"));
  if (typeof input.title !== "string" || typeof input.author !== "string" || !Number.isSafeInteger(input.changedFiles) || !Array.isArray(input.files) || !input.files.every(file => typeof file === "string")) {
    throw new Error("Expected { title, author, changedFiles, files } on stdin");
  }
  process.stdout.write(`${classifyPullRequest(input)}\n`);
}
