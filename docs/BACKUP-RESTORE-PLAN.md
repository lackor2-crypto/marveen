# One-click full backup and restore — implementation plan (#396)

> **Magyar összefoglaló (a tulajdonosnak).** Egy gombnyomásra a Marveen minden
> adatáról (kanban, ötletek, memória, napló, tudás, projektek, ütemezések,
> skillek, ágensek, beállítások, jóváhagyások, fiókok, titkok) egyetlen,
> jelszóval titkosított mentésfájl készül. A mentés három helyre kerül: a gépre,
> az F: meghajtó Raktárába és egy felhőfiókba (Drive vagy MEGA). Egy gombnyomásra
> vissza is tölthető, és egy friss telepítés első kérdése ez lesz: „Van már
> mentésed? Töltsd be.” Visszaállítás előtt előnézetet látsz arról, mi változik,
> és a Marveen előbb automatikusan elmenti a mostani állapotot. Ha a
> visszaállítás nem sikerül, magától visszaáll. A titkosítás kulcsát egy
> „vészhelyzeti lapon” kapod meg, és ezt kell megőrizned, mert nélküle egy új
> gépen a mentés nem nyitható ki (ugyanígy működik a Home Assistant is). Hat
> fázisban épül fel. Mindegyik fázis önállóan hasznos és önállóan tesztelhető.

Status: **PLAN, not approved.** Implementation starts only after the owner
approves it (Boss TG 6430). The plan was written by lackor3; the implementer
is a separate session with no prior context. **Everything you need is in this
file.** Where the plan refers to existing code, it names the file and symbol,
and every line reference was measured on `main` at `a4b9dd33` (2026-09-25).

---

## 0. Read this first (rules the implementer must follow)

- **Work location.** Work in an isolated worktree (`scripts/agent-worktree.sh <name>`).
  Land with `scripts/land-pr.sh "<title>"`. Never edit the live checkout.
- **One project, one card.** All phases belong to kanban card **#396**. Put
  progress on it as comments; do not open new cards for phases.
- **Bilingual.** Every on-screen string needs `hu` and `en` (`web/lang/hu.js`
  and `web/lang/en.js`, `data-i18n` in HTML, `t()` in `web/app.js`, and
  `{hu,en}` tables on the server). Gates:
  `npx vitest run src/__tests__/i18n-no-hardcoded-hu.test.ts src/__tests__/lang-parity.test.ts`.
- **Host-agnostic.** No hard-coded `/home/...`, agent id, owner name, port,
  or account. Use `PROJECT_ROOT`, `STORE_DIR` (`src/config.ts`),
  `MAIN_AGENT_ID`, `listAgentNames()` (`src/web/agent-config.ts:610`),
  `mainAgentEffectiveConfigDir()` (`:358`), `readAgentClaudeConfigDir()`
  (`:297`), `os.homedir()` and `DEPOT_BACKUPS` (`src/depot.ts:94`). Gate:
  `npx vitest run src/__tests__/template-identity-hygiene.test.ts`.
- **Non-programmer user.** Every field and button says what it is, why it is
  needed, where the value comes from, and what happens without it. Error texts
  are human sentences: the UI shows `message`, never `error`.
- **Fresh install.** Every step must work from the UI on an empty `store/`.
  "Zero" must never be ambiguous; see §9.
- **No new npm dependency** unless a phase explicitly names one. Everything
  below uses Node 22 built-ins (`crypto`, `zlib`, `stream`) plus
  `better-sqlite3` (already a dependency) and the system `tar` (already used by
  `scripts/backup.sh` and `src/web/agent-bundle.ts`).

---

## 1. Goal and measured starting point

**Goal (Boss TG 6424 / 6430).**
- **Backup:** one click makes a COMPLETE backup of everything Marveen knows.
- **Restore:** one click restores it, above all onto a **new machine or fresh
  install**.
- **Research:** the design must follow how professional self-hosted apps solve
  this; see §2.

**What exists today** (measured 2026-09-25):

| Piece | Where | State |
|---|---|---|
| Archive script | `scripts/backup.sh` (344 lines) | tar.gz with `repo/` + `home/` groups, `umask 077`, keeps 14. Runs every 6 h via `scripts/install-guard-units.sh:40` (`backup\|bash scripts/backup.sh\|every:21600`). Latest archive is 25.9 MB. `backups/` holds 310 MB. |
| Output location | `<PROJECT_ROOT>/backups/` | **Same disk as the data.** Lose the machine, lose the backup. |
| Health check | `src/web/system-health.ts:116-200` (`backupsDir()`, `newestArchive()`) | Only looks at the age of the newest archive. |
| Restore | `docs/MIGRATION.md` | Manual, terminal only. |
| UI | — | None. |
| Verification | — | None. Nobody knows whether an archive restores. |
| Depot target folder | `DEPOT_BACKUPS` = `Rendszer/Marveen/Mentések` (`src/depot.ts:94`) | Exists, empty. |
| Agent export | `src/web/agent-bundle.ts` | Per-agent / fleet bundle. Excludes the main agent and the DB. |

**Gaps found by measurement.** The current archive misses all of these. Each
one would be lost on a new machine:

1. **Per-account Claude config dirs.** Examples: `~/.claude-marvin/`,
   `store/accounts/<id>/`. Their `projects/*/memory/` folders hold the
   file-based memories of the main agent and of every account-isolated agent.
   `backup.sh` only takes `~/.claude/projects/*/memory`, but since #290 the main
   agent's memory lives in `~/.claude-marvin/projects/-<slug>/memory`. Verified
   on this host: that directory exists and is not in the archive.
2. **Life-tree and storage configuration.**
   - Files: `store/life-tree.json`, `life-tree-created.json`, `life-mounts.json`,
     `life-labels.json`, `life-archived.json`, `life-physical.json`, `storages.json`.
   - Without these, a restored Marveen does not know the depot layout.
3. **Cloud/sync configuration and secrets.**
   - Files: `store/drive-sync.json`, `git-sync.json`, `mega-accounts.json`,
     `rclone/rclone.conf`, `.git-tokens.json`.
   - `.github-tokens.json` is already included.
4. **Small but hand-made files.**
   - Files and folders: `store/knowledge/`, `store/drafts/`, `store/folder-icons/`,
     `store/photos/` (296 KB index), `marveen-avatar.png`, `egress-allowlist.json`,
     `openrouter-manual.json`, `main-account.json`.
5. **The DB is raw-copied while the dashboard is writing.** `backup.sh` runs
   `PRAGMA wal_checkpoint(TRUNCATE)` and then tars `claudeclaw.db` together with
   `-wal`/`-shm`. A write between the checkpoint and the tar yields a torn copy.
   See §2.2.

---

## 2. Research: how professional self-hosted apps do it

| App | What we take from it |
|---|---|
| **Home Assistant** (2025.1+) | App-generated **encryption key**, shown in a printable **"backup emergency kit"**. Onboarding offers **"Restore from backup"**: upload the file, enter the key, choose parts. Without the key the backup cannot be restored, and nobody (Nabu Casa included) can recover it. Since 2025.2, downloading via the UI can decrypt on the fly. |
| **Immich** | Automatic DB dumps in `UPLOAD_LOCATION/backups`, listed in the UI with a **Restore** button. **A restore point is created automatically before restore**, so a failed restore can roll back. A fresh install's onboarding offers restore. DB dumps do not contain the media: files and metadata are separate concerns. |
| **Vaultwarden** | Never raw-copy a live `db.sqlite3` (the `-wal`/`-shm` sidecars corrupt it). Use `.backup` or `VACUUM INTO`, and **delete a stale `-wal` before putting a restored DB in place**. Back up keys and attachments alongside the DB. |
| **Gitea / Forgejo** (`dump`, `doctor`, `migrate`) | Restore with the same binary version that made the dump, or newer. Newer versions may add manifest fields that older restorers do not know. After restore, run the migrator and a doctor/integrity check. |
| **restic / Borg / Kopia** | Passphrase → key via a memory-hard KDF (scrypt / Argon2id). Authenticated encryption per chunk. Restic: "password, period" (no separate key file to lose). Borg "repokey": key stored in the repo, passphrase-unlocked. |
| **Proxmox Backup Server** | Scheduled **verify jobs** re-hash every chunk (SHA-256) against the manifest. **Restore tests** into an isolated target. The **3-2-1(-1-0)** rule: 3 copies, 2 media, 1 off-site, (1 offline), **0 errors on verified restore**. |

### 2.1 Decisions that follow

| Decision | Chosen | Rejected, and why |
|---|---|---|
| Archive granularity | **Full snapshot each run.** The payload is ~26 MB compressed today. | Incremental/dedup (restic/Borg). Needs an extra binary on every fresh install and a repository concept the user must understand. Revisit if the payload exceeds ~500 MB. |
| DB snapshot | **SQLite Online Backup API** via `better-sqlite3` `db.backup(dest)` from inside the dashboard process, then `PRAGMA integrity_check` on the copy. | Raw copy + checkpoint (current, torn-copy risk). `VACUUM INTO` is also safe, but it blocks writers longer on a 64 MB DB and changes page layout. It is kept as the fallback when `backup()` throws. |
| Encryption | **Built-in Node crypto.** A random 256-bit data key encrypts the archive in 64 KiB chunks with AES-256-GCM (STREAM-style: the nonce carries a counter and the last-chunk flag). The data key is wrapped by a **recovery key** through scrypt. | `age` binary: present on this host (`~/.local/bin/age`) but not on a fresh install. `restic`: same. A zip password: weak, and not authenticated. |
| Who holds the key | **Home-Assistant model.** Marveen generates a strong recovery key and stores it locally (`store/.backup-key`, 0600) so scheduled backups need no human. It is shown **once** in an emergency kit that the user must confirm they saved. | A user-chosen password: users pick weak ones and forget them. It can be offered as an option: "set my own password instead". |
| Destinations | **3-2-1.** (1) local `store/backups/`, (2) depot `DEPOT_BACKUPS` (F:, a different physical disk from the WSL vhdx on this host), (3) one off-site cloud target (Google Drive folder or MEGA via the existing rclone). | Relying on the existing depot Drive backup to carry it off-site. **It will not:** `mentesKihagyUt('')` in `src/web/routes/drive-sync.ts` deliberately excludes `DEPOT_SYSTEM_ROOT` (`Rendszer`) from whole-depot backups, and `Mentések` lives under `Rendszer`. The off-site copy must be an explicit step. |
| Restore scope | **Whole-snapshot restore**, plus **category opt-out for file groups** (skills, scheduled tasks, agents, depot config). The DB is restored all-or-nothing. | Per-table DB merge: ids, foreign keys and cross-table references (card ↔ comments ↔ approvals ↔ projects) make partial DB restore a data-corruption generator. Out of scope. |
| Execution of restore | A **detached restore runner** process. The dashboard holds the DB open and must stop. Same pattern as `store/update-finalize.sh` and `performSelfRestart()` (`src/self-restart.ts:159`). | Restoring in-process: cannot replace an open DB safely. |

---

## 3. What goes into a backup (exact list)

Paths are stored under **logical roots**, never absolute paths. The restore
side maps each root to the new machine's values (§6.4).

| Logical root | Resolves to | Resolver |
|---|---|---|
| `project/` | `PROJECT_ROOT` | `src/config.ts` |
| `home/` | `os.homedir()` | — |
| `config/<owner>/` | a Claude config dir; `<owner>` = `main` or an agent name | `mainAgentEffectiveConfigDir()`, `readAgentClaudeConfigDir(name)`; default `~/.claude` |

### 3.1 Included

**Database.**
- `project/store/claudeclaw.db`: a snapshot made with the Online Backup API
  (§2.1). **Never** the live `-wal`/`-shm` files.
- It holds kanban, comments, ideas, memories, daily log, approvals, projects,
  sessions and the rest of the 43 tables.

**Secrets.** All mode 0600, all encrypted inside the archive.
- `project/.env`
- `project/store/.dashboard-token`, `.vault-key`, `vault.json`,
  `vault-bindings.json`
- `project/store/google-tokens.json`, `google-oauth-client.json`
- `project/store/.github-tokens.json`, `.git-tokens.json`
- `project/store/mega-accounts.json`, `rclone/rclone.conf`
- Channel state from `project/.claude/channels/*/`: `.env`, `access.json`,
  `invites.json`, `approved/`
- The same set from `home/.claude/channels/*/` (unmigrated installs)
- The same set from `project/agents/*/.claude/channels/*/`

**Settings (hand-made).**
- `project/store/autonomy-config.json`, `email-rules.json`, `agents-desired.json`,
  `config-overrides.json`, `main-account.json`
- `project/store/egress-allowlist.json`, `openrouter-manual.json`,
  `costops-config.json` (if present)
- `project/store/life-*.json`, `storages.json`, `drive-sync.json`, `git-sync.json`
- `project/store/folder-icons/`, `marveen-avatar.png`

**Knowledge and content.**
- `project/store/knowledge/`, `drafts/`, `photos/` (index only)
- `project/assets/meetings/`
- `project/scheduled-tasks.json` (legacy)

**Agents.** For every name in `listAgentNames()`:
- `project/agents/<n>/`: `CLAUDE.md`, `SOUL.md`, `.mcp.json`,
  `agent-config.json`, `memory/`, `.claude/skills/`
- the agent's own `.claude/settings.json`, whose hooks are **not restored**
  (§6.5)

**Claude config dirs.** For `main` and for every agent that has an isolated
config dir:
- `config/<owner>/projects/*/memory/`: the file-based memories
- `config/<owner>/skills/`, if it is a real directory. If it is a symlink,
  record the link target in the manifest only.
- `config/<owner>/settings.json`: kept for reference, not auto-restored
  (§6.5)

**Home.**
- `home/.claude/skills/`, `home/.claude/scheduled-tasks/`

**Git.**
- `project/local-commits.bundle`: local branches absent from origin, exactly as
  `backup.sh` does today

**Reference only** (in the archive, never auto-restored):
- systemd user units `~/.config/systemd/user/<MAIN_AGENT_ID>-*` and the launchd
  plists.
- Restoring them is `service_systemd_change` (approval level 2). The fresh
  install's own installer creates them, so the restore **reports** the
  differences instead.

### 3.2 Excluded, and why

| Excluded | Why |
|---|---|
| Source code | It lives on the git remote; the manifest records the commit and version. Only local-only commits go in, as the bundle. |
| Claude CLI login credentials (`.credentials.json`, `store/claude-login/`, `.cred-backup-*`) | Device-bound, rotating refresh tokens. Using the same refresh token on two machines invalidates one of them (token rotation). After restore, each agent logs in again; the wizard lists which ones (§7.3). |
| Logs and journals (`*.log`, `agent-audit.jsonl` 17 MB, `compaction-quality.jsonl`, `drive-sync-failures.jsonl`, `external-deletions.jsonl*`) | Diagnostics, not data. They would multiply the size. An opt-in checkbox "include diagnostic logs" can add them. |
| Runtime state (`*.pid`, `locks/`, `.cred-switch-*`, `.channel-*`, `*-state.json`, `schedule-tick-state.json*`, `rate-limit-status/`, `session-env/`, `shell-snapshots/`) | Describes the old machine's running processes. Restoring it makes the new machine believe it is mid-operation. |
| Caches (`store/cache/` 71 MB, `browser/`, `paste-cache/`, `file-history/`) | Regenerable. |
| Old ad-hoc copies (`.env.bak-*`, `*.bak-*`, `backups/`, `windows-settings-backups/`) | Stale duplicates; the backup must not back up backups. |
| **The depot's user files** (`F:\Marveen\...`) | Different concern, different size class (GBs). They are covered by the Drive/MEGA depot backup (#47, #350). The **configuration** of that backup is included, so it resumes after restore. |
| Transcripts (`config/*/projects/*/*.jsonl`) | Large, and not needed to continue working. Memory, not transcript, is the durable knowledge. |

**The rule for new files.** The inventory is an **allowlist** with named
categories (`src/backup/inventory.ts`, §5), never "everything minus a
denylist". Why: a new secret file must be decided on consciously.

A test, `backup-inventory-coverage.test.ts`, lists every top-level entry of a
fixture `store/` and **fails when an entry is in neither the include list nor
the exclude list**. This forces the next developer who adds a `store/foo.json`
to classify it. This is the mechanism that would have caught gaps 1-4 above.

---

## 4. File format

The file is named `marveen-backup-<YYYYmmdd-HHMMSS>-<shortHost>.mbk`. The name
uses local time, and the host part is sanitised to `[a-z0-9-]`.

```
offset  field
0       magic "MRVNBK01" (8 bytes)
8       header length L (uint32 BE)
12      header JSON (L bytes, UTF-8) -- NOT secret, see below
12+L    encrypted payload: sequence of chunks
        each chunk = ciphertext(<=64 KiB) || GCM tag (16 bytes)
```

**Header JSON.** This is plaintext, so the file list works without the key:

```json
{
  "format": 1,
  "createdAt": "2026-09-25T20:15:00+02:00",
  "appVersion": "1.29.0",
  "appCommit": "a4b9dd33",
  "kind": "scheduled|manual|pre-restore",
  "kdf": { "alg": "scrypt", "N": 131072, "r": 8, "p": 1, "salt": "<b64 16B>" },
  "wrappedKey": { "alg": "A256GCM", "nonce": "<b64 12B>", "ct": "<b64 32B+16B tag>" },
  "keyId": "<first 8 hex of sha256(recovery key)>",
  "noncePrefix": "<b64 7B>",
  "chunkSize": 65536
}
```

- The header holds **no** counts, names, hostnames beyond the short host, or
  paths. Anything describing content is inside the encrypted payload.
- **Chunk nonce.** It is 12 bytes: `noncePrefix` (7 B) ‖ counter (uint32 BE,
  4 B) ‖ last-flag (1 B: `0x01` on the final chunk, else `0x00`).
- The AAD of every chunk is the SHA-256 of the header bytes. This binds the
  header, so editing `kind` or `createdAt` breaks decryption.
- A missing final chunk, reordered chunks or a truncated file all fail
  authentication. This is the property the STREAM construction gives.
- **Key hierarchy.**
  - `dataKey` = 32 random bytes per backup.
  - `kek` = `scrypt(recoveryKey, salt, 32, {N,r,p})`.
  - `wrappedKey` = AES-256-GCM(`kek`, `dataKey`).
  - Changing the recovery key re-wraps only future backups; old files keep
    their own header. The key registry (§6.1) keeps old key ids until no backup
    uses them.

**Plaintext payload.** It is a gzip-compressed tar (`tar -czf`, with the same
staging-dir approach as `backup.sh`, for bsdtar/GNU tar portability). Layout:

```
manifest.json
project/...   home/...   config/<owner>/...
```

**`manifest.json`:**

```json
{
  "format": 1,
  "createdAt": "...", "appVersion": "1.29.0", "appCommit": "a4b9dd33",
  "db": { "schemaFingerprint": "<sha256 of sorted 'table:col,col' list>",
          "userVersion": 0, "integrityCheck": "ok",
          "counts": { "kanban_cards": 412, "memories": 1893, "...": 0 } },
  "roots": { "config/main": { "kind": "main" }, "config/usalackor": { "kind": "agent" } },
  "agents": ["lackor3", "usalackor"],
  "categories": { "database": ["project/store/claudeclaw.db"], "secrets": ["..."], "...": [] },
  "files": [ { "path": "project/store/vault.json", "size": 12787, "sha256": "<hex>", "mode": 384 } ],
  "pathHints": { "PROJECT_ROOT": "/home/x/marveen", "HOME": "/home/x", "projectSlug": "-home-x-marveen" },
  "excludedCategories": ["logs", "claude-credentials"]
}
```

`pathHints` holds the only absolute paths. It exists so the restorer can
rewrite them (§6.4); nothing resolves against it directly.

---

## 5. Phases

Each phase is one or more PRs on #396 and is independently useful. The phases
must be done in order.

### Phase 1: Backup engine (no UI)

**New files.**
- `src/backup/inventory.ts`
  - `export type BackupCategory = 'database'|'secrets'|'settings'|'knowledge'|'agents'|'memory'|'skills'|'schedules'|'depot-config'|'git'|'reference'`
  - `export interface InventoryItem { logical: string; abs: string; category: BackupCategory; kind: 'file'|'dir' }`
  - `export function collectInventory(opts?: { includeLogs?: boolean }): { items: InventoryItem[]; missing: string[]; unreadable: {path:string; error:string}[] }`.
    It enumerates §3.1, using `listAgentNames()` and the config-dir resolvers.
    **Missing optional files are not errors.** Unreadable ones are reported
    (§9).
  - `export const STORE_INCLUDE: readonly string[]`,
    `export const STORE_EXCLUDE: readonly (string|RegExp)[]`: the
    classification used by the coverage test.
- `src/backup/db-snapshot.ts`
  - `export async function snapshotDatabase(destFile: string): Promise<{ integrity: 'ok'|string; counts: Record<string,number>; schemaFingerprint: string; userVersion: number }>`.
    It uses the dashboard's open `better-sqlite3` handle (`src/db.ts`) and
    `await db.backup(destFile)`. On failure it falls back to
    `db.exec("VACUUM INTO '<dest>'")`, then opens the copy read-only and runs
    `PRAGMA integrity_check` plus `SELECT count(*)` per table.
- `src/backup/crypto.ts`
  - `export function generateRecoveryKey(): string`. It returns 30 random
    characters from Crockford base32, grouped `XXXXX-XXXXX-...` (6 groups):
    ~150 bits, typeable, no ambiguous characters.
  - `export function keyIdOf(recoveryKey: string): string`
  - `export function encryptStream(recoveryKey, headerBase): { header: Buffer; transform: Transform }`
  - `export function readHeader(fd|buffer): Header`
  - `export function decryptStream(recoveryKey, header): Transform`. It throws
    a typed `BackupDecryptError` with code `wrong_key|corrupt|truncated`.
- `src/backup/create.ts`
  - `export async function createBackup(opts: { kind: 'scheduled'|'manual'|'pre-restore'; includeLogs?: boolean }): Promise<BackupResult>`
  - Steps:
    1. Take a lock (`store/locks/backup.lock`, with a stale-lock timeout).
    2. `mkdtemp` a staging dir (0700) **under `STORE_DIR/tmp`**, not `/tmp`
       (`/tmp` may be world-listable or tmpfs-limited).
    3. Copy the inventory into logical roots.
    4. Snapshot the DB.
    5. Write the git bundle.
    6. Hash each file into the manifest.
    7. Run `tar -czf -` and pipe it through `encryptStream` into
       `store/backups/<name>.mbk.partial`.
    8. `fsync`, then rename to `.mbk`.
    9. Remove the staging dir in `finally`.
  - Every file created is 0600 (`umask 077`-equivalent via the `mode` options).
  - `BackupResult = { ok, file, size, counts, durationMs, warnings[] }`
- `src/backup/key-store.ts`: `store/.backup-key` (0600) holds
  `{ current: {key, keyId, createdAt, confirmedAt|null}, previous: [...] }`.
  - `export function getOrCreateKey()`, `rotateKey()`, `confirmKitSaved()`
- `src/backup/cli.ts`: `node dist/backup/cli.js create|verify <file>|list`, for
  terminal use and for the systemd timer.

**Changed files.**
- `scripts/backup.sh`: becomes a thin wrapper, `exec node dist/backup/cli.js create --kind scheduled`.
  - Fallback: keep the old tar path, **renamed to `scripts/backup-legacy.sh`**,
    and use it only when `dist/backup/cli.js` is missing (a broken build must
    not stop backups).
  - Update the header comment.
- `.gitignore`: `store/backups/` is already covered by `store/` (verify).

**Acceptance.**
- `createBackup()` on a fixture install produces a `.mbk`.
- Decrypting it and untarring yields every §3.1 item that exists in the
  fixture, and `manifest.files[].sha256` matches.
- Running during 50 concurrent DB writes yields a snapshot whose
  `integrity_check` is `ok`.
- A wrong key gives `wrong_key`; a flipped byte gives `corrupt`; a cut file
  gives `truncated`.

**Tests.**
- `src/__tests__/backup-crypto.test.ts`: round-trip; wrong key; bit flip in
  chunk N; truncated at a chunk boundary (final flag missing); header edit
  detected via AAD.
- `src/__tests__/backup-inventory-coverage.test.ts`: the coverage rule of §3.2.
- `src/__tests__/backup-create.test.ts`:
  - Temp `PROJECT_ROOT`/`HOME`, with `vi.mock('../config.js')` as in
    `kuka-at-root.test.ts`.
  - Two agents, one of them with an isolated config dir holding `memory/`.
    Assert that both memory dirs are in the archive (gap 1).
  - Life-tree files present (gap 2).
  - No `*.log`, no `.credentials.json`, no `store/cache`.
- `src/__tests__/backup-db-snapshot.test.ts`: a writer loop in the same
  process during `snapshotDatabase`; the copy passes `integrity_check`, and its
  counts are ≥ the pre-snapshot counts.

### Phase 2: Destinations, retention, schedule, health

**New files.**
- `src/backup/destinations.ts`
  - `type Destination = { id; kind: 'local'|'depot'|'gdrive'|'mega'; label; enabled; account?; folderId?; remotePath? }`,
    persisted in `store/backup-config.json`.
  - `local`: `store/backups/`, always on.
  - `depot`: `join(depotRoot(), DEPOT_BACKUPS)`. It is on by default **when a
    depot is configured**.
  - `gdrive`: reuses the uploader in `src/google-oauth-client.ts` (the
    multipart/resumable upload used by `drive-sync`), into a folder the user
    picks, default `Marveen mentések` / `Marveen backups`.
  - `mega`: reuses the rclone remote from `src/mega-backup.ts`.
  - `export async function replicate(file: string): Promise<ReplicaResult[]>`.
    Each result is `{dest, ok, reason?, reachable: boolean}`, and
    **"unreachable" is distinct from "failed"** (§9).
- `src/backup/retention.ts`
  - `export function planPrune(list: BackupEntry[], policy): { keep: BackupEntry[]; drop: BackupEntry[] }`.
  - GFS policy per destination:
    - local: last 3.
    - depot: 7 daily + 4 weekly + 6 monthly.
    - cloud: 7 daily + 4 weekly + 3 monthly.
  - **Hard rules:**
    - Never drop the newest **verified** backup (§Phase 6).
    - Never drop a `pre-restore` backup younger than 30 days.
    - Never drop anything when the destination listing failed ("0 files" is
      not "nothing there", §9).
- `src/backup/scheduler.ts`: an in-dashboard timer, like the Kuka sweep in
  `src/web.ts` (`kukaSepres`).
  - Daily at a configurable local time (default 03:30, `SCHEDULER_TZ`).
  - Plus the existing 6-hourly systemd unit, which calls the same CLI (either
    trigger works when the other is down).
  - Skips a run if one succeeded < 60 min ago.

**Changed files.**
- `src/web/system-health.ts`: replace `newestArchive(backupsDir())` with
  `backupHealth()`, which reads `store/backup-state.json` (last run, result,
  per-destination replica results, last verify). The states are listed in
  §9.
- `scripts/deploy-live.sh`: verify that `store/backups/` is never touched (it
  is under `store/`, but assert this in a test).

**Acceptance.**
- With the depot configured, a manual run writes the same file to `local` and
  `depot`, and to the cloud when set.
- Retention is fed a synthetic 120-day list and keeps exactly the GFS set.
- A failed listing prunes nothing.

**Tests.**
- `backup-retention.test.ts`: GFS; the newest verified backup is always kept;
  pre-restore protection; a listing error means no prune.
- `backup-destinations.test.ts`: depot unreachable → `reachable:false` with a
  human message and no exception; cloud upload mocked.
- A health test covers each §9 state.

### Phase 3: Settings UI (Beállítások → Mentés / Settings → Backup)

**Where.** A new tab in the settings tab set (`#settingsTabNav`,
`web/index.html:1524`), rendered in `web/app.js` next to the existing tabs.

**Content, top to bottom.**
1. **Status line** (plain words): "Legutóbbi mentés: ma 03:30, 3 helyen megvan
   (gép, F: Raktár, Google Drive)." / "Last backup: today 03:30, stored in 3
   places (…)". The colour follows §9.
2. **[Mentés most / Back up now].** It shows progress while running (the
   collecting, database, encrypting and copying stages) and a result toast
   when the job **finishes**, not when it is sent (lesson from 2026-08-12).
   The job id is polled at `GET /api/backup/jobs/:id`.
3. **Emergency kit** (shown until confirmed, then collapsed with "Mutasd
   újra"):
   - What it is: "Ezzel a kulccsal nyitható ki a mentés egy új gépen. Nélküle
     senki, mi sem tudjuk visszaállítani."
   - [Letöltés] (a `.txt` / printable HTML page with the key, the date, the
     key id and restore instructions in HU+EN)
   - [Megmutatom]
   - A required checkbox: "Elmentettem biztonságos helyre (pl. jelszókezelő,
     kinyomtatva)".
   - Until it is confirmed, the status line stays **orange**, not red (this is
     a "recommended" tier, per the user-is-not-a-programmer tiers).
4. **Where it goes:**
   - A list of destinations with on/off switches.
   - The depot row shows the resolved Windows path.
   - The cloud row has an account picker (from the already-connected Google /
     MEGA accounts) and a folder picker.
   - Each row has a one-line why, and a "what if off" line.
5. **When:** the daily time and the retention summary in words.
6. **Backups list:** date, size, where (icons per destination), verified ✓/✗.
   Actions: [Letöltés] (downloads the encrypted file) and [Visszaállítás]
   (→ Phase 5).
7. **Advanced** (collapsed): include diagnostic logs; set own password instead
   of the generated key; rotate key.

**Server routes.** New file `src/web/routes/backup.ts`, registered where the
other routes are.
- `GET /api/backup/status`
- `POST /api/backup/run` → `{ jobId }`
- `GET /api/backup/jobs/:id`
- `GET /api/backup/list`
- `GET /api/backup/download/:name`: streams the file; path-traversal guarded;
  only names in the list.
- `GET /api/backup/kit`: the key text. Requires a dashboard session **plus**
  re-entering the dashboard password when login is enabled.
- `POST /api/backup/kit/confirm`
- `PUT /api/backup/config`

Every error response is `{ error: code, message: {hu,en}-resolved }`.

**Tests.**
- Route tests: the run → job → done lifecycle; the download traversal guard
  (`../`); kit access needs auth.
- `lang-parity` and `i18n-no-hardcoded-hu` stay green.
- A UI source test asserts that the tab and the button bind to the routes (the
  pattern of `agents-grid-stopped-last.test.ts`).

### Phase 4: Restore engine

**New files.**
- `src/backup/inspect.ts`
  - `export async function inspectBackup(file, recoveryKey): Promise<Inspection>`
  - Steps: decrypt to a staging dir, verify every `sha256`, parse the
    manifest, open the DB copy read-only, run `integrity_check`, compute
    counts.
  - It compares against the current install and returns
    `{ manifest, compat, categories: [{id, items, willOverwrite, willAdd}], dbCounts: {backup, current}, pathRewrites: [...], warnings: [...] }`.
- `src/backup/compat.ts`: `export function checkCompat(manifest, currentVersion, currentFingerprint): { ok: boolean; reason?: 'backup_newer'|'format_unknown'; needsMigration: boolean }`.
  - `format > 1` → refuse (the user must update Marveen first).
  - `appVersion` newer than the running one → refuse with "Előbb frissítsd a
    Marveent (Beállítások → Frissítés), utána töltsd be a mentést." and a
    button to that page.
  - Older → allowed; `needsMigration=true`. The normal DB migrations in
    `src/db.ts` (idempotent `CREATE TABLE IF NOT EXISTS` + guarded
    `ALTER TABLE`) run on the next start.
- `src/backup/path-rewrite.ts`
  - `export function planPathRewrites(manifest.pathHints, current): Rewrite[]`
    and `applyPathRewrites(stagingDir, rewrites)`. Rewrites only these
    **known** locations:
    - `config/*/projects/<oldSlug>/` → `<newSlug>/`. The slug is Claude Code's
      project-dir encoding of `PROJECT_ROOT` (`/`→`-`) and **must** use the
      same function the app already uses to find memory dirs; do not
      re-derive it.
    - Absolute `PROJECT_ROOT`/`HOME` prefixes inside `agents/*/agent-config.json`
      (`claudeConfigDir` etc.), `store/life-mounts.json`, `store/storages.json`,
      `store/git-sync.json`, `.env` keys whose value starts with the old
      root.
    - Anything else that contains the old root is listed in
      `warnings` for the preview ("these N settings still point to the old
      machine"); it is never rewritten silently.
- `src/backup/restore-runner.ts`: a detached process (`node dist/backup/restore-runner.js <planFile>`), spawned by the dashboard, which then exits.
  1. Wait for the dashboard to exit (pid file). Stop agent sessions and the
     schedulers via the same stop path the dashboard uses for a restart.
  2. Write `store/restore-in-progress.json` (the dashboard refuses to start
     normally while it exists, and shows "Visszaállítás folyamatban").
  3. Move each target that will be overwritten to
     `store/restore-rollback/<stamp>/<logical path>` (rename, not copy: fast
     and atomic per file).
  4. Move the staged files into place. Put the DB in with `-wal`/`-shm`
     **deleted first** (Vaultwarden lesson).
  5. Start the dashboard (`performSelfRestart()` equivalent). On boot it runs
     the migrations, then a **post-restore check**: DB `integrity_check`, and
     counts ≥ manifest counts for the core tables (kanban_cards, memories,
     daily log, approvals, projects).
  6. Pass → delete `restore-in-progress.json` and record the result. The
     rollback dir is kept 7 days, then removed by the retention sweep.
  7. Fail → **automatic rollback**: move the rollback dir back, restart, and
     record the failure with the reason.
- Channel safety (**one bot, one poller**): after restore, **all channel
  pollers start paused** (`store/channels-paused-after-restore.json`) until
  the user confirms in the wizard: "A régi gépen leállítottad a Marveent?"
  - Why: two machines polling the same Telegram bot steal each other's updates.
    The existing `docs/MIGRATION.md` "one-bot-one-poller" note is the source.

**Pre-restore backup.** Before step 1, `createBackup({kind:'pre-restore'})` of
the current state. If that fails, **abort the restore**; the only exception is
when the install is fresh (DB has 0 kanban cards, 0 memories and no agents).
Then there is nothing to protect, and the preview says so.

**Disk space.** Before starting, require free space ≥ 3× the uncompressed
payload (staging + rollback + margin). Otherwise refuse with the numbers.

**Tests.**
- `backup-restore-e2e.test.ts`:
  - Build install A (fixture: cards, memories, 2 agents, one isolated config
    dir, a skill, a scheduled task, life-tree config). Back it up.
  - Create an **empty** install B with a different `PROJECT_ROOT` and `HOME`,
    and restore into it (runner invoked in-process with injectable
    stop/start).
  - Assert that every count matches, the memory dirs landed under B's slug,
    `agent-config.json` paths point into B, and the channels are paused.
- `backup-restore-rollback.test.ts`: inject a failure in step 4 (for example,
  make one target read-only); assert that B is byte-identical to its
  pre-restore state.
- `backup-compat.test.ts`: newer backup refused; unknown format refused; older
  allowed with `needsMigration`.
- `backup-path-rewrite.test.ts`: slug rewrite; the unknown absolute-path
  warning.

### Phase 5: Restore UI and fresh-install wizard

**Restore flow** (from Settings → Backup → a list row, or from an uploaded
file).
1. **Choose.**
   - From the list: backups in local, depot or cloud.
   - Or [Fájl feltöltése] (a chunked upload into `store/tmp`, with a size
     limit taken from config).
   - Or "a Raktárban lévő mentések" (scan of `DEPOT_BACKUPS`, if the depot is
     reachable).
2. **Key.** Use the stored key automatically when `keyId` matches. Otherwise
   ask for the recovery key, with a hint on where the emergency kit is. A wrong
   key gives the message "Ez a kulcs nem ehhez a mentéshez tartozik (kulcs
   azonosító: ABCD1234). Nézd meg a vészhelyzeti lapot." and nothing else
   happens.
3. **Preview.** This is required before any change (a fresh-install rule).
   - A table per category: "Kanban kártyák: most 0 → mentésből 412",
     "Ágensek: 2 új", "Skillek: 37 felülírás, 5 új", …
   - Warnings from `inspect` (paths still pointing to the old machine, agents
     that need a Claude login).
   - Checkboxes for the opt-out file categories. The DB checkbox is fixed on,
     with the explanation of why (§2.1).
4. **Confirm.** One button, with the automatic pre-restore backup named in the
   text: "Előtte elmentem a mostani állapotot, és ha valami nem sikerül,
   magától visszaállok."
5. **Progress.** The page polls `GET /api/backup/restore/status`, which
   survives the dashboard restart because it reads a file written by the
   runner.
6. **Result.**
   - Success: counts, plus a list of the **next steps**, each a link:
     - log in each agent that needs Claude login
     - confirm "the old machine is off" to un-pause the channels
     - reconnect the depot if its drive letter differs
   - Failure: "Visszaállítottam az előző állapotot. Ok: …".

**Fresh-install wizard.** A fresh install is detected by the server, never by
the client guessing: `setup_required` (`src/web/routes/auth.ts:167`,
`countDashboardUsers(true) === 0`) **and** 0 kanban cards **and** 0 memories.
- The first screen (before or alongside the create-login form in `web/app.js`,
  `renderCreateLoginForm`, around line 25477) asks: **"Van már mentésed egy
  korábbi Marveenből? / Do you have a backup from an earlier Marveen?"**
  - [Igen, betöltöm / Yes, restore it] → the restore flow above, file upload
    first (on a new machine the depot or cloud may not be connected yet).
  - [Nem, új kezdés / No, start fresh] → the normal onboarding.
- The dashboard login created in the wizard is replaced by the restored one;
  the wizard says so beforehand.
- The fresh-install gate must not reappear after the choice: a stored
  `store/onboarding-choice.json`.

**Tests.**
- UI binding source test; i18n gates.
- Wizard gating: shown only when all three fresh conditions hold, with a test
  for each negative.

### Phase 6: Verify and restore test (the "0" in 3-2-1-1-0), docs, skill

- `src/backup/verify.ts`: `export async function verifyBackup(file): Promise<VerifyResult>`.
  - Decrypt, check all hashes, run DB `integrity_check`, then **trial-restore**
    into a throwaway dir (the Phase 4 steps 3-4 on a scratch root plus the DB
    migrations run against the copy), and compare the counts.
  - Scheduled weekly on the newest backup, and after every manual backup
    (in the background).
  - The result is written into `store/backup-state.json` and shown as ✓/✗ in
    the list.
- Off-site verification: once a month, download the newest cloud copy and
  verify it (this catches "the upload is silently truncated").
- `docs/MIGRATION.md`: rewrite around the UI flow; keep the manual CLI path as
  an appendix (`node dist/backup/cli.js restore <file>`).
- Seed skill `seed-skills/backup-restore/SKILL.md` (`scope: global`,
  placeholders only): how an agent answers "hol a mentésem / állítsd vissza".
  It must not restore on a channel request without the owner's explicit
  confirmation; restore is irreversible for the current state apart from the
  rollback window.

**Tests.** `backup-verify.test.ts`: a good backup passes; a corrupted DB inside
a correctly encrypted archive fails at `integrity_check`; a missing file fails
the hash stage.

---

## 6. Cross-cutting details

### 6.1 Keys

- `store/.backup-key` is **never** written into any backup destination
  directory, and never into the archive itself. A backup that contains its own
  key protects nothing.
- Although it sits in `store/`, it is explicitly listed in `STORE_EXCLUDE`,
  so it never lands in the secrets group. The new machine gets the key from
  the emergency kit.
- The vault key (`store/.vault-key`) **is** included. It is protected by the
  backup encryption, and without it `vault.json` is useless (a measured lesson
  from 2026-08-19, `backup.sh` comment).
- Rotation: new backups use the new key. Old backups need their own key
  (`previous[]`); the kit download includes every key still referenced by a
  retained backup.

### 6.2 Concurrency

- Backup and restore share one lock (`store/locks/backup.lock`). A restore
  refuses to start during a backup and vice versa.
- A scheduled backup never starts while `restore-in-progress.json` exists.

### 6.3 Agent parity

- The inventory is enumerated from `listAgentNames()` +
  `MAIN_AGENT_ID` + the config-dir resolvers; no agent is special-cased.
- A test creates N agents with mixed config-dir setups and asserts that all N
  memory dirs are in the archive.
- Backup is a host-level function run by the dashboard, so no per-agent hook
  is needed. `src/agent-parity.ts` does not change.

### 6.4 Host independence

- Logical roots (§3) and `pathHints` rewriting (Phase 4).
- The file name uses a sanitised short hostname; nothing else is host-bound.
- Windows depot paths: resolve via the existing depot helpers; never
  construct `F:\...` literally.

### 6.5 What restore deliberately does not do

- It does not install systemd units or launchd plists (these are
  `service_systemd_change`, approval level 2; the installer owns them).
  The preview lists differences between the backup and the current units.
- It does not overwrite Claude CLI login state.
- It does not merge `settings.json` hooks. `ensureAgentHooks()` rebuilds them
  from `templates/settings.json.template` on start (the agent-parity rule), so
  restoring an old copy would only reintroduce stale hooks.

---

## 7. UX texts (key ones; HU / EN)

| Key | HU | EN |
|---|---|---|
| `backup.title` | Mentés és visszaállítás | Backup and restore |
| `backup.why` | Egy fájlban elmenti a Marveen minden adatát: kártyák, memória, ágensek, beállítások, fiókok. Ha elromlik vagy lecseréled a gépet, ebből minden visszajön. | Saves everything Marveen knows into one file: cards, memory, agents, settings, accounts. If the machine breaks or you replace it, everything comes back from this. |
| `backup.run` | Mentés most | Back up now |
| `backup.kit.title` | Vészhelyzeti lap: a mentés kulcsa | Emergency kit: your backup key |
| `backup.kit.why` | Ezzel a kulccsal nyitható ki a mentés egy új gépen. Nélküle senki, mi sem tudjuk visszaállítani. Tedd jelszókezelőbe, vagy nyomtasd ki. | This key opens your backup on a new machine. Without it nobody, not even us, can restore it. Put it in a password manager or print it. |
| `backup.restore.preview` | Ez fog történni | What will happen |
| `backup.restore.safety` | Előtte elmentem a mostani állapotot. Ha valami nem sikerül, magától visszaállok. | I will save the current state first. If anything fails, I roll back automatically. |
| `backup.wizard.q` | Van már mentésed egy korábbi Marveenből? | Do you have a backup from an earlier Marveen? |
| `backup.channels.paused` | A csatornák (Telegram stb.) szünetelnek, amíg meg nem erősíted, hogy a régi gépen leállítottad a Marveent. Ha mindkettő fut, elkapkodják egymás elől az üzeneteket. | Channels (Telegram etc.) are paused until you confirm that Marveen is stopped on the old machine. If both run, they steal each other's messages. |

---

## 8. Test plan summary

| Level | What | Where |
|---|---|---|
| Unit | crypto round-trip and tamper cases, inventory coverage, retention GFS, compat, path rewrite | `src/__tests__/backup-*.test.ts` |
| Integration | DB snapshot under concurrent writes; create → inspect; destinations with unreachable depot/cloud | same |
| **End-to-end** | Install A → backup → **empty install B with different paths** → restore → every count equal, memories at the new slug, channels paused | `backup-restore-e2e.test.ts` |
| Failure | rollback on a mid-restore failure; wrong key; truncated file; newer-version backup | `backup-restore-rollback.test.ts`, `backup-compat.test.ts` |
| Live acceptance (manual, once, recorded on #396) | On this host: back up, then restore into a scratch clone of the repo (a separate `PROJECT_ROOT`, a separate port, **channels disabled**) and compare `/api/kanban`, `/api/memories` and the agent list counts with production. | — |

Tests must never touch the live install: `src/__tests__/setup/assert-not-live-install.ts`
already refuses; every test uses temp roots via `vi.mock('../config.js')`.

---

## 9. States and the two meanings of zero

| Situation | What the code checks | What the user sees |
|---|---|---|
| Fresh install, no backup yet, kit not set | `backup-state.json` absent **and** the DB is fresh | Neutral: "Még nincs mentés. Az első ma éjjel 03:30-kor készül, vagy nyomd meg a Mentés most gombot." |
| Backups exist, depot listing returns 0 files | Is the depot reachable (`existsSync` + a read probe)? | Reachable → "A Raktárban még nincs mentés" (neutral, the next run fills it). **Unreachable** → orange: "Az F: Raktár most nem elérhető, ezért oda nem ment a mentés." |
| Cloud listing 0 | API call succeeded vs failed/expired token | Succeeded → neutral. Failed → orange, with the account name and "Csatlakoztasd újra". |
| Last run older than 36 h | `lastSuccessAt` | Orange. |
| Last run failed | `lastResult.ok === false` | Red, with the message. |
| Only 1 of 3 destinations has the newest backup | replica results | Orange: "Csak a gépen van meg, ha a gép elromlik, elvész." |
| Verify failed | `lastVerify.ok === false` | Red. |
| Kit not confirmed | `key.confirmedAt == null` | Orange (a recommended tier, never red). |

The Áttekintés self-check shows at most one line for backup. It folds into
"Egyéb" per the 2-row rule (`selfcheck-and-login-ui.test.ts`).

---

## 10. Second review round: what could go wrong

1. **The key is lost, so the backups are worthless.**
   - Mitigation: the kit is required, and the orange state stays until it is
     confirmed.
   - The kit download works any time from Settings.
   - A reminder on key rotation.
   - This is not solvable cryptographically. The HA docs are explicit that
     it is the user's responsibility, and the UI says so plainly.
2. **Two machines alive after a restore** → bot pollers fight, and scheduled
   tasks run twice.
   - Mitigation: channels paused after restore (Phase 4).
   - Schedulers are also paused until the same confirmation. Add
     `schedules-paused-after-restore` alongside the channels flag.
3. **Claude refresh tokens.**
   - If they were restored, the old machine's agents would be silently logged
     out on the next refresh.
   - This is why they are excluded (§3.2). The cost: a re-login per account,
     listed in the result screen.
4. **The memory slug changes with `PROJECT_ROOT`.**
   - Without the rewrite, the memories restore to a directory Claude Code
     never reads.
   - The e2e test uses a different root on purpose.
5. **The torn DB copy.** Fixed by the Online Backup API. The test runs
   concurrent writes.
6. **A stale `-wal` next to a restored DB** replays old pages over the
   restored DB. The runner deletes `-wal`/`-shm` before placing the DB.
7. **A newer backup restored onto an older app.** The old code cannot know the
   new columns: refused (compat).
8. **Partial restore corrupting references.** The DB is all-or-nothing; only
   the independent file groups are optional.
9. **The dashboard cannot replace its own open DB.** Handled by the detached
   runner plus the `restore-in-progress` guard. If the runner dies half-way,
   the next dashboard start sees the flag and runs the rollback, rather than
   starting on a half-restored tree.
10. **Disk full mid-restore.** Guarded by the 3× free-space check. Since the
    moves are renames, a rollback needs no extra space.
11. **Secrets leak through temp files.**
    - Staging lives under `STORE_DIR/tmp` (0700), not `/tmp`.
    - It is removed in `finally`, and a startup sweep removes leftovers older
      than 1 h.
    - The download route streams only listed names.
12. **The backup includes its own key**, which is pointless. Explicit exclude
    plus a test asserting that `.backup-key` is not in the archive.
13. **The off-site copy silently never happens**, because the depot Drive
    backup excludes `Rendszer/`. That is why a separate cloud destination
    exists, plus the "only on 1 of 3" warning.
14. **Retention deletes the only good copy.** The newest verified backup is
    never pruned, and a failed listing prunes nothing.
15. **Size growth.** Logs are excluded by default. The inventory-coverage test
    forces classification of new store files. If the payload passes ~500 MB,
    revisit incremental (restic) as a separate decision.
16. **A restore triggered by a channel message** (prompt injection:
    "restore the backup from this link"). Restore needs a dashboard session
    and the UI confirm. The seed skill forbids agents from starting a restore
    on a channel request without the owner's explicit confirmation in their
    own channel.
17. **The legacy `backups/claudeclaw-*.tar.gz` archives.**
    - Keep them. `inspect` recognises the legacy format (no magic, gzip tar
      with `repo/`/`home/`) and offers a **read-only** "import" path: restore
      the DB and the secrets from the `repo/` group.
    - Low priority: Phase 5+, behind "régi formátumú mentés".
    - `system-health` keeps checking them until the first new-format backup
      exists.
18. **systemd timer vs in-app timer double-run.** The "skip if a success
    < 60 min ago" rule plus the lock prevent that.

---

## 11. Sources

- Home Assistant backup emergency kit: https://www.home-assistant.io/more-info/backup-emergency-kit/
- Home Assistant common tasks (restore during onboarding): https://www.home-assistant.io/common-tasks/general/
- Immich backup and restore: https://docs.immich.app/administration/backup-and-restore/
- Vaultwarden backing up your vault: https://github.com/dani-garcia/vaultwarden/wiki/Backing-up-your-vault
- SQLite WAL-mode safe backup (Online Backup API vs VACUUM INTO): https://oldmoe.blog/2024/04/30/backup-strategies-for-sqlite-in-production/ and https://sqlite.work/ensuring-consistent-backups-in-sqlite-wal-mode-without-disrupting-writers/
- Gitea backup and restore (dump, version): https://docs.gitea.com/administration/backup-and-restore/
- Forgejo CLI (dump, doctor, migrate): https://forgejo.org/docs/v15.0/admin/command-line/
- Borg vs restic vs Kopia (KDF, key models): https://computingforgeeks.com/borg-restic-kopia-comparison/
- Streaming AES-GCM file encryption design (chunk index in AAD/IV): https://github.com/SocialGouv/streaming-file-encryption
- Proxmox Backup Server verify jobs / 3-2-1-1-0: https://pbs.proxmox.com/docs/storage.html and https://nimbus.rdem-systems.com/en/blog/complete-proxmox-backup-guide/
