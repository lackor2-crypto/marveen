/**
 * A RAJZVASZON es a FAJLOK talalkozasa (kanban #336, 9. fazis).
 *
 * A `workbench-graphic.ts` szandekosan nem nyul a lemezhez (igy tesztelheto es
 * igy nem tud kilepni a Raktarbol). Ez a modul koti ossze a kettot, EGY helyen:
 * a felulet vegpontjai ES az agent toolja ugyanezt hasznalja -- ket ut nem
 * csuszhat szet.
 *
 * Ket szabaly all minden sor folott:
 *
 *   1. A NULLA KET DOLGOT JELENTHET. A "meg nincs rajz" (friss munkadarab:
 *      ures vaszon, ez a HELYES kezdoallapot) es a "nem latok oda" (nincs
 *      Raktar, eltunt a fajl, olvashatatlan) KET KULON valasz, kulon koddal.
 *   2. A REGI SOSE VESZ EL. A verzio-mentes UJ verziot ir (`createWorkItemVersion`),
 *      es a fajl-iro (`writeProjectFile`) sem ir felul semmit: foglalt nevnel
 *      szabad nevet keres, es MEGMONDJA, hogy atnevezte.
 *
 * A v4 spec 8. fejezete (#441, K-2.1 .. K-2.3) ota a KET mentes kulon all:
 *
 *   - MUNKAPELDANY (automatikus mentes, K-2.2): minden kezi es agent-muvelet
 *     AZONNAL az adatbazisba ment, de NEM keszit verziot. Igy a verziolista nem
 *     telik meg szaz "elmozdult 10 pixellel" bejegyzessel.
 *   - VERZIO (K-2.3): csak jelentos pontnal -- kezi "Verzio mentese" nevvel,
 *     export elott, vagy amikor a verziok kozott mas uton lep a munkadarab.
 *
 * A munkapeldany mellett VISSZAVONASI NAPLO all (K-2.1): minden lepes egy
 * valtozas-folt (`workbench-canvas-history.ts`), mindket iranyba lejatszhato.
 * Az agent EGY kerese EGY lepes: a lepesek csoport-kulcsa a fordulo.
 *
 * A munkapeldany egy VERZIORA epul (`base_version_id`). Ha a munkadarab kozben
 * mas uton kap uj jelenlegi verziot (visszaallitas, feltoltes), a munkapeldany
 * nem torlodik es nem irodik ra vakon semmire: ARVA lesz, a felulet megmutatja,
 * es a tulajdonos donti el, verzio legyen-e belole, vagy eldobja.
 */
import { readFileSync, statSync } from 'node:fs'
import { getDb } from './db.js'
import { getProject, type ProjectRow } from './projects.js'
import { resolveLifePath } from './life-explorer.js'
import { fileKind } from './file-kind.js'
import { writeProjectFile } from './project-files.js'
import {
  getWorkItem, getWorkItemVersion, createWorkItemVersion, setWorkItemVersionLabel, VERSION_LABEL_MAX,
  type WorkItemRow, type WorkItemVersionRow,
} from './workbench.js'
import { buildPreview } from './workbench-preview.js'
import {
  emptyCanvas, parseCanvas, isCanvasFile, canvasFileName, renderCanvasSvg,
  CANVAS_EMBED_MAX_BYTES, type CanvasDoc, type ImageResolve,
} from './workbench-graphic.js'
import { canvasDiff, applyCanvasPatch, canvasChangeIsBig, stableJson, type CanvasPatch } from './workbench-canvas-history.js'

/** Ennel nagyobb vaszon-fajlt nem olvasunk be (a vaszon szoveges adat: ekkora
 *  mar nem rajz, hanem hiba). */
export const CANVAS_FILE_MAX_BYTES = 2 * 1024 * 1024

/** Ennyi visszavonhato lepest orzunk munkadarabonkent. A Photoshop alapbol 50-et,
 *  a Figma/Canva a munkamenetre korlatoz; 100 bovebb, es a foltok kicsik. */
export const CANVAS_HISTORY_MAX = 100

/** A munkapeldany allapota a feluletnek: MIKOR mentettuk, es tartalmaz-e
 *  olyat, ami meg nincs verzioban. */
export interface CanvasDraftInfo {
  rev: number
  updated_at: number
  /** `true`: a legutobbi verzio ota van mentett, de verzioba meg nem tett valtozas. */
  since_version: boolean
}

/** Egy arva munkapeldany: egy KORABBI verziora epult, es azota a munkadarab
 *  mas uton lepett tovabb. Nem veszett el, a tulajdonos donti el a sorsat. */
export interface CanvasOrphan {
  base_version_id: string
  base_version_no: number | null
  updated_at: number
  objects: number
}

export interface CanvasRead {
  ok: true
  doc: CanvasDoc
  /** Van-e mar MENTETT rajz. `false` = meg nincs (ures vaszon, nem hiba). */
  exists: boolean
  rel: string | null
  name: string | null
  version_id: string | null
  version_no: number | null
  /** A jelenlegi verziora epulo munkapeldany, ha van. Regi verzional mindig null. */
  draft: CanvasDraftInfo | null
}
export type CanvasReadResult = CanvasRead | { ok: false; code: string; detail: string | null }

/** A verzio-fajl tartalma a munkapeldany NELKUL -- ehhez merjuk, van-e mit
 *  verzioba tenni. Belso: a hivok a `readCanvas`-t hasznaljak. */
type CanvasReadFull = CanvasRead & { fileDoc: CanvasDoc }

// ---------------------------------------------------------------------------
// Munkapeldany + visszavonasi naplo: tablak
// ---------------------------------------------------------------------------

let tablesDb: unknown = null

/** A ket tabla. Mindkettonek van `work_item_id` oszlopa, igy a munkadarab
 *  vegleges torlese (`purgeWorkItem`) magatol viszi oket is. */
export function ensureCanvasDraftTables(): void {
  const db = getDb()
  if (tablesDb === db) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_item_canvas_drafts (
      work_item_id TEXT NOT NULL,
      base_version_id TEXT NOT NULL,
      doc TEXT NOT NULL,
      dirty INTEGER NOT NULL DEFAULT 0,
      rev INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL,
      updated_by TEXT,
      PRIMARY KEY (work_item_id, base_version_id)
    );
    CREATE TABLE IF NOT EXISTS work_item_canvas_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_item_id TEXT NOT NULL,
      draft_base TEXT NOT NULL,
      label TEXT NOT NULL,
      source TEXT NOT NULL,
      grp TEXT,
      patch TEXT NOT NULL,
      undone INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_canvas_steps_item ON work_item_canvas_steps(work_item_id, draft_base, id);
  `)
  tablesDb = db
}

interface DraftRow {
  work_item_id: string
  base_version_id: string
  doc: string
  dirty: number
  rev: number
  updated_at: number
  updated_by: string | null
}

interface StepRow {
  id: number
  work_item_id: string
  draft_base: string
  label: string
  source: string
  grp: string | null
  patch: string
  undone: number
  created_at: number
  updated_at: number
}

const nowSec = (): number => Math.floor(Date.now() / 1000)

function draftRow(itemId: string, base: string): DraftRow | undefined {
  ensureCanvasDraftTables()
  return getDb().prepare('SELECT * FROM work_item_canvas_drafts WHERE work_item_id = ? AND base_version_id = ?')
    .get(itemId, base) as DraftRow | undefined
}

/** A munkapeldany dokumentuma. Ha a sor olvashatatlan (kezzel belenyultak az
 *  adatbazisba), NEM kezdunk vakon ures vasznat helyette: hiba megy vissza. */
function draftDoc(row: DraftRow): { ok: true; doc: CanvasDoc } | { ok: false; code: string; detail: string } {
  const parsed = parseCanvas(row.doc)
  if (!parsed.ok) return { ok: false, code: 'canvas_draft_unreadable', detail: `${parsed.code}: ${parsed.detail}` }
  return { ok: true, doc: parsed.doc }
}

function draftInfo(row: DraftRow): CanvasDraftInfo {
  return { rev: row.rev, updated_at: row.updated_at, since_version: row.dirty === 1 }
}

// ---------------------------------------------------------------------------
// Olvasas
// ---------------------------------------------------------------------------

function readCanvasFull(itemId: string, wantedVersion?: unknown): CanvasReadFull | { ok: false; code: string; detail: string | null } {
  const item = getWorkItem(String(itemId || ''))
  if (!item) return { ok: false, code: 'not_found', detail: null }
  const p = buildPreview(item.id, wantedVersion)
  const base = { version_id: p.version_id, version_no: p.version_no }

  // Nincs (meg) vaszon-fajl: ez a KEZDOALLAPOT, nem hiba. A felulet ures
  // vasznat nyit, es a felhasznalo elkezdhet rajta dolgozni.
  if (!p.rel || !isCanvasFile(p.name || p.rel)) {
    const doc = emptyCanvas()
    return { ok: true, doc, fileDoc: doc, exists: false, rel: null, name: null, draft: null, ...base }
  }
  // VAN fajl-ut, de nem latunk oda. Ez MAS, mint a "meg nincs semmi": itt
  // hangosan kell szolni, mert a felhasznalo munkaja all valahol.
  if (p.reason === 'no_depot' || p.reason === 'no_folder' || p.reason === 'missing' || p.reason === 'unreachable') {
    return { ok: false, code: `canvas_${p.reason}`, detail: p.rel }
  }
  const abs = resolveLifePath(p.rel)
  if (!abs) return { ok: false, code: 'canvas_unreachable', detail: p.rel }
  let raw: string
  try {
    const st = statSync(abs)
    if (st.size > CANVAS_FILE_MAX_BYTES) {
      return { ok: false, code: 'canvas_too_large', detail: `${p.name}: ${st.size} bytes` }
    }
    raw = readFileSync(abs, 'utf-8')
  } catch (e) {
    // A hiba OKAT sosem talaljuk ki: az eredeti uzenet megy tovabb.
    return { ok: false, code: 'canvas_unreadable', detail: e instanceof Error ? e.message : String(e) }
  }
  const parsed = parseCanvas(raw)
  if (!parsed.ok) return { ok: false, code: parsed.code, detail: parsed.detail }
  // A JELENLEGI verzional a munkapeldany a mervado (ott all az automatikusan
  // mentett munka); egy regi verzio megnyitasa a verzio sajat fajljat mutatja.
  if (p.version_id && p.version_id === item.current_version_id) {
    const row = draftRow(item.id, p.version_id)
    if (row) {
      const d = draftDoc(row)
      if (!d.ok) return { ok: false, code: d.code, detail: d.detail }
      return { ok: true, doc: d.doc, fileDoc: parsed.doc, exists: true, rel: p.rel, name: p.name, draft: draftInfo(row), ...base }
    }
  }
  return { ok: true, doc: parsed.doc, fileDoc: parsed.doc, exists: true, rel: p.rel, name: p.name, draft: null, ...base }
}

/**
 * A munkadarab AKTUALIS (vagy a kert verziohoz tartozo) vaszna.
 *
 * A fajl megkeresese a MEGLEVO elonezet-uton megy (`buildPreview`), hogy a
 * Munkapadban EGY helyen dolgozzon el, melyik fajl tartozik egy verziohoz. A
 * jelenlegi verzional a munkapeldany tartalma jon (K-2.2).
 */
export function readCanvas(itemId: string, wantedVersion?: unknown): CanvasReadResult {
  const r = readCanvasFull(itemId, wantedVersion)
  if (!r.ok) return r
  const { fileDoc: _fileDoc, ...rest } = r
  return rest
}

// ---------------------------------------------------------------------------
// Verzio-mentes (fajl + uj verzio)
// ---------------------------------------------------------------------------

export interface CanvasSave {
  ok: true
  item: WorkItemRow
  version: WorkItemVersionRow
  rel: string
  name: string
  renamed: boolean
}
export type CanvasSaveResult = CanvasSave | { ok: false; code: string; detail: string | null }

/** A fajlnev "csaladja": a szabad-nev kereso altal hozzatett " (2)" nelkul
 *  (`rajz.canvas (2).json` -> `rajz.canvas.json`). Enelkul minden verzio-mentes
 *  egy ujabb tagot fuzne a nevhez ("rajz.canvas (2) (2).json"). */
export function canvasBaseName(name: unknown): string {
  return String(name ?? '').trim().replace(/\.canvas \(\d+\)\.json$/i, '.canvas.json')
}

/**
 * A vaszon kiirasa: fajl a PROJEKT mappajaba + UJ VERZIO.
 *
 * A fajlnev alapbol a munkadarab cimebol szuletik. Ha a nev foglalt, a
 * `writeProjectFile` szabad nevet ad -- ezt a hivo KIMONDJA a felhasznalonak,
 * nem cseréljuk ki csendben.
 */
export function saveCanvas(
  item: WorkItemRow,
  doc: CanvasDoc,
  opts: { prompt?: unknown; createdBy?: string | null; sub?: unknown; name?: unknown; metadata?: Record<string, unknown> | null } = {},
): CanvasSaveResult {
  const project = getProject(item.project_id)
  if (!project) return { ok: false, code: 'project_not_found', detail: null }
  const wanted = canvasBaseName(opts.name) || canvasFileName(item.title)
  const name = isCanvasFile(wanted) ? wanted : `${wanted.replace(/\.json$/i, '')}${'.canvas.json'}`
  const data = Buffer.from(JSON.stringify(doc, null, 2), 'utf-8')
  const out = writeProjectFile(project, opts.sub ?? null, name, data)
  if (!out.ok) return { ok: false, code: out.code, detail: out.message || null }
  const v = createWorkItemVersion(item.id, {
    source_path: out.rel,
    prompt: opts.prompt,
    created_by: opts.createdBy ?? null,
    metadata_json: opts.metadata ? JSON.stringify(opts.metadata) : undefined,
  })
  if (!v.ok) return { ok: false, code: v.code, detail: null }
  return { ok: true, item: v.item, version: v.version, rel: out.rel, name: out.name, renamed: out.renamed }
}

// ---------------------------------------------------------------------------
// Munkapeldany: valtoztatas, visszavonas, ujra
// ---------------------------------------------------------------------------

export type CanvasStepSource = 'owner' | 'agent'

/** A lepes cimkeje: a muveletek nevei, mindegyik egyszer ("move,scale"). Gepi
 *  szo, a felulet forditja le -- igy a naplo nyelvfuggetlen. */
export function canvasOpsLabel(ops: unknown): string {
  if (!Array.isArray(ops)) return 'edit'
  const names = ops
    .map((o) => (o && typeof o === 'object' ? String((o as Record<string, unknown>)['op'] ?? '') : ''))
    .filter((s) => /^[a-z_]{1,24}$/.test(s))
  return [...new Set(names)].slice(0, 6).join(',') || 'edit'
}

export interface CanvasHistoryState {
  can_undo: boolean
  can_redo: boolean
  /** A visszavonando / ujra elvegezheto lepes cimkeje (muveletnevek vesszovel)
   *  es forrasa -- a felulet forditja le ("Visszavonas: mozgatas"). */
  undo: { label: string; source: string } | null
  redo: { label: string; source: string } | null
}

/** A jelenlegi munkapeldany visszavonasi allapota. */
export function canvasHistory(itemId: string): CanvasHistoryState {
  ensureCanvasDraftTables()
  const item = getWorkItem(String(itemId || ''))
  const none: CanvasHistoryState = { can_undo: false, can_redo: false, undo: null, redo: null }
  if (!item || !item.current_version_id) return none
  const db = getDb()
  const u = db.prepare('SELECT label, source FROM work_item_canvas_steps WHERE work_item_id = ? AND draft_base = ? AND undone = 0 ORDER BY id DESC LIMIT 1')
    .get(item.id, item.current_version_id) as { label: string; source: string } | undefined
  const r = db.prepare('SELECT label, source FROM work_item_canvas_steps WHERE work_item_id = ? AND draft_base = ? AND undone = 1 ORDER BY id ASC LIMIT 1')
    .get(item.id, item.current_version_id) as { label: string; source: string } | undefined
  return { can_undo: !!u, can_redo: !!r, undo: u ?? null, redo: r ?? null }
}

/** Az arva munkapeldanyok (regebbi verziora epultek, es van bennuk verziozatlan
 *  munka). A tiszta arvak -- amik pontosan a verziojukat tartalmazzak -- nem
 *  arvak, csak maradekok: azokat itt csendben eltakaritjuk. */
export function canvasOrphans(itemId: string): CanvasOrphan[] {
  ensureCanvasDraftTables()
  const item = getWorkItem(String(itemId || ''))
  if (!item) return []
  const db = getDb()
  const cur = item.current_version_id || ''
  db.prepare('DELETE FROM work_item_canvas_drafts WHERE work_item_id = ? AND base_version_id <> ? AND dirty = 0').run(item.id, cur)
  const rows = db.prepare('SELECT * FROM work_item_canvas_drafts WHERE work_item_id = ? AND base_version_id <> ? ORDER BY updated_at DESC')
    .all(item.id, cur) as DraftRow[]
  return rows.map((row) => {
    const d = draftDoc(row)
    return {
      base_version_id: row.base_version_id,
      base_version_no: getWorkItemVersion(row.base_version_id)?.version_no ?? null,
      updated_at: row.updated_at,
      // Az olvashatatlan arva is megjelenik (-1 elem): a felulet megmutatja,
      // es a tulajdonos eldobhatja -- nem tunik el szo nelkul.
      objects: d.ok ? d.doc.objects.length : -1,
    }
  })
}

export interface CanvasCommit {
  ok: true
  doc: CanvasDoc
  /** `false`: a muvelet utan pontosan ugyanaz all a vasznon (nincs uj lepes). */
  changed: boolean
  draft: CanvasDraftInfo | null
  /** Csak az ELSO mentesnel: a vaszon ekkor jon letre fajlkent, verzioval. */
  created: CanvasSave | null
  /** Ha a valtozas NAGY volt, es elotte verziozatlan munka allt: az a verzio,
   *  ami a valtozas ELOTTI allapotot orzi (K-2.3). */
  versioned: WorkItemVersionRow | null
}
export type CanvasCommitResult = CanvasCommit | { ok: false; code: string; detail: string | null }

function writeDraft(item: WorkItemRow, base: string, doc: CanvasDoc, fileDoc: CanvasDoc, by: string | null): DraftRow {
  const db = getDb()
  const now = nowSec()
  const dirty = stableJson(doc) === stableJson(fileDoc) ? 0 : 1
  const had = draftRow(item.id, base)
  if (had) {
    db.prepare('UPDATE work_item_canvas_drafts SET doc = ?, dirty = ?, rev = rev + 1, updated_at = ?, updated_by = ? WHERE work_item_id = ? AND base_version_id = ?')
      .run(JSON.stringify(doc), dirty, now, by, item.id, base)
  } else {
    // UJ munkapeldany-vonal: a korabbi vonal lepesei mar egy MASIK allapotrol
    // szolnak (pl. visszaallitas utan), azok nem vonhatok vissza ertelmesen.
    db.prepare('DELETE FROM work_item_canvas_steps WHERE work_item_id = ? AND draft_base <> ?').run(item.id, base)
    db.prepare('INSERT INTO work_item_canvas_drafts (work_item_id, base_version_id, doc, dirty, rev, updated_at, updated_by) VALUES (?, ?, ?, ?, 1, ?, ?)')
      .run(item.id, base, JSON.stringify(doc), dirty, now, by)
  }
  // Az arva, de tiszta sorok eltakaritasa (lasd `canvasOrphans`).
  db.prepare('DELETE FROM work_item_canvas_drafts WHERE work_item_id = ? AND base_version_id <> ? AND dirty = 0').run(item.id, base)
  return draftRow(item.id, base) as DraftRow
}

function recordStep(item: WorkItemRow, base: string, before: CanvasDoc, after: CanvasDoc, patch: CanvasPatch,
  opts: { source: CanvasStepSource; grp: string | null; label: string }): void {
  const db = getDb()
  const now = nowSec()
  // Uj lepes utan az "ujra" ag elvesz -- ahogy minden szerkesztoben.
  db.prepare('DELETE FROM work_item_canvas_steps WHERE work_item_id = ? AND draft_base = ? AND undone = 1').run(item.id, base)
  const top = db.prepare('SELECT * FROM work_item_canvas_steps WHERE work_item_id = ? AND draft_base = ? ORDER BY id DESC LIMIT 1')
    .get(item.id, base) as StepRow | undefined
  // Ugyanaz a csoport (az agent egy kerese, vagy egy szerkeszto-urlap egy
  // megnyitasa): EGY lepes marad. Az osszevont folt a csoport ELEJETOL a mostani
  // allapotig szol.
  if (opts.grp && top && top.grp === opts.grp && top.source === opts.source) {
    let topPatch: CanvasPatch | null = null
    try { topPatch = JSON.parse(top.patch) as CanvasPatch } catch { topPatch = null }
    const start = topPatch ? applyCanvasPatch(before, topPatch, 'undo') : null
    if (start && start.ok) {
      const merged = canvasDiff(start.doc, after)
      if (!merged) {
        // A csoport visszaert a kiindulasba: nincs mit visszavonni.
        db.prepare('DELETE FROM work_item_canvas_steps WHERE id = ?').run(top.id)
        return
      }
      const labels = [...new Set([...top.label.split(','), ...opts.label.split(',')].filter(Boolean))].slice(0, 6).join(',')
      db.prepare('UPDATE work_item_canvas_steps SET patch = ?, label = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(merged), labels, now, top.id)
      return
    }
  }
  db.prepare('INSERT INTO work_item_canvas_steps (work_item_id, draft_base, label, source, grp, patch, undone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)')
    .run(item.id, base, opts.label || 'edit', opts.source, opts.grp, JSON.stringify(patch), now, now)
  db.prepare(`DELETE FROM work_item_canvas_steps WHERE work_item_id = ? AND draft_base = ? AND id NOT IN (
      SELECT id FROM work_item_canvas_steps WHERE work_item_id = ? AND draft_base = ? ORDER BY id DESC LIMIT ?)`)
    .run(item.id, base, item.id, base, CANVAS_HISTORY_MAX)
}

/**
 * Egy valtoztatas a munkapeldanyon (K-2.2): AZONNAL mentve, verzio NELKUL, es
 * egy visszavonhato lepes (K-2.1). Ugyanezt hivja a felulet es az agent.
 *
 * Ha meg nincs rajz-fajl, ez az elso mentes hozza letre (fajl + verzio): a
 * vaszon ekkor SZULETIK meg, ez jelentos pont.
 */
export function commitCanvasChange(
  item: WorkItemRow,
  doc: CanvasDoc,
  opts: {
    source?: CanvasStepSource; grp?: string | null; label?: string; actor?: string | null
    sub?: unknown; name?: unknown; prompt?: unknown
    /** K-2.3: NAGY valtozas elott a verziozatlan munka verzio lesz (az agent
     *  hasznalja). A csoport elso lepesenel egyszer, nem minden hivasnal. */
    versionBeforeBig?: boolean
  } = {},
): CanvasCommitResult {
  ensureCanvasDraftTables()
  const source: CanvasStepSource = opts.source === 'agent' ? 'agent' : 'owner'
  let cur = readCanvasFull(item.id)
  if (!cur.ok) return cur
  let versioned: WorkItemVersionRow | null = null
  if (opts.versionBeforeBig && cur.exists && cur.version_id && cur.draft?.since_version
    && !groupIsOpen(item.id, cur.version_id, opts.grp ?? null) && canvasChangeIsBig(cur.doc, doc)) {
    const v = saveCanvasVersion(item, { reason: 'before_agent', actor: opts.actor ?? null })
    if (!v.ok) return v
    versioned = v.created ? v.version : null
    cur = readCanvasFull(item.id)
    if (!cur.ok) return cur
    item = getWorkItem(item.id) || item
  }
  let created: CanvasSave | null = null
  let base = cur.version_id
  let fileDoc = cur.fileDoc
  let before = cur.doc
  if (!cur.exists || !base) {
    const saved = saveCanvas(item, doc, { createdBy: opts.actor ?? null, sub: opts.sub, name: opts.name, prompt: opts.prompt })
    if (!saved.ok) return saved
    created = saved
    base = saved.version.id
    fileDoc = doc
    // Az elso lepes az ures vaszonrol indul: az is visszavonhato.
    before = cur.doc
  }
  const patch = canvasDiff(before, doc)
  const fresh = getWorkItem(item.id) || item
  if (!patch && !created) return { ok: true, doc, changed: false, draft: cur.draft, created: null, versioned }
  const row = writeDraft(fresh, base, doc, fileDoc, opts.actor ?? null)
  if (patch) recordStep(fresh, base, before, doc, patch, { source, grp: opts.grp ?? null, label: opts.label || 'edit' })
  return { ok: true, doc, changed: !!patch, draft: draftInfo(row), created, versioned }
}

/** A csoport mar nyitva van-e (a legutobbi lepes az ove) -- az agent egy
 *  kerese kozben a masodik muvelet mar nem "egy nagy muvelet eleje". */
function groupIsOpen(itemId: string, base: string, grp: string | null): boolean {
  if (!grp) return false
  const top = getDb().prepare('SELECT grp, undone FROM work_item_canvas_steps WHERE work_item_id = ? AND draft_base = ? ORDER BY id DESC LIMIT 1')
    .get(itemId, base) as { grp: string | null; undone: number } | undefined
  return !!top && top.grp === grp && top.undone === 0
}

export type CanvasUndoResult =
  | { ok: true; doc: CanvasDoc; label: string; source: string; draft: CanvasDraftInfo }
  | { ok: false; code: string; detail: string | null }

function replay(item: WorkItemRow, dir: 'undo' | 'redo', actor: string | null): CanvasUndoResult {
  ensureCanvasDraftTables()
  const cur = readCanvasFull(item.id)
  if (!cur.ok) return cur
  const base = cur.version_id
  const empty = dir === 'undo' ? 'canvas_nothing_to_undo' : 'canvas_nothing_to_redo'
  if (!cur.exists || !base) return { ok: false, code: empty, detail: null }
  const db = getDb()
  const step = db.prepare(dir === 'undo'
    ? 'SELECT * FROM work_item_canvas_steps WHERE work_item_id = ? AND draft_base = ? AND undone = 0 ORDER BY id DESC LIMIT 1'
    : 'SELECT * FROM work_item_canvas_steps WHERE work_item_id = ? AND draft_base = ? AND undone = 1 ORDER BY id ASC LIMIT 1')
    .get(item.id, base) as StepRow | undefined
  if (!step) return { ok: false, code: empty, detail: null }
  let patch: CanvasPatch
  try { patch = JSON.parse(step.patch) as CanvasPatch } catch (e) {
    return { ok: false, code: 'canvas_undo_conflict', detail: e instanceof Error ? e.message : String(e) }
  }
  const r = applyCanvasPatch(cur.doc, patch, dir)
  if (!r.ok) return { ok: false, code: r.code, detail: r.detail }
  const row = writeDraft(item, base, r.doc, cur.fileDoc, actor)
  db.prepare('UPDATE work_item_canvas_steps SET undone = ?, updated_at = ? WHERE id = ?').run(dir === 'undo' ? 1 : 0, nowSec(), step.id)
  return { ok: true, doc: r.doc, label: step.label, source: step.source, draft: draftInfo(row) }
}

/** Visszavonas (Ctrl+Z): a legutobbi lepes -- akar kezi, akar az agent egesz kerese. */
export function undoCanvas(item: WorkItemRow, actor: string | null = null): CanvasUndoResult {
  return replay(item, 'undo', actor)
}

/** Ujra (Ctrl+Y): a legutobb visszavont lepes. */
export function redoCanvas(item: WorkItemRow, actor: string | null = null): CanvasUndoResult {
  return replay(item, 'redo', actor)
}

// ---------------------------------------------------------------------------
// Verzio a munkapeldanybol (K-2.3)
// ---------------------------------------------------------------------------

/** Miert keszul a verzio. A felulet forditja le a listaban. */
export type CanvasVersionReason = 'manual' | 'export' | 'finalize' | 'agent' | 'before_agent' | 'draft' | 'variant'
const REASONS: readonly string[] = ['manual', 'export', 'finalize', 'agent', 'before_agent', 'draft', 'variant']

export type CanvasVersionResult =
  | { ok: true; created: boolean; version: WorkItemVersionRow; item: WorkItemRow; save: CanvasSave | null }
  | { ok: false; code: string; detail: string | null }

/** A munkapeldany a verzio utan UGYANAZ marad, csak mar az uj verziora epul --
 *  a visszavonasi naplo is vele megy (a Figma is enged verzio-mentes utan
 *  visszavonni). */
function carryDraft(itemId: string, from: string, to: string): void {
  const db = getDb()
  db.transaction(() => {
    db.prepare('DELETE FROM work_item_canvas_drafts WHERE work_item_id = ? AND base_version_id = ?').run(itemId, to)
    db.prepare('UPDATE work_item_canvas_drafts SET base_version_id = ?, dirty = 0, updated_at = ? WHERE work_item_id = ? AND base_version_id = ?')
      .run(to, nowSec(), itemId, from)
    db.prepare('UPDATE work_item_canvas_steps SET draft_base = ? WHERE work_item_id = ? AND draft_base = ?').run(to, itemId, from)
  })()
}

/**
 * "Verzio mentese" (K-2.3). Ha a legutobbi verzio ota van mentett valtozas,
 * UJ verzio lesz belole (fajl + verzio, a neve es az oka a metaadatban). Ha
 * nincs, NEM gyartunk egy ugyanolyan masodikat: nev megadasakor a mostani
 * verziot nevezzuk el, kulonben megmondjuk, hogy nincs uj valtozas.
 */
export function saveCanvasVersion(
  item: WorkItemRow,
  opts: { label?: unknown; reason?: unknown; actor?: string | null; prompt?: unknown } = {},
): CanvasVersionResult {
  ensureCanvasDraftTables()
  const cur = readCanvasFull(item.id)
  if (!cur.ok) return cur
  if (!cur.exists || !cur.version_id) return { ok: false, code: 'canvas_nothing_to_version', detail: null }
  const label = String(opts.label ?? '').trim().slice(0, VERSION_LABEL_MAX)
  const reason = REASONS.includes(String(opts.reason)) ? String(opts.reason) : 'manual'
  if (!cur.draft || !cur.draft.since_version) {
    const current = getWorkItemVersion(cur.version_id)
    if (!current) return { ok: false, code: 'version_not_found', detail: null }
    if (!label) return { ok: true, created: false, version: current, item: getWorkItem(item.id) || item, save: null }
    const named = setWorkItemVersionLabel(current.id, label) || current
    return { ok: true, created: false, version: named, item: getWorkItem(item.id) || item, save: null }
  }
  const meta: Record<string, unknown> = { reason }
  if (label) meta['label'] = label
  const saved = saveCanvas(item, cur.doc, { createdBy: opts.actor ?? null, name: cur.name, prompt: opts.prompt, metadata: meta })
  if (!saved.ok) return saved
  carryDraft(item.id, cur.version_id, saved.version.id)
  return { ok: true, created: true, version: saved.version, item: saved.item, save: saved }
}

/** Ha a munkadarab vasznan verziozatlan munka all, verzio lesz belole; kulonben
 *  `null` (nincs teendo). A generikus "Mentes uj verziokent" ut hivja, hogy a
 *  rajz-munkadarabnal az uj verzio TENYLEG a latott rajzot tartalmazza. */
export function flushCanvasDraft(item: WorkItemRow, opts: { label?: unknown; reason?: unknown; actor?: string | null; prompt?: unknown } = {}): CanvasVersionResult | null {
  ensureCanvasDraftTables()
  if (!item.current_version_id) return null
  const row = draftRow(item.id, item.current_version_id)
  if (!row || row.dirty !== 1) return null
  return saveCanvasVersion(item, opts)
}

export type CanvasOrphanResult =
  | { ok: true; version: WorkItemVersionRow; item: WorkItemRow; save: CanvasSave }
  | { ok: false; code: string; detail: string | null }

/** Egy arva munkapeldanybol UJ verzio -- igy semmi nem vesz el. Ha a jelenlegi
 *  munkapeldanyban is volt verziozatlan munka, az sem vesz el: most az lesz arva. */
export function restoreCanvasOrphan(item: WorkItemRow, baseVersionId: string, actor: string | null = null): CanvasOrphanResult {
  ensureCanvasDraftTables()
  const base = String(baseVersionId || '')
  const row = draftRow(item.id, base)
  if (!row || base === item.current_version_id) return { ok: false, code: 'canvas_orphan_not_found', detail: null }
  const d = draftDoc(row)
  if (!d.ok) return { ok: false, code: d.code, detail: d.detail }
  const from = getWorkItemVersion(base)
  const cur = readCanvasFull(item.id)
  const saved = saveCanvas(item, d.doc, {
    createdBy: actor,
    name: cur.ok ? cur.name : null,
    metadata: { reason: 'draft', ...(from ? { restored_from: from.id, restored_from_no: from.version_no } : {}) },
  })
  if (!saved.ok) return saved
  getDb().prepare('DELETE FROM work_item_canvas_drafts WHERE work_item_id = ? AND base_version_id = ?').run(item.id, base)
  return { ok: true, version: saved.version, item: saved.item, save: saved }
}

/** Egy arva munkapeldany eldobasa. A felulet ELOTTE rakerdez: ez vegleges. */
export function discardCanvasOrphan(item: WorkItemRow, baseVersionId: string): boolean {
  ensureCanvasDraftTables()
  const base = String(baseVersionId || '')
  if (!base || base === item.current_version_id) return false
  return getDb().prepare('DELETE FROM work_item_canvas_drafts WHERE work_item_id = ? AND base_version_id = ?').run(item.id, base).changes > 0
}

/**
 * A vaszon kepeinek beolvasasa adat-URI-kent, hogy a kivitt SVG ONALLO legyen.
 *
 * Amit nem lehet bevinni, az NEM tunik el: a `note` megy a rajzra, hogy a
 * felhasznalo lassa, MELYIK kep hianyzik es MIERT.
 */
export function imageResolverFor(project: ProjectRow | null): (src: string) => ImageResolve {
  return (src: string): ImageResolve => {
    const raw = String(src || '').trim()
    if (!raw) return { ok: false, note: 'no file was given' }
    // Ket irast fogadunk el, ugyanugy, mint az elonezet: Raktar-relativ ut,
    // vagy a projekt mappajahoz kepest megadott nev.
    const candidates = [raw]
    if (project?.folder_path) candidates.push(`${project.folder_path}/${raw.replace(/^[./\\]+/, '')}`)
    for (const rel of candidates) {
      const abs = resolveLifePath(rel)
      if (!abs) continue
      let size = 0
      try { size = statSync(abs).size } catch { continue }
      if (size > CANVAS_EMBED_MAX_BYTES) {
        return { ok: false, note: `the picture is too large to embed (${Math.round(size / 1024 / 1024)} MB)` }
      }
      const k = fileKind(rel)
      if (k.kind !== 'image') return { ok: false, note: 'this file is not a picture' }
      try {
        const buf = readFileSync(abs)
        return { ok: true, dataUri: `data:${k.mime || 'image/png'};base64,${buf.toString('base64')}` }
      } catch (e) {
        return { ok: false, note: e instanceof Error ? e.message : String(e) }
      }
    }
    return { ok: false, note: 'the picture was not found in the Depot' }
  }
}

/** A vaszon KEPE egy munkadarabhoz -- elonezethez es letolteshez ugyanaz. */
export function renderCanvasForItem(item: WorkItemRow, doc: CanvasDoc): string {
  return renderCanvasSvg(doc, { resolveImage: imageResolverFor(getProject(item.project_id) || null) })
}
