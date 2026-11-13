// BACKGROUND GUARD FOR LINKED LIFE-TREE DOCUMENTS (#873, Boss TG 5367/5369/5373).
//
// A Life-tree file can be linked into projects in three ways: a project document (project_documents), a
// linked annex (wb_doc_annexes, path `doc:<id>`) and a linked FILE mount (life-mounts.json, left behind
// when a work item's file moved to the Life tree). The first two hold a stable document id and were only
// searched for LAZILY, when somebody opened the list; the mount held a path only.
//
// Boss's decisions:
//   - moved / renamed, also from the Windows Explorer: the link follows by itself when the content is
//     provably the same file (size + hash, relocateDocument: exactly one match, a copy is not "the" file);
//   - deleted from the Windows Explorer: nothing can ask BEFORE (the file system only reports afterwards),
//     so the owner is told AFTER -- a message on the channel and a window on the Windows desktop -- with
//     where the file was used; the link stays and shows "missing", it never vanishes silently.
//
// The sweep never moves, copies or deletes a file. It only updates the link records and tells the owner.
import { join } from 'node:path'
import { APP_LANG } from './config.js'
import { readMissingState, writeMissingState, type MissingEntry, type MissingState } from './linked-docs-missing-state.js'
import { getDb } from './db.js'
import { logger } from './logger.js'
import { documentById, documentIdFor, ensureDocumentId, ensureLifeDocTables, hashDocument, relocateDocument, verifyDocument } from './life-doc-ids.js'
import { listMounts, repointFileMount } from './life-mounts.js'
import { ensureProjectDocTables } from './workbench-doc-links.js'
import { LINKED_PREFIX, linkedAnnexRows } from './workbench-docannex.js'
import { notifyChannel } from './notify.js'
import { isWsl } from './web/scheduled-tasks-io.js'
import { runScriptViaTaskScheduler } from './windows-settings.js'
import { gatedInterval } from './background-gate.js'

export { readMissingState }

/** How many not-yet-hashed linked files one sweep hashes: a hash is what makes a later move recognisable. Pacing, not a limit. */
const HASH_PER_SWEEP = 3

interface Tracked {
  /** Stable key of the link: `doc:<id>` (project doc / annex) or `mount:<rel>` (linked file). */
  key: string
  docId: string | null
  /** Last known depot-relative place. */
  rel: string
  uses: string[]
  mountRel?: string
}

const T = {
  title: { hu: 'Belinkelt dokumentum nincs a helyén', en: 'A linked document is not at its place' },
  intro: {
    hu: 'Egy projektbe belinkelt dokumentum nincs ott, ahova a link mutat. Lehet, hogy átnevezték vagy máshová vitték (és nem találom egyértelműen), lehet, hogy törölték:',
    en: 'A document linked into a project is not where the link points. It may have been renamed or moved (and I cannot find it unambiguously), or it may have been deleted:',
  },
  usedIn: { hu: 'Itt használod:', en: 'Used in:' },
  restore: {
    hu: 'Ha a Windows Lomtárba ment, onnan visszaállítható; a link magától helyreáll, amint a fájl újra megvan.',
    en: 'If it went to the Windows Recycle Bin you can restore it from there; the link recovers by itself once the file is back.',
  },
} as const
const tr = (k: keyof typeof T): string => (APP_LANG === 'en' ? T[k].en : T[k].hu)

/** Every linked document the projects use, once per link. Reads the registries only, touches no file. */
export function collectTracked(): Tracked[] {
  ensureLifeDocTables()
  ensureProjectDocTables()
  const db = getDb()
  const out: Tracked[] = []
  const byDoc = new Map<string, Tracked>()
  const add = (docId: string, rel: string, use: string): void => {
    const key = `doc:${docId}`
    const have = byDoc.get(key)
    if (have) { if (use && !have.uses.includes(use)) have.uses.push(use); return }
    const t: Tracked = { key, docId, rel, uses: use ? [use] : [] }
    byDoc.set(key, t)
    out.push(t)
  }
  const pdocs = db.prepare(`SELECT d.document_id AS id, d.life_rel AS rel, d.role AS role, p.name AS project FROM project_documents d LEFT JOIN projects p ON p.id = d.project_id`).all() as Array<{ id: string; rel: string; role: string; project: string | null }>
  for (const d of pdocs) add(d.id, d.rel, `${d.project || '-'} (${d.role})`)
  for (const a of linkedAnnexRows()) {
    const id = a.path.slice(LINKED_PREFIX.length)
    const w = db.prepare(`SELECT w.title AS item, p.name AS project FROM work_items w LEFT JOIN projects p ON p.id = w.project_id WHERE w.id = ? AND w.deleted_at IS NULL`).get(a.work_item_id) as { item: string; project: string | null } | undefined
    if (!w) continue
    add(id, documentById(id)?.rel || (a as { life_rel?: string }).life_rel || '', `${w.project || '-'} / ${w.item}`)
  }
  for (const m of listMounts()) {
    if (!m.file) continue
    out.push({ key: `mount:${m.rel}`, docId: documentIdFor(m.target), rel: m.target, uses: [m.rel], mountRel: m.rel })
  }
  return out
}

export interface SweepResult { checked: number; followed: number; missing: number; newlyMissing: number; hashed: number }

export interface SweepDeps {
  notify: (e: MissingEntry[]) => Promise<void>
}

/** The text of one "missing" notice (channel message and desktop window share it). */
export function missingNoticeText(entries: MissingEntry[]): string {
  const lines = [tr('intro')]
  for (const e of entries.slice(0, 10)) {
    lines.push('', `• ${e.rel || '?'}`)
    if (e.uses.length) lines.push(`  ${tr('usedIn')} ${e.uses.slice(0, 5).join('; ')}`)
  }
  if (entries.length > 10) lines.push('', `... +${entries.length - 10}`)
  lines.push('', tr('restore'))
  return lines.join('\n')
}

function desktopScript(title: string, text: string): string {
  const q = (s: string): string => s.replace(/'/g, "''")
  return [
    '$ErrorActionPreference = "SilentlyContinue"',
    'Add-Type -AssemblyName System.Windows.Forms',
    `[System.Windows.Forms.MessageBox]::Show('${q(text).replace(/\r?\n/g, "' + [char]13 + [char]10 + '")}', '${q(title)}', 'OK', 'Warning') | Out-Null`,
  ].join('\r\n')
}

export const defaultDeps: SweepDeps = {
  async notify(entries) {
    const text = missingNoticeText(entries)
    const message = `${tr('title')}\n\n${text}`
    await notifyChannel(message).catch((err) => logger.warn({ err }, '[link-guard] channel notice failed'))
    if (isWsl() && process.env.MARVEEN_LINK_GUARD_DESKTOP !== '0') {
      await runScriptViaTaskScheduler('MarveenLinkedMissing', 'marveen-linked-missing', desktopScript(tr('title'), text))
        .catch((err) => logger.warn({ err }, '[link-guard] desktop notice failed'))
    }
  },
}

const RESEARCH_MS = 30 * 60_000
let running = false

/** One pass over every linked document. Safe to call at any time; a second call while one runs is skipped. */
export async function sweepLinkedDocs(deps: SweepDeps = defaultDeps): Promise<SweepResult> {
  const res: SweepResult = { checked: 0, followed: 0, missing: 0, newlyMissing: 0, hashed: 0 }
  if (running) return res
  running = true
  try {
    const state = readMissingState()
    const next: MissingState = {}
    const fresh: MissingEntry[] = []
    let budget = HASH_PER_SWEEP
    for (const t of collectTracked()) {
      res.checked++
      let docId = t.docId
      // A linked FILE mount never had an id: give it one while the file is still there.
      if (!docId && t.mountRel) docId = await ensureDocumentId(t.rel).catch(() => null)
      let place = t.rel
      let gone = false
      if (docId) {
        const v = await verifyDocument(docId)
        if (v && !v.missing) {
          place = v.doc.rel
          if (!v.doc.sha256 && budget > 0) { budget--; if (await hashDocument(docId)) res.hashed++ }
        } else if (v) {
          const known = state[t.key]
          // Already searched for and not found: not again on every sweep (a search walks the whole tree). Back at its old place is seen above, cheaply.
          const again = !known || (!known.ignored && Date.now() - (known.searchedAt ?? 0) > RESEARCH_MS)
          const to = again ? await relocateDocument(docId).catch(() => null) : null
          if (to) {
            res.followed++
            place = to
            logger.info({ key: t.key, from: t.rel, to }, '[link-guard] a linked document moved outside Marveen, the link follows')
          } else { gone = true; place = v.doc.rel }
        } else gone = true
      } else gone = true
      if (t.mountRel && !gone && place !== t.rel) repointFileMount(t.mountRel, place)
      if (!gone) continue
      res.missing++
      const entry: MissingEntry = state[t.key] ?? { rel: place || t.rel, uses: t.uses, since: new Date().toISOString() }
      entry.uses = t.uses
      if (!state[t.key] || (!entry.ignored && Date.now() - (entry.searchedAt ?? 0) > RESEARCH_MS)) entry.searchedAt = Date.now()
      next[t.key] = entry
      if (!state[t.key]) { res.newlyMissing++; fresh.push(entry) }
      else if (entry.ignored) res.missing--
    }
    writeMissingState(next)
    if (fresh.length) await deps.notify(fresh)
  } finally { running = false }
  return res
}

let timer: NodeJS.Timeout | undefined
let first: NodeJS.Timeout | undefined

/** Start the periodic guard (first pass after 90 s, then every 2 minutes). MARVEEN_LINK_GUARD=0 turns it off. */
export function startLinkedDocsGuard(): () => void {
  if (process.env.MARVEEN_LINK_GUARD === '0') return () => {}
  const run = (): void => { void sweepLinkedDocs().then((r) => { if (r.followed || r.newlyMissing) logger.info(r, '[link-guard] sweep') }).catch((err) => logger.warn({ err: String(err?.message || err) }, '[link-guard] sweep failed')) }
  first = setTimeout(run, 90_000)
  first.unref()
  timer = gatedInterval('linked-docs-guard', run, 2 * 60_000)
  timer.unref()
  return () => { if (first) clearTimeout(first); if (timer) clearInterval(timer) }
}
