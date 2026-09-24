/**
 * BACKUP RULES: one rule per folder, shown in the Intezo (card #350).
 *
 * Boss, 2026-09-24: "kristálytisztán látnom kéne az intézőből, hogy mi hova
 * van felszinkronizálva" -- with ~20 cloud accounts, a folder and a folder
 * under it may go to different places, and it must never get mixed up.
 *
 * The model is deliberately the simplest one that cannot be ambiguous:
 *   - a folder MAY have its own rule: "back up to <account>" or "do not back up";
 *   - a folder without a rule INHERITS the nearest ancestor's rule;
 *   - no rule anywhere above = "not backed up" (a fresh install starts here).
 * So every folder has exactly ONE effective target, and a sub-folder can
 * override its parent.
 *
 * Setting a rule NEVER uploads anything. Turning a rule into a running backup
 * is a separate, explicit step (Boss, 2026-09-24: "de még ne töltsd fel semmit").
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { STORE_DIR } from './config.js'

export type BackupKind = 'drive' | 'mega'

export interface BackupTarget { kind: BackupKind; account: string }

export interface BackupRule {
  /** Folder path in the Intezo tree, `/`-separated, '' = the whole depot. */
  path: string
  /** `null` = "do not back up this folder (and what is under it)". */
  target: BackupTarget | null
  setAt: string
  /**
   * What this folder's backup leaves out (backup-exclude.ts entries: a
   * sub-folder `Projektek/Axxa` or a file type `*.fxt`). Absent = nothing.
   */
  exclude?: string[]
}

export interface EffectiveRule {
  target: BackupTarget | null
  /** The folder whose rule applies ('' = the depot root). `null` = no rule anywhere. */
  from: string | null
  /** True if the folder has its OWN rule (not inherited). */
  own: boolean
}

let fileOverride: string | null = null
/** Test-only: where the rules live. */
export function setBackupRulesFileForTests(p: string | null): void { fileOverride = p }
export function backupRulesFile(): string { return fileOverride ?? join(STORE_DIR, 'backup-rules.json') }

export function normRulePath(x: string): string {
  return String(x ?? '').trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '')
}

/**
 * Read the rules. A missing file is the normal fresh-install state (no rules);
 * an unreadable one is NOT the same thing, so it is reported, never treated as
 * "empty" -- an empty list would silently mean "nothing is backed up".
 */
export function loadBackupRules(): { rules: BackupRule[]; broken: string | null } {
  const f = backupRulesFile()
  if (!existsSync(f)) return { rules: [], broken: null }
  try {
    const d = JSON.parse(readFileSync(f, 'utf-8'))
    const raw: unknown[] = Array.isArray(d?.rules) ? d.rules : []
    const rules: BackupRule[] = []
    for (const r of raw as any[]) {
      if (!r || typeof r.path !== 'string') continue
      const t = r.target
      const target: BackupTarget | null = t && (t.kind === 'drive' || t.kind === 'mega') && typeof t.account === 'string' && t.account
        ? { kind: t.kind, account: t.account } : null
      const exclude = Array.isArray(r.exclude) ? r.exclude.filter((x: unknown) => typeof x === 'string' && x) : []
      rules.push({ path: normRulePath(r.path), target, setAt: String(r.setAt || ''), ...(exclude.length ? { exclude } : {}) })
    }
    return { rules, broken: null }
  } catch (e: any) {
    return { rules: [], broken: String(e?.message || e) }
  }
}

function saveBackupRules(rules: BackupRule[]): void {
  const f = backupRulesFile()
  mkdirSync(dirname(f), { recursive: true })
  const tmp = f + '.tmp'
  const sorted = [...rules].sort((a, b) => a.path.localeCompare(b.path))
  writeFileSync(tmp, JSON.stringify({ version: 1, rules: sorted }, null, 2) + '\n', 'utf-8')
  renameSync(tmp, f)
}

/** The rule that applies to `path`: its own, or the nearest ancestor's. */
export function effectiveRule(rules: readonly BackupRule[], path: string): EffectiveRule {
  const byPath = new Map(rules.map((r) => [r.path, r]))
  let p = normRulePath(path)
  let own = true
  for (;;) {
    const r = byPath.get(p)
    if (r) return { target: r.target, from: p, own }
    if (!p) return { target: null, from: null, own: false }
    own = false
    const i = p.lastIndexOf('/')
    p = i > -1 ? p.slice(0, i) : ''
  }
}

export type SetRuleInput = { path: string; action: 'target'; target: BackupTarget } | { path: string; action: 'none' | 'inherit' }

/**
 * Set / clear one folder's rule. Returns the new list. `inherit` removes the
 * folder's own rule (it then follows its parent again).
 */
export function setBackupRule(input: SetRuleInput, now = new Date()): BackupRule[] {
  const loaded = loadBackupRules()
  // Never overwrite a file we could not read: that would erase every rule.
  if (loaded.broken) throw new Error(`backup-rules.json is unreadable: ${loaded.broken}`)
  const path = normRulePath(input.path)
  const rest = loaded.rules.filter((r) => r.path !== path)
  if (input.action === 'inherit') { saveBackupRules(rest); return rest }
  const target = input.action === 'target' ? { kind: input.target.kind, account: input.target.account } : null
  // Changing where a folder goes keeps what it leaves out.
  const prev = loaded.rules.find((r) => r.path === path)
  const next = [...rest, { path, target, setAt: now.toISOString(), ...(prev?.exclude?.length ? { exclude: prev.exclude } : {}) }]
  saveBackupRules(next)
  return next
}

/**
 * For one rule WITH a target: which sub-folders must that backup leave out?
 * Every descendant folder that has its own rule (another account, or "do not
 * back up") -- they are handled by their own rule. Paths are relative to the
 * rule's folder, ready for `backup-exclude.ts`.
 */
export function childExclusions(rules: readonly BackupRule[], path: string): string[] {
  const p = normRulePath(path)
  const prefix = p ? p + '/' : ''
  return rules
    .filter((r) => r.path !== p && (p === '' || r.path.startsWith(prefix)))
    .map((r) => r.path.slice(prefix.length))
    .filter(Boolean)
    .sort()
}

/**
 * Set what one folder's backup leaves out. Only a folder with its OWN rule
 * pointing somewhere has a backup to leave things out of.
 */
export function setBackupExclude(path: string, exclude: string[]): BackupRule[] {
  const loaded = loadBackupRules()
  if (loaded.broken) throw new Error(`backup-rules.json is unreadable: ${loaded.broken}`)
  const p = normRulePath(path)
  const rule = loaded.rules.find((r) => r.path === p)
  if (!rule || !rule.target) throw new Error('no_own_target')
  const next = loaded.rules.map((r) => {
    if (r.path !== p) return r
    const { exclude: _old, ...rest } = r
    return exclude.length ? { ...rest, exclude: [...exclude] } : rest
  })
  saveBackupRules(next)
  return next
}
