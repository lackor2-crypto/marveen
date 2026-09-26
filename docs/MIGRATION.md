# Migration runbook — moving Marveen to a new machine

> **Magyar összefoglaló.** Új gépre költözés a felületről, terminál nélkül:
> (1) a régi gépen **Beállítások → Mentés → Mentés most**, és a
> **vészhelyzeti lapot** (a mentés kulcsát) tedd el; (2) a mentésfájlt
> (`.mbk`) vidd át (Raktár, felhő, pendrive); (3) az új gépen telepítsd a
> Marveent, és az első kérdésre („Van már mentésed?”) válaszd az
> **Igen, betöltöm** gombot: fájl + kulcs → előnézet → indítás; (4) állítsd le
> a régi gépet, és csak utána nyomd meg az új gépen az **„Igen, a régi gépen
> leállítottam”** gombot — addig a csatornák szünetelnek, hogy a két gép ne
> kapkodja el egymás elől az üzeneteket; (5) jelentkezz be újra a Claude-ba
> minden fióknál (Fiókok lap).

Goal: move the whole Marveen install to another machine (or a fresh install on
the same one) with **zero data loss**, from the dashboard, without a terminal.
The engine is the one-click full backup (kanban #396, `docs/BACKUP-RESTORE-PLAN.md`).

The single most important rule: **ONE BOT = ONE POLLER.** A Telegram/Slack bot
token may only be long-polled by one running install. If the old and the new
machine poll the same token at once, the second one gets HTTP 409 Conflict and
inbound messages are split or lost. This is why a restored install keeps its
channels **paused** until you confirm the old machine is off (step 4).

---

## 1. What the backup carries

One encrypted file, `marveen-backup-<date>-<host>.mbk` (AES-256-GCM; the
recovery key on the emergency kit opens it, nothing else does).

**In it** (the exact list is `src/backup/inventory.ts`):
- the database (a consistent snapshot, never the live `-wal`/`-shm`):
  kanban, comments, ideas, memories, daily log, approvals, projects, sessions,
  scheduled tasks, dashboard logins;
- secrets: `.env`, the vault and its key, Google / GitHub / git / MEGA / rclone
  credentials, channel tokens and pairing (`.claude/channels/*`);
- settings: autonomy, e-mail rules, overrides, life-tree / depot / storage
  configuration, Drive and git sync configuration;
- knowledge, drafts, meeting notes;
- every agent (`agents/<name>/`: identity, `.mcp.json`, config, memory,
  skills);
- the file-based memories of every Claude config dir (the main agent's and each
  account-isolated agent's);
- the skill library and file-based scheduled tasks under `~/.claude/`;
- local git commits that the remote does not have (a bundle).

**Not in it, on purpose:**
- **Claude CLI logins.** They are device-bound rotating tokens; restoring them
  would log the old machine out. After a restore, log in each account again
  (Accounts page).
- Logs, caches, runtime state, old `backups/`.
- The source code — it is on the git remote; the backup records the version.
- The depot's user files (`F:\Marveen\...`-style storage) — the depot's own
  Drive/MEGA backup carries those; the backup carries its *configuration*.
- Anything outside Marveen that you run on the machine (see §6).

---

## 2. On the OLD machine

1. **Settings → Backup → Back up now.** Wait for the result message (it comes
   when the job has *finished*). The list shows the new backup; a ✓ appears
   once the background verify (a trial restore) has passed.
2. **Emergency kit.** Settings → Backup → Emergency kit → *Download (.txt)* (or *Show it*)
   and keep the key somewhere safe (password manager, printed). **Without it
   the backup cannot be opened on the new machine** — nobody can recover it.
3. **Get the file to the new machine.** Either:
   - it is already in the depot (`Rendszer/Marveen/Mentések`) or in the cloud
     folder, if those destinations are on (Settings → Backup → *Where the backup goes*);
   - or *Download* it from the backups list.
   The file is encrypted, so any channel is fine for the file itself. The key
   travels separately.
4. **Keep the old machine running for now.** Stop it only in step 4 below.

---

## 3. On the NEW machine

1. Install Marveen the normal way (the installer for the platform). Do not copy
   `dist/`, `node_modules/` or Python venvs from the old machine — they are
   rebuilt natively.
2. Open the dashboard. A fresh install asks first:
   **"Do you have a backup from an earlier Marveen?"** → **Yes, restore it**.
   (If you already answered *No*: Settings → Backup → *Restore from a backup*.)
3. **Choose the file** (upload the `.mbk`) and **type the recovery key** from the
   emergency kit. A wrong key says so and names the key id; nothing changes.
4. **Preview — "What will happen".** Counts before → after (cards, memories,
   projects, approvals), per category what is new, overwritten or held back,
   settings that still point to the old machine, and which accounts will need a
   Claude login. Optional file groups (skills, schedules, agents, depot
   settings, …) can be left out; the database is all-or-nothing (cards,
   comments, approvals and projects refer to each other).
5. **Start the restore.** If this install has a dashboard login, type its
   password (an agent holds the access token, never the password). Marveen
   first saves the current state (skipped only on a fresh install, where there
   is nothing to protect), then restarts itself (1–2 minutes) and puts the
   backup in place. If anything fails, it rolls back automatically and says
   why. The page shows the result after the restart, also after a reload.
6. The dashboard login of the old machine comes back with the database. A
   browser opened with the access token stays signed in; a browser that signed
   in with a password signs in again with the old user name and password.

---

## 4. Cutover (the irreversible step — do last)

1. On the **old** machine: stop Marveen (its service, and anything else that
   polls a bot token). Make sure nothing is left polling.
2. On the **new** machine: Settings → Backup → **"Yes, it is stopped on the old machine"**. Only now do the channel tokens and the scheduled tasks come
   back. (Until then the Overview shows an orange line about it.)
3. Send a test message on each channel — it must reach the new machine and get a
   reply.
4. **Accounts page:** log in each Claude account the restore result listed.
5. If the depot drive has another letter/path on this machine, set it again on
   the Depot page.

---

## 5. Verification checklist

- [ ] Overview: the backup line is green (after the first backup on the new
      machine), no orange "channels paused" line.
- [ ] Kanban, memories, projects, ideas visible, with the counts the preview
      promised.
- [ ] Agents listed and able to work (Claude login done per account).
- [ ] Skills and scheduled tasks present (Settings / Schedules pages).
- [ ] Telegram (and every other channel) inbound + outbound works.
- [ ] Settings → Backup → *Back up now* on the new machine succeeds, and the
      destinations (depot, cloud) are reachable.

---

## 6. What still needs a hand (outside Marveen)

- **Other services on the machine.** Docker stacks, databases or anything else
  you run next to Marveen are not in the backup. For example a Docker volume is
  exported with
  `docker run --rm -v <volume>:/from -v "$PWD":/to alpine tar -czf /to/<volume>.tar.gz -C /from .`
  and imported the same way into a new volume. Quiesce the writers first.
- **Service units.** The installer creates the systemd user units (Linux/WSL) or
  launchd plists (macOS) on the new machine. The backup keeps the old ones for
  reference only; it never installs them.
- **macOS privacy (TCC).** New processes are silently blocked from protected
  paths until you grant Full Disk Access / Automation in System Settings →
  Privacy & Security to the terminal / `node` / `tmux` that run Marveen.
- **Tailscale / external URL.** A new machine gets a new tailnet name; update any
  URL that pinned the old hostname. The new install keeps its own access token
  (the old one does not come back), so a bookmark or phone that used the old
  `?token=` link needs the new one.
- **`claude` auto-update.** Keep `DISABLE_AUTOUPDATER=1` where the installer set
  it; a mid-swap update can leave `claude` missing from PATH.

---

## Appendix A — the terminal path (when the dashboard cannot be reached)

The same engine as Settings → Backup, from a shell in the project root. Build
first (`npm run build`).

```bash
node dist/backup/cli.js create --kind manual          # a backup now
node dist/backup/cli.js list                          # local backups
node dist/backup/cli.js verify <file.mbk> [--key K]   # full verify incl. a trial restore
node dist/backup/cli.js verify-offsite                # download the newest cloud copy and verify it

# restore: preview only (nothing changes) ...
node dist/backup/cli.js restore <file.mbk> --unit <dashboard.service> [--key K] [--exclude skills,schedules]
# ... then for real (pre-restore backup, stop, restore or roll back, start)
node dist/backup/cli.js restore <file.mbk> --unit <dashboard.service> [--key K] --yes
```

- `--unit` is the dashboard's systemd user service
  (`systemctl --user list-units --type=service` lists them).
- The key: without `--key` the key stored on this machine is used when its key
  id matches the file; on a new machine pass the emergency-kit key.
- After a terminal restore the channels are paused exactly as in the UI;
  confirm on Settings → Backup once the old machine is off.

## Appendix B — the legacy archive (`backups/claudeclaw-*.tar.gz`)

Installs from before #396 made a plain tar.gz with `repo/` and `home/` groups
(`scripts/backup-legacy.sh` still makes one when `dist/backup/cli.js` is
missing). Restoring one is manual:

```bash
mkdir -p /tmp/restore && tar -xpzf claudeclaw-YYYYmmdd-HHMMSS.tar.gz -C /tmp/restore
# read /tmp/restore/MANIFEST.txt, stop the dashboard, then drop THIS install's
# -wal/-shm first (a stale -wal would replay old pages over the restored DB):
rm -f <project root>/store/claudeclaw.db-wal <project root>/store/claudeclaw.db-shm
rsync -a /tmp/restore/repo/  <project root>/   # repo group -> project root (with the archive's own -wal/-shm)
rsync -a /tmp/restore/home/  "$HOME/"          # home group -> $HOME
```

Local-only git commits in it: `git fetch <restored>/repo/local-commits.bundle 'refs/heads/*:refs/heads/*'`.
The same one-bot-one-poller rule applies: stop the old machine before the new
one starts its channels.
