// Backup rules API (card #350): one rule per folder, shown in the Intezo.
//
//   GET  /api/backup-rules        -- every rule + the accounts a rule can point to
//   POST /api/backup-rules/set    -- {path, action: 'target'|'none'|'inherit', kind?, account?}
//   POST /api/backup-rules/exclude -- {path, exclude}: what this folder's backup leaves out
//   POST /api/backup-rules/mega/preview -- {path}: what an upload WOULD do (uploads nothing)
//   POST /api/backup-rules/mega/run     -- {path}: upload exactly the last preview's list
//   POST /api/backup-rules/mega/mirror/preview -- {account}: Raktar/Tarolok/MEGA/<account> -> account root (#360)
//   POST /api/backup-rules/mega/mirror/run     -- {account}: upload exactly that preview's list
//   GET  /api/backup-rules/mega/status  -- the running / last upload
//   GET  /api/backup-rules/mega/deletes -- files gone from the machine, waiting for yes/no
//   POST /api/backup-rules/mega/deletes/decide -- {id, yes}
//
// Setting a rule NEVER uploads anything (Boss, 2026-09-24: "de még ne töltsd
// fel semmit"). It only records where a folder SHOULD go.
import { json, readBody, reqLang, L } from '../http-helpers.js'
import { loadBackupRules, setBackupRule, setBackupExclude, normRulePath, childExclusions, type BackupKind, type BackupRule } from '../../backup-rules.js'
import { loadDriveQuotas } from '../../drive-quota.js'
import { readMegaAccounts, readMegaQuota, measureMegaQuota, rcloneBin, defaultRunner } from '../../mega.js'
import { excludeRules, normalizeExcludes } from '../../backup-exclude.js'
import {
  walkForMega, loadMegaState, listMegaRemote, megaRemoteDir, planMegaBackup, runMegaUpload, MEGA_MIRROR, MEGA_BACKUP_DIR,
  forgetMegaFiles, syncMegaDeleteQueue, loadMegaDeleteQueue, decideMegaDelete, longRunner,
  type LocalFile,
} from '../../mega-backup.js'
import { logger } from '../../logger.js'
import { loadSyncConfig } from './drive-sync.js'
import { resolveLifePath } from '../../life-explorer.js'
import { depotAccountDir, DEPOT_MEGA } from '../../depot.js'
import { mkdirSync } from 'node:fs'
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

// ---- MEGA upload (card #350) --------------------------------------------

/** The last preview per rule: the run uploads exactly this list, nothing else. */
const previews = new Map<string, { at: number; account: string; base: string; files: LocalFile[] }>()
const PREVIEW_TTL_MS = 15 * 60_000

interface MegaJob {
  path: string; account: string; running: boolean
  startedAt: string; finishedAt: string | null
  total: number; uploaded: number; failed: number; error: string | null
}
/** One upload at a time: a free MEGA account has a per-IP transfer quota. */
let megaJob: MegaJob | null = null

function megaRuleFor(path: string): { rule: BackupRule | null; rules: BackupRule[]; broken: string | null } {
  const { rules, broken } = loadBackupRules()
  return { rule: rules.find((r) => r.path === path) ?? null, rules, broken }
}

function megaErrorText(lang: 'hu' | 'en', code: string, raw = ''): string {
  const tail = raw ? ` (${raw})` : ''
  switch (code) {
    case 'no_rule': return L(lang, 'Ennek a mappának nincs saját MEGA-mentési szabálya. Jobb klikk a mappán → Mentés beállítása…, és válassz egy MEGA-fiókot.', 'This folder has no MEGA backup rule of its own. Right-click the folder → Backup setting…, and pick a MEGA account.')
    case 'no_account': return L(lang, 'A szabályban megadott MEGA-fiók már nincs bekötve. A Raktár lapon veheted fel újra.', 'The MEGA account in the rule is not connected any more. Add it again on the Depot page.')
    case 'rclone_missing': return L(lang, 'A MEGA-hoz szükséges rclone program nincs telepítve ezen a gépen. A Fiókok lapon, a MEGA-fiók hozzáadásánál az „rclone telepítése most” gomb egy kattintással felteszi.', 'The rclone program MEGA needs is not installed on this machine. On the Accounts page, under adding a MEGA account, the “Install rclone now” button installs it in one click.')
    case 'no_dir': return L(lang, 'A mentendő mappa most nem érhető el a gépen (lecsatolt lemez?). Amíg nem látom, semmit nem töltök fel és semmit nem jelölök töröltnek.', 'The folder to back up is not reachable right now (disconnected disk?). Until it is, nothing is uploaded and nothing is marked deleted.')
    case 'state_broken': return L(lang, `A mentés nyilvántartása nem olvasható, ezért most nem töltök fel (különben a MEGA-n törölt fájlokat is újra feltölteném)${tail}.`, `The backup record cannot be read, so nothing is uploaded now (otherwise files deleted on MEGA would be uploaded again)${tail}.`)
    case 'remote_failed': return L(lang, `Nem tudtam megnézni, mi van már fent a MEGA-n${tail}.`, `Could not check what is already on MEGA${tail}.`)
    case 'no_preview': return L(lang, 'Előbb nézd meg az előnézetet: a feltöltés pontosan azt viszi fel, amit ott láttál.', 'Look at the preview first: the upload takes exactly what you saw there.')
    case 'no_depot': return L(lang, 'Még nincs beállítva a Raktár mappa, ezért nincs hova tenni a MEGA-fiók fájljait. A Raktár lapon állíthatod be.', 'The Depot folder is not set up yet, so there is no place for the MEGA account files. Set it up on the Depot page.')
    case 'busy': return L(lang, 'Már fut egy MEGA-feltöltés. Megvárom, amíg véget ér.', 'A MEGA upload is already running. Wait until it ends.')
    case 'not_found': return L(lang, 'Ez a tétel már nincs a listában.', 'This item is not in the list any more.')
    default: return L(lang, `A MEGA hibát jelzett${tail}.`, `MEGA reported an error${tail}.`)
  }
}

async function readJson(ctx: RouteContext): Promise<any> {
  try { return JSON.parse((await readBody(ctx.req)).toString('utf-8') || '{}') } catch { return {} }
}

async function handleMega(ctx: RouteContext, lang: 'hu' | 'en'): Promise<boolean> {
  const { res, path, method } = ctx
  const fail = (code: string, status: number, raw = '') => { json(res, { error: megaErrorText(lang, code, raw), code }, status); return true }

  if (path === '/api/backup-rules/mega/status' && method === 'GET') {
    json(res, { job: megaJob })
    return true
  }

  if (path === '/api/backup-rules/mega/deletes' && method === 'GET') {
    const { items, broken } = loadMegaDeleteQueue()
    json(res, { items, ...(broken ? { error: megaErrorText(lang, 'state_broken', broken), code: 'queue_broken' } : {}) })
    return true
  }

  if (path === '/api/backup-rules/mega/deletes/decide' && method === 'POST') {
    const data = await readJson(ctx)
    const accounts = readMegaAccounts()
    const r = await decideMegaDelete({
      id: String(data.id || ''), yes: data.yes === true, bin: rcloneBin(),
      remoteOf: (a) => accounts.find((x) => x.name === a)?.remote ?? null, run: defaultRunner,
    })
    if (!r.ok) return fail(['not_found', 'no_account', 'rclone_missing'].includes(r.error) ? r.error : 'remote_failed', r.error === 'not_found' ? 404 : 502, r.error)
    json(res, { ok: true })
    return true
  }

  const isPreview = path === '/api/backup-rules/mega/preview' || path === '/api/backup-rules/mega/mirror/preview'
  const isRun = path === '/api/backup-rules/mega/run' || path === '/api/backup-rules/mega/mirror/run'
  if ((isPreview || isRun) && method === 'POST') {
    const data = await readJson(ctx)
    const mirror = path.startsWith('/api/backup-rules/mega/mirror/')
    // What goes where. A rule: the rule's folder -> Marveen-backup/<path>.
    // The mirror (card #360): Raktar/Tarolok/MEGA/<account> -> the account ROOT.
    let key: string
    let accountName: string
    let rule: BackupRule | null = null
    let rules: BackupRule[] = []
    if (mirror) {
      key = MEGA_MIRROR
      accountName = String(data.account ?? '')
    } else {
      key = normRulePath(String(data.path ?? ''))
      const found = megaRuleFor(key)
      if (found.broken) return fail('state_broken', 500, found.broken)
      rule = found.rule
      rules = found.rules
      if (!rule || !rule.target || rule.target.kind !== 'mega') return fail('no_rule', 400)
      accountName = rule.target.account
    }
    const account = readMegaAccounts().find((a) => a.name === accountName)
    if (!account) return fail('no_account', 400)
    const bin = rcloneBin()
    if (!bin) return fail('rclone_missing', 400)
    const pvKey = `${account.name}\u0000${key}`

    if (isRun) {
      if (megaJob?.running) return fail('busy', 409)
      const pv = previews.get(pvKey)
      if (!pv || pv.account !== account.name || Date.now() - pv.at > PREVIEW_TTL_MS) return fail('no_preview', 409)
      previews.delete(pvKey)
      megaJob = { path: key, account: account.name, running: true, startedAt: new Date().toISOString(), finishedAt: null, total: pv.files.length, uploaded: 0, failed: 0, error: null }
      const job = megaJob
      void runMegaUpload({ bin, remote: account.remote, account: account.name, path: key, base: pv.base, files: pv.files, run: longRunner })
        .then((r) => { job.uploaded = r.uploaded; job.failed = r.failed.length; job.error = r.error })
        .catch((e) => { job.error = String(e?.message || e); job.failed = job.total })
        .finally(() => {
          job.running = false
          job.finishedAt = new Date().toISOString()
          logger.info({ path: key, account: job.account, uploaded: job.uploaded, failed: job.failed }, '[mega-backup] upload finished')
          void measureMegaQuota(account.name).catch(() => undefined)
        })
      json(res, { ok: true, job })
      return true
    }

    // --- preview: uploads nothing ---
    let base: string | null
    if (mirror) {
      // No depot yet (fresh install) is its own sentence, not "disk missing".
      base = depotAccountDir(account.name, DEPOT_MEGA)
      if (!base) return fail('no_depot', 400)
      // The account's folder is part of the design: create it empty, so the
      // Intezo shows where to put files. Creating an empty folder uploads nothing.
      try { mkdirSync(base, { recursive: true }) } catch { return fail('no_dir', 404) }
    } else {
      base = resolveLifePath(key)
      if (!base) return fail('no_dir', 404)
    }
    const loaded = loadMegaState(account.name, key)
    if (loaded.broken) return fail('state_broken', 500, loaded.broken)
    // The mirror leaves out a local Marveen-backup folder: on MEGA that name
    // belongs to the backup rules of the same account.
    const ex = mirror
      ? excludeRules([MEGA_BACKUP_DIR])
      : excludeRules([...(rule!.exclude || []), ...childExclusions(rules, key)])
    const walk = walkForMega(base, ex)
    if (walk.unreachable) return fail('no_dir', 404)
    const remote = await listMegaRemote(bin, megaRemoteDir(account.remote, key), defaultRunner)
    if (!remote.ok) return fail('remote_failed', 502, remote.error)
    const plan = planMegaBackup(walk, loaded.state, remote.files, ex, { keepRemoteUntracked: mirror })
    forgetMegaFiles(account.name, key, plan.forget)
    // Brakes 2 and 3: from a truncated walk or a mass disappearance the queue
    // is not touched at all -- a disconnected disk must not flood it.
    let queued: number | null = null
    if (!plan.truncated && !plan.brake) queued = syncMegaDeleteQueue(account.name, key, plan.wouldDelete)
    const quota = await measureMegaQuota(account.name).catch(() => null)
    const free = quota && typeof quota.free === 'number' ? quota.free : null
    previews.set(pvKey, { at: Date.now(), account: account.name, base, files: plan.upload })
    json(res, {
      key,
      account: account.name,
      files: plan.upload.length,
      bytes: plan.uploadBytes,
      remoteDeleted: plan.remoteDeleted.length,
      remoteUntracked: plan.remoteUntracked.length,
      wouldDelete: plan.wouldDelete.length,
      queued,
      brake: plan.brake,
      tracked: plan.tracked,
      truncated: plan.truncated,
      free,
      fits: free === null ? null : plan.uploadBytes <= free,
      quotaError: quota?.error || null,
      exclude: rule?.exclude || [],
      children: mirror ? [] : childExclusions(rules, key),
      localEmpty: walk.files.length === 0,
    })
    return true
  }
  return false
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

  if (path.startsWith('/api/backup-rules/mega/')) return handleMega(ctx, lang)

  if (path === '/api/backup-rules/exclude' && method === 'POST') {
    const data = await readJson(ctx)
    const { list, invalid } = normalizeExcludes(data.exclude)
    if (invalid.length) {
      json(res, {
        error: L(lang,
          `Ezeket a sorokat nem értem: ${invalid.join(', ')}. Egy sor vagy egy almappa (például Projektek/Régi), vagy egy fájltípus (például *.fxt).`,
          `These lines are not understood: ${invalid.join(', ')}. A line is either a sub-folder (for example Projects/Old) or a file type (for example *.fxt).`),
        code: 'bad_exclude', invalid,
      }, 400)
      return true
    }
    try {
      json(res, { ok: true, rules: setBackupExclude(String(data.path ?? ''), list) })
    } catch (e: any) {
      const noRule = String(e?.message || e) === 'no_own_target'
      json(res, {
        error: noRule
          ? L(lang, 'Kihagyást csak olyan mappánál lehet megadni, amelynek saját mentési célja van.', 'Exclusions can only be set on a folder that has its own backup target.')
          : L(lang, `A kihagyásokat nem tudtam elmenteni: ${String(e?.message || e)}`, `Could not save the exclusions: ${String(e?.message || e)}`),
        code: noRule ? 'no_rule' : 'save_failed',
      }, noRule ? 400 : 500)
    }
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
