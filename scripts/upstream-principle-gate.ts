#!/usr/bin/env tsx
// CLI for the upstream principle gate. Reviews incoming upstream changes against
// the baked principle checklist + the committed denylist, BEFORE a merge/install.
//
// Usage:
//   tsx scripts/upstream-principle-gate.ts [--upstream <ref>] [--base <ref>] [--json] [--changes <file.json>]
//
// Exit codes:
//   0  reviewed, nothing excluded (may include items to discuss)
//   1  reviewed, at least one item EXCLUDED (a merge step should stop)
//   2  could NOT review (missing/unreadable source) -- this is NOT "0 exclusions"
//
// The exit-2 case is deliberate: a zero count must never be confused with "did
// not look". If the upstream ref cannot be resolved, we fail loud, not silent.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ChangeInput,
  type Denylist,
  runGate,
  parseDenylist,
} from "../src/upstream-principle-gate.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const DENYLIST_PATH = resolve(REPO_ROOT, "governance/upstream-exclusions.json");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const wantJson = process.argv.includes("--json");

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 1 << 28 });
}

function loadDenylist(): Denylist {
  let raw: string;
  try {
    raw = readFileSync(DENYLIST_PATH, "utf8");
  } catch (e) {
    // Missing committed denylist is a real error (the file should ship with the repo),
    // NOT an empty-means-clear situation.
    fail(2, `denylist not readable at governance/upstream-exclusions.json: ${(e as Error).message}`);
  }
  try {
    return parseDenylist(JSON.parse(raw!));
  } catch (e) {
    fail(2, `denylist invalid: ${(e as Error).message}`);
  }
}

function resolveRef(ref: string): string {
  try {
    return git(["rev-parse", "--verify", "--quiet", ref]).trim();
  } catch {
    fail(2, `cannot resolve ref '${ref}' -- fetch upstream first. A missing ref is NOT "nothing to review".`);
  }
}

function gatherFromGit(base: string, upstream: string): ChangeInput[] {
  const files = git(["diff", "--name-only", base, upstream]).split("\n").map((s) => s.trim()).filter(Boolean);
  if (files.length === 0) return [];
  // subjects per file, one pass over the behind commits
  const SEP = "@@@C@@@";
  const raw = git(["log", `${base}..${upstream}`, "--no-merges", "--name-only", `--format=${SEP}%x09%s`]);
  const subjectsByFile = new Map<string, string[]>();
  for (const block of raw.split(SEP).map((b) => b.trim()).filter(Boolean)) {
    const lines = block.split("\n");
    const subject = lines[0].split("\t")[1] ?? "";
    for (const f of lines.slice(1).map((s) => s.trim()).filter(Boolean)) {
      if (!subjectsByFile.has(f)) subjectsByFile.set(f, []);
      subjectsByFile.get(f)!.push(subject);
    }
  }
  return files.map((path) => {
    let addedLines: string[] = [];
    try {
      const patch = git(["diff", "--unified=0", base, upstream, "--", path]);
      addedLines = patch
        .split("\n")
        .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
        .map((l) => l.slice(1));
    } catch {
      /* binary or unreadable diff -> no added lines; path/subject signals still apply */
    }
    return { path, subjects: (subjectsByFile.get(path) ?? []).join(" || "), addedLines };
  });
}

function fail(code: number, msg: string): never {
  if (wantJson) console.log(JSON.stringify({ ok: false, error: msg }));
  else console.error(`upstream-principle-gate: ${msg}`);
  process.exit(code);
}

function main(): void {
  const denylist = loadDenylist();

  let changes: ChangeInput[];
  const changesFile = arg("--changes");
  if (changesFile) {
    const parsed = JSON.parse(readFileSync(resolve(process.cwd(), changesFile), "utf8"));
    if (!Array.isArray(parsed)) fail(2, "--changes file must be a JSON array of {path,subjects?,addedLines?}");
    changes = parsed as ChangeInput[];
  } else {
    const upstreamName = arg("--upstream") ?? "upstream/main";
    const upstream = resolveRef(upstreamName);
    const base = arg("--base")
      ? resolveRef(arg("--base")!)
      : git(["merge-base", "HEAD", upstream]).trim();
    changes = gatherFromGit(base, upstream);
  }

  const report = runGate(changes, denylist);

  if (wantJson) {
    console.log(JSON.stringify({ ok: true, ...report }, null, 2));
  } else {
    console.log(`Upstream principle gate -- reviewed ${report.reviewed} change(s)`);
    console.log(`  EXCLUDE (auto): ${report.exclude.length}`);
    console.log(`  DISCUSS (owner decides): ${report.discuss.length}`);
    console.log(`  ALLOW: ${report.allow.length}`);
    if (report.exclude.length) {
      console.log("\nExcluded (violates a red principle / on the denylist):");
      for (const v of report.exclude) console.log(`  [${v.principleId ?? "?"}] ${v.path} -- ${v.reason ?? ""}`);
    }
    if (report.discuss.length) {
      console.log("\nTo discuss:");
      for (const v of report.discuss) console.log(`  [${v.principleId ?? "?"}] ${v.path}`);
    }
  }

  // Exit 1 if anything is excluded, so a merge step can gate on it.
  process.exit(report.exclude.length > 0 ? 1 : 0);
}

main();
