// Backup rules API (card #350): one rule per folder, shown in the Intezo.
//
//   GET  /api/backup-rules        -- every rule + the accounts a rule can point to
//   POST /api/backup-rules/set    -- {path, action: 'target'|'none'|'inherit', kind?, account?}
//
// Setting a rule NEVER uploads anything (Boss, 2026-09-24: "de még ne töltsd
// fel semmit"). It only records where a folder SHOULD go.
import { json, readBody, reqLang, L } from '../http-helpers.js'
import { loadBackupRules, setBackupRule, normRulePath, type BackupKind } from '../../backup-rules.js'
import { loadDriveQuotas } from '../../drive-quota.js'
import { readMegaAccounts, readMegaQuota } from '../../mega.js'
import { loadSyncConfig } from './drive-sync.js'
import { resolveLifePath } from '../../life-explorer.js'
import type { RouteContext } from './types.js'

export interface BackupAccount {
  kind: BackupKind
  account: string
  /** Free bytes at the last measurement, `null` = never measured (not "0"). */
  free: number | null
  total: number | null
  measuredAt: string | null
}

/** Every account a rule can point to: the connected Drive accounts and the MEGA accounts. */
export function backupAccounts(): BackupAccount[] {
  const out: BackupAccount[] = []
  const quotas = loadDriveQuotas()
  const drive = new Set<string>(Object.keys(quotas))
  for (const p of loadSyncConfig().pairs) if (p.account) drive.add(String(p.account))
  for (const a of [...drive].sort()) {
    const q = quotas[a]
    out.push({
      kind: 'drive', account: a,
      free: q && q.limit > 0 ? Math.max(0, q.limit - q.usage) : null,
      total: q && q.limit > 0 ? q.limit : null,
      measuredAt: q?.at || null,
    })
  }
  const mq = readMegaQuota()
  for (const m of readMegaAccounts().sort((x, y) => x.name.localeCompare(y.name))) {
    const q = mq[m.name]
    out.push({
      kind: 'mega', account: m.name,
      free: q && typeof q.free === 'number' ? q.free : null,
      total: q && typeof q.total === 'number' ? q.total : null,
      measuredAt: q?.measuredAt ? new Date(q.measuredAt).toISOString() : null,
    })
  }
  return out
}

export async function tryHandleBackupRules(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx
  if (path !== '/api/backup-rules' && !path.startsWith('/api/backup-rules/')) return false
  const lang = reqLang(req, ctx.url)

  if (path === '/api/backup-rules' && method === 'GET') {
    const { rules, broken } = loadBackupRules()
    json(res, {
      rules,
      accounts: backupAccounts(),
      ...(broken ? {
        error: L(lang,
          `A mentési szabályok fájlja nem olvasható, ezért most egy szabályt sem látok. A fájl: store/backup-rules.json (${broken})`,
          `The backup rules file cannot be read, so no rule is visible right now. The file: store/backup-rules.json (${broken})`),
        code: 'rules_unreadable',
      } : {}),
    })
    return true
  }

  if (path === '/api/backup-rules/set' && method === 'POST') {
    let data: any = {}
    try { data = JSON.parse((await readBody(req)).toString('utf-8') || '{}') } catch { data = {} }
    const rel = normRulePath(String(data.path ?? ''))
    const action = String(data.action || '')
    if (!['target', 'none', 'inherit'].includes(action)) {
      json(res, { error: L(lang, 'Ismeretlen beállítás. Válaszd ki, hova mentsük a mappát, vagy azt, hogy ne mentsük.', 'Unknown setting. Choose where to back up the folder, or not to back it up.'), code: 'bad_action' }, 400)
      return true
    }
    // The folder must exist in the tree -- a rule on a typo would never apply.
    if (rel && !resolveLifePath(rel)) {
      json(res, { error: L(lang, `Ez a mappa nincs meg a Marveen mappájában: ${rel}`, `This folder is not in the Marveen folder: ${rel}`), code: 'no_dir' }, 404)
      return true
    }
    let input: Parameters<typeof setBackupRule>[0]
    if (action === 'target') {
      const kind = String(data.kind || '') as BackupKind
      const account = String(data.account || '')
      const known = backupAccounts().some((a) => a.kind === kind && a.account === account)
      if (!known) {
        json(res, {
          error: L(lang,
            'Ez a fiók nincs bekötve. A Drive-fiókot a Drive lapon, a MEGA-fiókot a Raktár lapon tudod felvenni.',
            'This account is not connected. Add a Drive account on the Drive page, a MEGA account on the Depot page.'),
          code: 'unknown_account',
        }, 400)
        return true
      }
      input = { path: rel, action: 'target', target: { kind, account } }
    } else {
      input = { path: rel, action: action as 'none' | 'inherit' }
    }
    try {
      const rules = setBackupRule(input)
      json(res, { ok: true, rules })
    } catch (e: any) {
      json(res, {
        error: L(lang,
          `A szabályt nem tudtam elmenteni: ${String(e?.message || e)}`,
          `Could not save the rule: ${String(e?.message || e)}`),
        code: 'save_failed',
      }, 500)
    }
    return true
  }

  return false
}
