---
name: commit-only-your-hunks
description: Commit YOUR changes from a file several agents are editing at once, without carrying anyone else's work into your commit. Use whenever `git status` shows a shared file (web/app.js, web/style.css, web/lang/*.js, src/web.ts) modified and you were not the only one in it, or when a peer says "csak a sajat hunkjaidat commitold" / "git apply --cached". Also use before ANY commit in this repo's live checkout, because several agents share it by design.
scope: global
---
# Commit only your own hunks

## When to use
- `git status` shows a shared file modified and you touched only part of it.
- A peer agent hands you a GO with "only your hunks" / "don't take the wizard agent's work".
- You finished a task in the LIVE checkout (not a worktree) and want to land it.
- Any time `git add <file>` would sweep up changes you did not write.

`git add -p` is NOT available here (interactive flags are blocked). This is the
non-interactive equivalent.

## Eljaras

1. **Map the hunks before touching anything.**
   ```bash
   git diff -U3 -- <file> | grep -n "^@@"
   ```
   Each `@@` line carries the enclosing function name -- that is usually enough
   to tell yours from a colleague's. If it is not, print the hunk body.

2. **Identify yours by the function/feature, not by line number.** Line numbers
   shift after every commit; the function name in the hunk header does not.

3. **Build a patch of only the chosen hunks** (0-based indices), then stage it:
   ```bash
   python3 /path/to/pick.py "[('web/app.js',[0]),('web/lang/hu.js',[1])]" /tmp/a.patch
   git apply --cached /tmp/a.patch
   ```
   The helper: read `git diff -U3 -- <file>`, keep the lines before the first
   `@@` as the file header, split the rest on `@@` boundaries, emit header +
   selected hunks. ~20 lines of Python; see references/pick.py.

4. **VERIFY BEFORE COMMITTING. Never skip this.**
   ```bash
   git diff --cached --stat
   git diff --cached | grep -E "^\+" | grep -v "^+++" | head
   ```
   If a single line you did not write appears, `git reset` and start over.

5. **Commit, then RE-DERIVE the hunk list for the next commit.** After a commit
   the indices shift. Run step 1 again -- do not reuse the old numbers.

6. **Say what you left behind.** In the report, list whose work stayed in the
   working tree, so nobody thinks it was lost.

## Buktatok
- **Indices shift after every commit.** The single most likely way to stage a
  colleague's hunk is reusing a stale index list. Re-run `grep -n "^@@"`.
- **One feature often spans several files.** A UI change is typically
  `app.js` + `lang/hu.js` + `lang/en.js` + `style.css`. Take one hunk from each,
  not the whole file -- the language files usually also carry someone else's
  new keys.
- **Two of YOUR OWN tasks can share a file.** Being the author is not enough;
  split by task, one commit each, or the history stops explaining itself.
- **A net-zero edit leaves no hunk.** If you added something and later removed
  it, that region matches HEAD again and simply will not appear -- do not go
  hunting for it.
- **Heredoc + `&&` on the same line breaks the commit message.** Write the
  message to a file and use `git commit -F <file>`.
- **Claim the file first** (`POST /api/file-claims`) and release it after. Do not
  expect it to protect you: since 2026-08-25 (rule #13) the PreToolUse gate no
  longer denies an edit another agent holds -- it records the collision
  (`store/agent-audit.jsonl`, `op=claim-collision`) and lets the write through, so
  the overwrite is traceable rather than prevented. The claim tells a colleague
  you are here; a git worktree is what actually keeps you apart. Committing does
  not release the claim -- do it explicitly.

## Ellenorzes
- `git diff --cached --stat` lists ONLY the files your task touched.
- `git show --stat <hash>` matches what you promised in the report.
- `git status --short` afterwards still shows the others' work, untouched.
- If the file is executable (a hook, a script), run its own self-test BEFORE
  committing -- the staged state is what everyone else will run.
