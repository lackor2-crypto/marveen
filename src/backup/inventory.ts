/**
 * WHAT GOES INTO A FULL BACKUP (#396, docs/BACKUP-RESTORE-PLAN.md §3).
 *
 * An ALLOWLIST with named categories, never "everything minus a denylist": a
 * new secret file has to be decided on consciously. The coverage test
 * (backup-inventory-coverage.test.ts) fails when the source code starts using a
 * `store/<name>` that is in neither STORE_INCLUDE nor STORE_EXCLUDE, so the
 * next developer who adds a store file is forced to classify it. That is the
 * mechanism that would have caught the gaps the old scripts/backup.sh had
 * (per-account memories, life-tree config, cloud config, hand-made files).
 *
 * Paths are stored under LOGICAL roots, never absolute ones, so a restore onto a
 * machine with a different PROJECT_ROOT / HOME puts every file where the new
 * machine expects it:
 *   project/...        PROJECT_ROOT
 *   home/...           the user's home directory
 *   config/<owner>/... a Claude config dir (<owner> = main, an agent name, ...)
 */
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, sep } from 'node:path'

export type BackupCategory =
  | 'database' | 'secrets' | 'settings' | 'knowledge' | 'agents' | 'memory'
  | 'skills' | 'schedules' | 'depot-config' | 'git' | 'reference' | 'logs'

export const BACKUP_CATEGORIES: readonly BackupCategory[] = [
  'database', 'secrets', 'settings', 'knowledge', 'agents', 'memory',
  'skills', 'schedules', 'depot-config', 'git', 'reference', 'logs',
]

export interface InventoryItem {
  /** Path inside the archive, `/`-separated, starting with a logical root. */
  logical: string
  abs: string
  category: BackupCategory
  kind: 'file' | 'dir'
}

/** Where a config/<owner> root lives, so a restore can map it to the new machine. */
export interface ConfigRoot {
  owner: string
  kind: 'main' | 'agent' | 'default' | 'account'
  abs: string
  /** Relative location: under the project root, under home, or neither. */
  base: 'project' | 'home' | 'abs'
  rel: string
}

export interface InventoryContext {
  projectRoot: string
  storeDir: string
  home: string
  mainAgentId: string
  /** The config dir the main agent really runs on (mainAgentEffectiveConfigDir()). */
  mainConfigDir: string
  agents: { name: string; configDir: string | null }[]
}

export interface Inventory {
  items: InventoryItem[]
  configRoots: ConfigRoot[]
  /** Optional entries that are simply not present on this install (not an error). */
  missing: string[]
  /** Present but unreadable: a real problem the user must hear about (§9). */
  unreadable: { path: string; error: string }[]
}

// ---------------------------------------------------------------------------
// store/ classification (top-level entry names)
// ---------------------------------------------------------------------------

const STORE_SECRETS = [
  '.dashboard-token', '.vault-key', 'vault.json', 'vault-bindings.json', 'vault-acl.json',
  'google-tokens.json', 'google-oauth-client.json', '.github-tokens.json', '.git-tokens.json',
  'mega-accounts.json', '.claude-oauth-token',
] as const
const STORE_SETTINGS = [
  'autonomy-config.json', 'email-rules.json', 'agents-desired.json', 'config-overrides.json',
  'main-account.json', 'egress-allowlist.json', 'openrouter-manual.json', 'costops-config.json',
  'auto-restart.json', 'norbert-personal.json', 'key-service-active.json', 'backup-rules.json',
  'git-readonly-kivetelek.json', 'email-attachment-flags.json', 'mt4-terminal-dir.txt',
  'marveen-avatar.png', 'backup-config.json',
] as const
const STORE_SETTINGS_DIRS = ['folder-icons'] as const
const STORE_DEPOT_CONFIG = [
  'life-tree.json', 'life-tree-created.json', 'life-mounts.json', 'life-labels.json',
  'life-archived.json', 'life-physical.json', 'storages.json', 'drive-sync.json', 'git-sync.json',
  'drive-skiplist.json',
] as const
const STORE_KNOWLEDGE_DIRS = ['knowledge', 'drafts', 'photos', 'face-gallery'] as const

/**
 * Every top-level store/ name the backup TAKES (fully or partly). The database
 * is snapshotted separately (db-snapshot.ts), `rclone/` contributes only
 * rclone.conf and `accounts/` only memories and skills.
 */
export const STORE_INCLUDE: readonly string[] = [
  'claudeclaw.db',
  ...STORE_SECRETS, ...STORE_SETTINGS, ...STORE_SETTINGS_DIRS,
  ...STORE_DEPOT_CONFIG, ...STORE_KNOWLEDGE_DIRS,
  'rclone', 'accounts',
]

/**
 * Every top-level store/ name the backup deliberately LEAVES OUT, with the why
 * grouped per line. See §3.2 of the plan.
 */
export const STORE_EXCLUDE: readonly (string | RegExp)[] = [
  // The backup's own key: a backup that carries its own key protects nothing
  // (§6.1). The new machine gets it from the emergency kit.
  '.backup-key',
  // Live DB sidecars: never copied raw (torn-copy risk); the snapshot replaces them.
  'claudeclaw.db-wal', 'claudeclaw.db-shm', 'claudeclaw.db-journal', /^\*ledger\*\.db$/,
  // Claude CLI login state: device-bound, rotating refresh tokens (§3.2).
  'claude-login', /^\.cred-/, /^\.claude-oauth-token\./, 'claude-plans.json',
  // Backups must not back up backups; old ad-hoc copies.
  'backups', 'tmp', 'restore-rollback', /^\.env\.bak/, /\.bak(-|$)/, 'windows-settings-backups',
  'persistent-windows-backups', 'deleted-agents', 'windows-settings', 'window-layout-repo',
  // Caches (regenerable).
  'cache', 'browser', 'workbench-render', 'openrouter-models.json', 'claude-model-scan.json',
  'mega-quota.json', 'drive-quota.json', 'usage-latest.json', 'upstream-changes.json',
  'upstream-fix-only-files.json', 'upstream-247-restrictions.json', 'upstream-sync-status.json',
  // Logs and journals (diagnostics, not data; opt-in via includeLogs).
  /\.log(\.\d+)?$/, /\.jsonl(\.\d+)?$/, 'event-log.txt', 'test-guard.log', 'pipeline-runs',
  // Runtime state: describes the OLD machine's running processes.
  /\.pid$/, 'locks', /-state\.json$/, /^schedule-tick-state\.json/, 'rate-limit-status',
  'agent-taskstate', /^\.agent-failures-/, /^\.channel-/, /^\.fleet-/, /^\.ratelimit-/,
  /^\.google-/, /^\.last-/, /^\.morning-/, '.subagent-retry', '.deployed-sha', '.win-home',
  '.default-projects-seeded', '.vault-key.migrated', 'deploy.lock', 'update.last-result',
  'upstream-measure.pid', 'limit-wake-alive.json', 'code-bot-offset', 'code-bot-stt',
  'agent-parity-alert.json', 'command-task-health.json', 'commit-push-dispatch.json',
  'context-broker.json', /^context-guard-last-pane-/, 'context-restart-gate.json',
  'context-restart-gate-status.json', 'drive-delete-queue.json', 'external-ops-last-run',
  'kanban-audit-state.json', 'schedule-last-run.json', 'terminal-input.json', 'pending-patches',
  'task-run-history.json', 'backup-state.json', 'restore-in-progress.json', 'onboarding-choice.json',
  /^channels-paused-after-restore\.json$/, /^schedules-paused-after-restore\.json$/,
  /^drive-sync-paused-/, /\.state$/, /\.tmp$/,
  // Install-generated helper scripts (the installer recreates them).
  /\.sh$/, 'costops-config.json.example',
  // Owner notes that are not app data.
  /^git-takaritas-/, /\.md$/,
]

export function classifyStoreEntry(name: string): 'include' | 'exclude' | 'unclassified' {
  if (STORE_INCLUDE.includes(name)) return 'include'
  for (const e of STORE_EXCLUDE) {
    if (typeof e === 'string' ? e === name : e.test(name)) return 'exclude'
  }
  return 'unclassified'
}

// ---------------------------------------------------------------------------
// Context (the real one; tests pass their own)
// ---------------------------------------------------------------------------

export async function defaultInventoryContext(): Promise<InventoryContext> {
  const { PROJECT_ROOT, STORE_DIR, MAIN_AGENT_ID } = await import('../config.js')
  const ac = await import('../web/agent-config.js')
  let mainConfigDir = join(homedir(), '.claude')
  try { mainConfigDir = ac.mainAgentEffectiveConfigDir() } catch { /* default */ }
  const agents = ac.listAgentNames().map((name) => {
    let configDir: string | null = null
    try { configDir = ac.readAgentClaudeConfigDir(name) } catch { /* unreadable config: default dir */ }
    return { name, configDir }
  })
  return { projectRoot: PROJECT_ROOT, storeDir: STORE_DIR, home: homedir(), mainAgentId: MAIN_AGENT_ID, mainConfigDir, agents }
}

// ---------------------------------------------------------------------------
// Enumeration
// ---------------------------------------------------------------------------

function real(p: string): string {
  try { return realpathSync(p) } catch { return p }
}

function under(root: string, p: string): string | null {
  const rel = relative(root, p)
  if (!rel || rel.startsWith('..') || rel.startsWith(sep) || /^[a-zA-Z]:/.test(rel)) return rel === '' ? '' : null
  return rel.split(sep).join('/')
}

const OWNER_RE = /^[a-z0-9][a-z0-9_.-]*$/i

/** The distinct Claude config dirs worth taking memories/skills from. */
export function resolveConfigRoots(ctx: InventoryContext): ConfigRoot[] {
  const out: ConfigRoot[] = []
  const seen = new Set<string>()
  const add = (owner: string, kind: ConfigRoot['kind'], abs: string) => {
    if (!abs || !existsSync(abs)) return
    const key = real(abs)
    if (seen.has(key)) return
    seen.add(key)
    const inProject = under(ctx.projectRoot, abs)
    const inHome = under(ctx.home, abs)
    const base: ConfigRoot['base'] = inProject !== null && inProject !== '' ? 'project' : inHome !== null && inHome !== '' ? 'home' : 'abs'
    const rel = base === 'project' ? inProject! : base === 'home' ? inHome! : abs
    out.push({ owner, kind, abs, base, rel })
  }
  add('main', 'main', ctx.mainConfigDir)
  for (const a of ctx.agents) {
    if (a.configDir && OWNER_RE.test(a.name)) add(a.name, 'agent', a.configDir)
  }
  // The shared default dir, when the main agent runs elsewhere: the operator's
  // own Claude Code sessions (and the main agent's pre-#290 memories) live here.
  add('default', 'default', join(ctx.home, '.claude'))
  // Per-account dirs the dashboard provisioned (store/accounts/<id>/) that no
  // agent currently points at: their memories are still the owner's data.
  const accounts = join(ctx.storeDir, 'accounts')
  if (existsSync(accounts)) {
    for (const id of safeReaddir(accounts)) {
      const p = join(accounts, id)
      if (OWNER_RE.test(id) && isDir(p) && existsSync(join(p, 'projects'))) add(`account-${id}`, 'account', p)
    }
  }
  return out
}

function safeReaddir(p: string): string[] {
  try { return readdirSync(p).sort() } catch { return [] }
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory() } catch { return false }
}

export function collectInventory(ctx: InventoryContext, opts: { includeLogs?: boolean } = {}): Inventory {
  const items: InventoryItem[] = []
  const missing: string[] = []
  const unreadable: { path: string; error: string }[] = []
  const seen = new Set<string>()

  const add = (logical: string, abs: string, category: BackupCategory, optional = true) => {
    if (seen.has(logical)) return
    let st
    try { st = lstatSync(abs) } catch (err: any) {
      if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') { if (optional) missing.push(logical); return }
      unreadable.push({ path: logical, error: String(err?.code || err?.message || err) })
      return
    }
    // A symlinked dir is kept as a link (the tar stores it as one); only its
    // own target is recorded, never followed into (it may be a shared tree).
    const kind: 'file' | 'dir' = st.isDirectory() ? 'dir' : 'file'
    if (!st.isDirectory() && !st.isFile() && !st.isSymbolicLink()) return
    seen.add(logical)
    items.push({ logical, abs, category, kind })
  }
  const P = ctx.projectRoot
  const S = ctx.storeDir
  const storeLogical = (() => {
    const rel = under(P, S)
    return rel ? `project/${rel}` : 'project/store'
  })()

  // -- secrets -------------------------------------------------------------
  add('project/.env', join(P, '.env'), 'secrets')
  for (const f of STORE_SECRETS) add(`${storeLogical}/${f}`, join(S, f), 'secrets')
  add(`${storeLogical}/rclone/rclone.conf`, join(S, 'rclone', 'rclone.conf'), 'secrets')
  const channelSets: { base: string; logical: string }[] = [
    { base: join(P, '.claude', 'channels'), logical: 'project/.claude/channels' },
    { base: join(ctx.home, '.claude', 'channels'), logical: 'home/.claude/channels' },
  ]
  for (const a of ctx.agents) {
    if (OWNER_RE.test(a.name)) {
      channelSets.push({ base: join(P, 'agents', a.name, '.claude', 'channels'), logical: `project/agents/${a.name}/.claude/channels` })
    }
  }
  for (const cs of channelSets) {
    for (const prov of safeReaddir(cs.base)) {
      if (!isDir(join(cs.base, prov))) continue
      for (const f of ['.env', 'access.json', 'invites.json', 'approved']) {
        const abs = join(cs.base, prov, f)
        if (existsSync(abs)) add(`${cs.logical}/${prov}/${f}`, abs, 'secrets')
      }
    }
  }

  // -- settings / depot config / knowledge -----------------------------------
  for (const f of STORE_SETTINGS) add(`${storeLogical}/${f}`, join(S, f), 'settings')
  for (const d of STORE_SETTINGS_DIRS) add(`${storeLogical}/${d}`, join(S, d), 'settings')
  add('project/.lang', join(P, '.lang'), 'settings')
  for (const f of STORE_DEPOT_CONFIG) add(`${storeLogical}/${f}`, join(S, f), 'depot-config')
  for (const d of STORE_KNOWLEDGE_DIRS) add(`${storeLogical}/${d}`, join(S, d), 'knowledge')
  add('project/assets/meetings', join(P, 'assets', 'meetings'), 'knowledge')

  // -- schedules / skills ----------------------------------------------------
  add('project/scheduled-tasks.json', join(P, 'scheduled-tasks.json'), 'schedules')
  add('home/.claude/scheduled-tasks', join(ctx.home, '.claude', 'scheduled-tasks'), 'schedules')
  add('home/.claude/skills', join(ctx.home, '.claude', 'skills'), 'skills')

  // -- agents ----------------------------------------------------------------
  for (const a of ctx.agents) {
    if (!OWNER_RE.test(a.name)) continue
    const dir = join(P, 'agents', a.name)
    const L = `project/agents/${a.name}`
    for (const f of ['CLAUDE.md', 'SOUL.md', '.mcp.json', 'agent-config.json', 'avatar.png']) add(`${L}/${f}`, join(dir, f), 'agents')
    add(`${L}/.claude/skills`, join(dir, '.claude', 'skills'), 'skills')
    add(`${L}/.claude/agents`, join(dir, '.claude', 'agents'), 'agents')
    add(`${L}/memory`, join(dir, 'memory'), 'memory')
    // Kept for reference only: restore never puts hooks back (§6.5).
    add(`${L}/.claude/settings.json`, join(dir, '.claude', 'settings.json'), 'reference')
  }

  // -- Claude config dirs: memories, skills, settings (reference) -------------
  const configRoots = resolveConfigRoots(ctx)
  for (const r of configRoots) {
    const L = `config/${r.owner}`
    const projects = join(r.abs, 'projects')
    for (const slug of safeReaddir(projects)) {
      const mem = join(projects, slug, 'memory')
      if (isDir(mem)) add(`${L}/projects/${slug}/memory`, mem, 'memory')
    }
    // ~/.claude/skills is already taken under home/; do not take it twice.
    const skills = join(r.abs, 'skills')
    if (r.base !== 'home' || r.rel !== '.claude') add(`${L}/skills`, skills, 'skills')
    add(`${L}/settings.json`, join(r.abs, 'settings.json'), 'reference')
  }

  // -- reference: service units (never auto-restored, §3.1) -------------------
  const units = join(ctx.home, '.config', 'systemd', 'user')
  const prefix = `${ctx.mainAgentId}-`
  for (const f of safeReaddir(units)) {
    if (f.startsWith(prefix)) add(`home/.config/systemd/user/${f}`, join(units, f), 'reference')
  }
  const plists = join(ctx.home, 'Library', 'LaunchAgents')
  for (const f of safeReaddir(plists)) {
    if (f.startsWith(`com.${ctx.mainAgentId}.`) && f.endsWith('.plist')) add(`home/Library/LaunchAgents/${f}`, join(plists, f), 'reference')
  }

  // -- logs (opt-in) -----------------------------------------------------------
  if (opts.includeLogs) {
    for (const f of safeReaddir(S)) {
      if (/\.(log|jsonl)(\.\d+)?$/.test(f)) add(`${storeLogical}/${f}`, join(S, f), 'logs')
    }
  }

  return { items, configRoots, missing, unreadable }
}
