/**
 * MUNKAPELDANY + VISSZAVONAS + VERZIO -- a kozos motor (v4 spec K-2.1 .. K-2.3).
 *
 * A rajzvaszon (#441) epitette meg; az 5. fazis videos idovonala (#460)
 * PONTOSAN ugyanezt kivanja: azonnali automatikus mentes verzio nelkul,
 * visszavonhato lepesek (az agent egy kerese egy lepes), verzio csak jelentos
 * pontnal, es a mas uton tovabblepett munkadarab munkapeldanya ARVA lesz, nem
 * torlodik. Ket kulon masolat el tudna csuszni egymastol -- ezert a logika
 * EGY helyen all, es a fajta (`DraftKind`) csak azt mondja meg, hogyan kell a
 * dokumentumot olvasni, osszehasonlitani es visszajatszani.
 *
 * Ket szabaly all minden sor folott:
 *
 *   1. A NULLA KET DOLGOT JELENTHET. A "meg nincs dokumentum" (friss
 *      munkadarab: ures kezdoallapot, HELYES) es a "nem latok oda" (nincs
 *      Raktar, eltunt a fajl, olvashatatlan) KET KULON valasz, kulon koddal.
 *   2. A REGI SOSE VESZ EL. A verzio-mentes UJ verziot ir (`createWorkItemVersion`),
 *      es a fajl-iro (`writeProjectFile`) sem ir felul semmit: foglalt nevnel
 *      szabad nevet keres, es MEGMONDJA, hogy atnevezte.
 *
 * A munkapeldany egy VERZIORA epul (`base_version_id`). Ha a munkadarab kozben
 * mas uton kap uj jelenlegi verziot (visszaallitas, feltoltes), a munkapeldany
 * nem torlodik es nem irodik ra vakon semmire: ARVA lesz, a felulet megmutatja,
 * es a tulajdonos donti el, verzio legyen-e belole, vagy eldobja.
 *
 * Minden fajtanak SAJAT ket tablaja van (`work_item_<kulcs>_drafts` /
 * `_steps`), es mindkettonek `work_item_id` oszlopa -- igy a munkadarab vegleges
 * torlese (`purgeWorkItem`) magatol viszi oket is.
 */
import { readFileSync, statSync } from 'node:fs'
import { getDb } from './db.js'
import { getProject } from './projects.js'
import { resolveLifePath } from './life-explorer.js'
import { writeProjectFile } from './project-files.js'
import {
  getWorkItem, getWorkItemVersion, createWorkItemVersion, setWorkItemVersionLabel, VERSION_LABEL_MAX,
  type WorkItemRow, type WorkItemVersionRow,
} from './workbench.js'
import { buildPreview } from './workbench-preview.js'
import { stableJson } from './workbench-canvas-history.js'

/** Ennyi visszavonhato lepest orzunk munkadarabonkent. A Photoshop alapbol 50-et,
 *  a Figma/Canva a munkamenetre korlatoz; 100 bovebb, es a foltok kicsik. */
export const DRAFT_HISTORY_MAX = 100

/** Egy dokumentum-fajta: hogyan olvassuk, hasonlitjuk ossze es jatsszuk vissza. */
export interface DraftKind<D, P> {
  /** A hibakodok es a tablak elotagja: `canvas` -> `canvas_nothing_to_undo`,
   *  `work_item_canvas_drafts`. Csak kisbetu: SQL-be kerul. */
  key: string
  /** A fajl kanonikus kiterjesztese (`.canvas.json`). */
  ext: string
  /** Ennel nagyobb fajlt nem olvasunk be (szoveges adat: ekkora mar hiba). */
  maxBytes: number
  empty(): D
  parse(raw: unknown): { ok: true; doc: D } | { ok: false; code: string; detail: string }
  /** Ilyen fajta-e a fajl (a NEVE alapjan: a rossz tartalmu fajl is ez a fajta). */
  isFile(name: string): boolean
  /** A munkadarab cimebol alapertelmezett fajlnev. */
  fileName(title: unknown): string
  /** A fajlnev "csaladja": a szabad-nev kereso altal hozzatett " (2)" nelkul. */
  baseName(name: unknown): string
  diff(before: D, after: D): P | null
  apply(doc: D, patch: P, dir: 'undo' | 'redo'): { ok: true; doc: D } | { ok: false; code: string; detail: string }
  /** NAGY valtozas-e (K-2.3: verzio a nagy agent-muvelet ELOTT). */
  isBig(before: D, after: D): boolean
  /** Elemszam az arva-listahoz. */
  count(doc: D): number
}

/** A munkapeldany allapota a feluletnek: MIKOR mentettuk, es tartalmaz-e
 *  olyat, ami meg nincs verzioban. */
export interface DraftInfo {
  rev: number
  updated_at: number
  /** `true`: a legutobbi verzio ota van mentett, de verzioba meg nem tett valtozas. */
  since_version: boolean
}

/** Egy arva munkapeldany: egy KORABBI verziora epult, es azota a munkadarab
 *  mas uton lepett tovabb. Nem veszett el, a tulajdonos donti el a sorsat. */
export interface DraftOrphan {
  base_version_id: string
  base_version_no: number | null
  updated_at: number
  objects: number
}

export interface DraftRead<D> {
  ok: true
  doc: D
  /** Van-e mar MENTETT dokumentum. `false` = meg nincs (ures kezdoallapot, nem hiba). */
  exists: boolean
  rel: string | null
  name: string | null
  version_id: string | null
  version_no: number | null
  /** A jelenlegi verziora epulo munkapeldany, ha van. Regi verzional mindig null. */
  draft: DraftInfo | null
}
export type Fail = { ok: false; code: string; detail: string | null }
export type DraftReadResult<D> = DraftRead<D> | Fail

export interface DraftSave {
  ok: true
  item: WorkItemRow
  version: WorkItemVersionRow
  rel: string
  name: string
  renamed: boolean
}
export type DraftSaveResult = DraftSave | Fail

export type DraftStepSource = 'owner' | 'agent'

export interface DraftHistoryState {
  can_undo: boolean
  can_redo: boolean
  /** A visszavonando / ujra elvegezheto lepes cimkeje (muveletnevek vesszovel)
   *  es forrasa -- a felulet forditja le ("Visszavonas: mozgatas"). */
  undo: { label: string; source: string } | null
  redo: { label: string; source: string } | null
}

export interface DraftCommit<D> {
  ok: true
  doc: D
  /** `false`: a muvelet utan pontosan ugyanaz all (nincs uj lepes). */
  changed: boolean
  draft: DraftInfo | null
  /** Csak az ELSO mentesnel: a dokumentum ekkor jon letre fajlkent, verzioval. */
  created: DraftSave | null
  /** Ha a valtozas NAGY volt, es elotte verziozatlan munka allt: az a verzio,
   *  ami a valtozas ELOTTI allapotot orzi (K-2.3). */
  versioned: WorkItemVersionRow | null
}
export type DraftCommitResult<D> = DraftCommit<D> | Fail

export type DraftUndoResult<D> =
  | { ok: true; doc: D; label: string; source: string; draft: DraftInfo }
  | Fail

/** Miert keszul a verzio. A felulet forditja le a listaban. */
export type DraftVersionReason = 'manual' | 'export' | 'finalize' | 'agent' | 'before_agent' | 'draft' | 'variant'
const REASONS: readonly string[] = ['manual', 'export', 'finalize', 'agent', 'before_agent', 'draft', 'variant']

export type DraftVersionResult =
  | { ok: true; created: boolean; version: WorkItemVersionRow; item: WorkItemRow; save: DraftSave | null }
  | Fail

export type DraftOrphanResult =
  | { ok: true; version: WorkItemVersionRow; item: WorkItemRow; save: DraftSave }
  | Fail

/** A lepes cimkeje: a muveletek nevei, mindegyik egyszer ("move,scale"). Gepi
 *  szo, a felulet forditja le -- igy a naplo nyelvfuggetlen. */
export function opsLabel(ops: unknown): string {
  if (!Array.isArray(ops)) return 'edit'
  const names = ops
    .map((o) => (o && typeof o === 'object' ? String((o as Record<string, unknown>)['op'] ?? '') : ''))
    .filter((s) => /^[a-z_]{1,24}$/.test(s))
  return [...new Set(names)].slice(0, 6).join(',') || 'edit'
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

export interface DraftStore<D> {
  ensureTables(): void
  read(itemId: string, wantedVersion?: unknown): DraftReadResult<D>
  save(item: WorkItemRow, doc: D, opts?: { prompt?: unknown; createdBy?: string | null; sub?: unknown; name?: unknown; metadata?: Record<string, unknown> | null }): DraftSaveResult
  history(itemId: string): DraftHistoryState
  orphans(itemId: string): DraftOrphan[]
  commit(item: WorkItemRow, doc: D, opts?: {
    source?: DraftStepSource; grp?: string | null; label?: string; actor?: string | null
    sub?: unknown; name?: unknown; prompt?: unknown
    /** K-2.3: NAGY valtozas elott a verziozatlan munka verzio lesz (az agent
     *  hasznalja). A csoport elso lepesenel egyszer, nem minden hivasnal. */
    versionBeforeBig?: boolean
  }): DraftCommitResult<D>
  undo(item: WorkItemRow, actor?: string | null): DraftUndoResult<D>
  redo(item: WorkItemRow, actor?: string | null): DraftUndoResult<D>
  saveVersion(item: WorkItemRow, opts?: { label?: unknown; reason?: unknown; actor?: string | null; prompt?: unknown; metadata?: Record<string, unknown> | null }): DraftVersionResult
  /** Ha a munkadarabon verziozatlan munka all, verzio lesz belole; kulonben `null`. */
  flush(item: WorkItemRow, opts?: { label?: unknown; reason?: unknown; actor?: string | null; prompt?: unknown }): DraftVersionResult | null
  restoreOrphan(item: WorkItemRow, baseVersionId: string, actor?: string | null): DraftOrphanResult
  discardOrphan(item: WorkItemRow, baseVersionId: string): boolean
}

/** Egy dokumentum-fajta tarolasa. A `kind.key` fajtankent egyedi legyen. */
export function createDraftStore<D, P>(kind: DraftKind<D, P>): DraftStore<D> {
  if (!/^[a-z]{2,20}$/.test(kind.key)) throw new Error(`draft kind key must be lowercase letters: ${kind.key}`)
  const K = kind.key
  const T_DRAFTS = `work_item_${K}_drafts`
  const T_STEPS = `work_item_${K}_steps`
  let tablesDb: unknown = null

  type ReadFull = DraftRead<D> & { fileDoc: D }

  function ensureTables(): void {
    const db = getDb()
    if (tablesDb === db) return
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${T_DRAFTS} (
        work_item_id TEXT NOT NULL,
        base_version_id TEXT NOT NULL,
        doc TEXT NOT NULL,
        dirty INTEGER NOT NULL DEFAULT 0,
        rev INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL,
        updated_by TEXT,
        PRIMARY KEY (work_item_id, base_version_id)
      );
      CREATE TABLE IF NOT EXISTS ${T_STEPS} (
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
      CREATE INDEX IF NOT EXISTS idx_${K}_steps_item ON ${T_STEPS}(work_item_id, draft_base, id);
    `)
    tablesDb = db
  }

  function draftRow(itemId: string, base: string): DraftRow | undefined {
    ensureTables()
    return getDb().prepare(`SELECT * FROM ${T_DRAFTS} WHERE work_item_id = ? AND base_version_id = ?`)
      .get(itemId, base) as DraftRow | undefined
  }

  /** A munkapeldany dokumentuma. Ha a sor olvashatatlan (kezzel belenyultak az
   *  adatbazisba), NEM kezdunk vakon ures dokumentumot helyette: hiba megy vissza. */
  function draftDoc(row: DraftRow): { ok: true; doc: D } | { ok: false; code: string; detail: string } {
    const parsed = kind.parse(row.doc)
    if (!parsed.ok) return { ok: false, code: `${K}_draft_unreadable`, detail: `${parsed.code}: ${parsed.detail}` }
    return { ok: true, doc: parsed.doc }
  }

  function draftInfo(row: DraftRow): DraftInfo {
    return { rev: row.rev, updated_at: row.updated_at, since_version: row.dirty === 1 }
  }

  function readFull(itemId: string, wantedVersion?: unknown): ReadFull | Fail {
    const item = getWorkItem(String(itemId || ''))
    if (!item) return { ok: false, code: 'not_found', detail: null }
    const p = buildPreview(item.id, wantedVersion)
    const base = { version_id: p.version_id, version_no: p.version_no }

    // Nincs (meg) ilyen fajl: ez a KEZDOALLAPOT, nem hiba. A felulet ures
    // dokumentumot nyit, es a felhasznalo elkezdhet rajta dolgozni.
    if (!p.rel || !kind.isFile(p.name || p.rel)) {
      const doc = kind.empty()
      return { ok: true, doc, fileDoc: doc, exists: false, rel: null, name: null, draft: null, ...base }
    }
    // VAN fajl-ut, de nem latunk oda. Ez MAS, mint a "meg nincs semmi": itt
    // hangosan kell szolni, mert a felhasznalo munkaja all valahol.
    if (p.reason === 'no_depot' || p.reason === 'no_folder' || p.reason === 'missing' || p.reason === 'unreachable') {
      return { ok: false, code: `${K}_${p.reason}`, detail: p.rel }
    }
    const abs = resolveLifePath(p.rel)
    if (!abs) return { ok: false, code: `${K}_unreachable`, detail: p.rel }
    let raw: string
    try {
      const st = statSync(abs)
      if (st.size > kind.maxBytes) {
        return { ok: false, code: `${K}_too_large`, detail: `${p.name}: ${st.size} bytes` }
      }
      raw = readFileSync(abs, 'utf-8')
    } catch (e) {
      // A hiba OKAT sosem talaljuk ki: az eredeti uzenet megy tovabb.
      return { ok: false, code: `${K}_unreadable`, detail: e instanceof Error ? e.message : String(e) }
    }
    const parsed = kind.parse(raw)
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

  function read(itemId: string, wantedVersion?: unknown): DraftReadResult<D> {
    const r = readFull(itemId, wantedVersion)
    if (!r.ok) return r
    const { fileDoc: _fileDoc, ...rest } = r
    return rest
  }

  /**
   * A dokumentum kiirasa: fajl a PROJEKT mappajaba + UJ VERZIO.
   *
   * A fajlnev alapbol a munkadarab cimebol szuletik. Ha a nev foglalt, a
   * `writeProjectFile` szabad nevet ad -- ezt a hivo KIMONDJA a felhasznalonak,
   * nem cseréljuk ki csendben.
   */
  function save(
    item: WorkItemRow, doc: D,
    opts: { prompt?: unknown; createdBy?: string | null; sub?: unknown; name?: unknown; metadata?: Record<string, unknown> | null } = {},
  ): DraftSaveResult {
    const project = getProject(item.project_id)
    if (!project) return { ok: false, code: 'project_not_found', detail: null }
    const wanted = kind.baseName(opts.name) || kind.fileName(item.title)
    const name = kind.isFile(wanted) ? wanted : `${wanted.replace(/\.json$/i, '')}${kind.ext}`
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

  function history(itemId: string): DraftHistoryState {
    ensureTables()
    const item = getWorkItem(String(itemId || ''))
    const none: DraftHistoryState = { can_undo: false, can_redo: false, undo: null, redo: null }
    if (!item || !item.current_version_id) return none
    const db = getDb()
    const u = db.prepare(`SELECT label, source FROM ${T_STEPS} WHERE work_item_id = ? AND draft_base = ? AND undone = 0 ORDER BY id DESC LIMIT 1`)
      .get(item.id, item.current_version_id) as { label: string; source: string } | undefined
    const r = db.prepare(`SELECT label, source FROM ${T_STEPS} WHERE work_item_id = ? AND draft_base = ? AND undone = 1 ORDER BY id ASC LIMIT 1`)
      .get(item.id, item.current_version_id) as { label: string; source: string } | undefined
    return { can_undo: !!u, can_redo: !!r, undo: u ?? null, redo: r ?? null }
  }

  /** Az arva munkapeldanyok (regebbi verziora epultek, es van bennuk verziozatlan
   *  munka). A tiszta arvak -- amik pontosan a verziojukat tartalmazzak -- nem
   *  arvak, csak maradekok: azokat itt csendben eltakaritjuk. */
  function orphans(itemId: string): DraftOrphan[] {
    ensureTables()
    const item = getWorkItem(String(itemId || ''))
    if (!item) return []
    const db = getDb()
    const cur = item.current_version_id || ''
    db.prepare(`DELETE FROM ${T_DRAFTS} WHERE work_item_id = ? AND base_version_id <> ? AND dirty = 0`).run(item.id, cur)
    const rows = db.prepare(`SELECT * FROM ${T_DRAFTS} WHERE work_item_id = ? AND base_version_id <> ? ORDER BY updated_at DESC`)
      .all(item.id, cur) as DraftRow[]
    return rows.map((row) => {
      const d = draftDoc(row)
      return {
        base_version_id: row.base_version_id,
        base_version_no: getWorkItemVersion(row.base_version_id)?.version_no ?? null,
        updated_at: row.updated_at,
        // Az olvashatatlan arva is megjelenik (-1 elem): a felulet megmutatja,
        // es a tulajdonos eldobhatja -- nem tunik el szo nelkul.
        objects: d.ok ? kind.count(d.doc) : -1,
      }
    })
  }

  function writeDraft(item: WorkItemRow, base: string, doc: D, fileDoc: D, by: string | null): DraftRow {
    const db = getDb()
    const now = nowSec()
    const dirty = stableJson(doc) === stableJson(fileDoc) ? 0 : 1
    const had = draftRow(item.id, base)
    if (had) {
      db.prepare(`UPDATE ${T_DRAFTS} SET doc = ?, dirty = ?, rev = rev + 1, updated_at = ?, updated_by = ? WHERE work_item_id = ? AND base_version_id = ?`)
        .run(JSON.stringify(doc), dirty, now, by, item.id, base)
    } else {
      // UJ munkapeldany-vonal: a korabbi vonal lepesei mar egy MASIK allapotrol
      // szolnak (pl. visszaallitas utan), azok nem vonhatok vissza ertelmesen.
      db.prepare(`DELETE FROM ${T_STEPS} WHERE work_item_id = ? AND draft_base <> ?`).run(item.id, base)
      db.prepare(`INSERT INTO ${T_DRAFTS} (work_item_id, base_version_id, doc, dirty, rev, updated_at, updated_by) VALUES (?, ?, ?, ?, 1, ?, ?)`)
        .run(item.id, base, JSON.stringify(doc), dirty, now, by)
    }
    // Az arva, de tiszta sorok eltakaritasa (lasd `orphans`).
    db.prepare(`DELETE FROM ${T_DRAFTS} WHERE work_item_id = ? AND base_version_id <> ? AND dirty = 0`).run(item.id, base)
    return draftRow(item.id, base) as DraftRow
  }

  function recordStep(item: WorkItemRow, base: string, before: D, after: D, patch: P,
    opts: { source: DraftStepSource; grp: string | null; label: string }): void {
    const db = getDb()
    const now = nowSec()
    // Uj lepes utan az "ujra" ag elvesz -- ahogy minden szerkesztoben.
    db.prepare(`DELETE FROM ${T_STEPS} WHERE work_item_id = ? AND draft_base = ? AND undone = 1`).run(item.id, base)
    const top = db.prepare(`SELECT * FROM ${T_STEPS} WHERE work_item_id = ? AND draft_base = ? ORDER BY id DESC LIMIT 1`)
      .get(item.id, base) as StepRow | undefined
    // Ugyanaz a csoport (az agent egy kerese, vagy egy szerkeszto-urlap egy
    // megnyitasa): EGY lepes marad. Az osszevont folt a csoport ELEJETOL a mostani
    // allapotig szol.
    if (opts.grp && top && top.grp === opts.grp && top.source === opts.source) {
      let topPatch: P | null = null
      try { topPatch = JSON.parse(top.patch) as P } catch { topPatch = null }
      const start = topPatch ? kind.apply(before, topPatch, 'undo') : null
      if (start && start.ok) {
        const merged = kind.diff(start.doc, after)
        if (!merged) {
          // A csoport visszaert a kiindulasba: nincs mit visszavonni.
          db.prepare(`DELETE FROM ${T_STEPS} WHERE id = ?`).run(top.id)
          return
        }
        const labels = [...new Set([...top.label.split(','), ...opts.label.split(',')].filter(Boolean))].slice(0, 6).join(',')
        db.prepare(`UPDATE ${T_STEPS} SET patch = ?, label = ?, updated_at = ? WHERE id = ?`)
          .run(JSON.stringify(merged), labels, now, top.id)
        return
      }
    }
    db.prepare(`INSERT INTO ${T_STEPS} (work_item_id, draft_base, label, source, grp, patch, undone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`)
      .run(item.id, base, opts.label || 'edit', opts.source, opts.grp, JSON.stringify(patch), now, now)
    db.prepare(`DELETE FROM ${T_STEPS} WHERE work_item_id = ? AND draft_base = ? AND id NOT IN (
        SELECT id FROM ${T_STEPS} WHERE work_item_id = ? AND draft_base = ? ORDER BY id DESC LIMIT ?)`)
      .run(item.id, base, item.id, base, DRAFT_HISTORY_MAX)
  }

  /** A csoport mar nyitva van-e (a legutobbi lepes az ove) -- az agent egy
   *  kerese kozben a masodik muvelet mar nem "egy nagy muvelet eleje". */
  function groupIsOpen(itemId: string, base: string, grp: string | null): boolean {
    if (!grp) return false
    const top = getDb().prepare(`SELECT grp, undone FROM ${T_STEPS} WHERE work_item_id = ? AND draft_base = ? ORDER BY id DESC LIMIT 1`)
      .get(itemId, base) as { grp: string | null; undone: number } | undefined
    return !!top && top.grp === grp && top.undone === 0
  }

  /**
   * Egy valtoztatas a munkapeldanyon (K-2.2): AZONNAL mentve, verzio NELKUL, es
   * egy visszavonhato lepes (K-2.1). Ugyanezt hivja a felulet es az agent.
   *
   * Ha meg nincs fajl, ez az elso mentes hozza letre (fajl + verzio): a
   * dokumentum ekkor SZULETIK meg, ez jelentos pont.
   */
  function commit(item: WorkItemRow, doc: D, opts: Parameters<DraftStore<D>['commit']>[2] = {}): DraftCommitResult<D> {
    ensureTables()
    const source: DraftStepSource = opts.source === 'agent' ? 'agent' : 'owner'
    let cur = readFull(item.id)
    if (!cur.ok) return cur
    let versioned: WorkItemVersionRow | null = null
    if (opts.versionBeforeBig && cur.exists && cur.version_id && cur.draft?.since_version
      && !groupIsOpen(item.id, cur.version_id, opts.grp ?? null) && kind.isBig(cur.doc, doc)) {
      const v = saveVersion(item, { reason: 'before_agent', actor: opts.actor ?? null })
      if (!v.ok) return v
      versioned = v.created ? v.version : null
      cur = readFull(item.id)
      if (!cur.ok) return cur
      item = getWorkItem(item.id) || item
    }
    let created: DraftSave | null = null
    let base = cur.version_id
    let fileDoc = cur.fileDoc
    const before = cur.doc
    if (!cur.exists || !base) {
      const saved = save(item, doc, { createdBy: opts.actor ?? null, sub: opts.sub, name: opts.name, prompt: opts.prompt })
      if (!saved.ok) return saved
      created = saved
      base = saved.version.id
      fileDoc = doc
      // Az elso lepes az ures kezdoallapotrol indul: az is visszavonhato.
    }
    const patch = kind.diff(before, doc)
    const fresh = getWorkItem(item.id) || item
    if (!patch && !created) return { ok: true, doc, changed: false, draft: cur.draft, created: null, versioned }
    const row = writeDraft(fresh, base, doc, fileDoc, opts.actor ?? null)
    if (patch) recordStep(fresh, base, before, doc, patch, { source, grp: opts.grp ?? null, label: opts.label || 'edit' })
    return { ok: true, doc, changed: !!patch, draft: draftInfo(row), created, versioned }
  }

  function replay(item: WorkItemRow, dir: 'undo' | 'redo', actor: string | null): DraftUndoResult<D> {
    ensureTables()
    const cur = readFull(item.id)
    if (!cur.ok) return cur
    const base = cur.version_id
    const empty = dir === 'undo' ? `${K}_nothing_to_undo` : `${K}_nothing_to_redo`
    if (!cur.exists || !base) return { ok: false, code: empty, detail: null }
    const db = getDb()
    const step = db.prepare(dir === 'undo'
      ? `SELECT * FROM ${T_STEPS} WHERE work_item_id = ? AND draft_base = ? AND undone = 0 ORDER BY id DESC LIMIT 1`
      : `SELECT * FROM ${T_STEPS} WHERE work_item_id = ? AND draft_base = ? AND undone = 1 ORDER BY id ASC LIMIT 1`)
      .get(item.id, base) as StepRow | undefined
    if (!step) return { ok: false, code: empty, detail: null }
    let patch: P
    try { patch = JSON.parse(step.patch) as P } catch (e) {
      return { ok: false, code: `${K}_undo_conflict`, detail: e instanceof Error ? e.message : String(e) }
    }
    const r = kind.apply(cur.doc, patch, dir)
    if (!r.ok) return { ok: false, code: r.code, detail: r.detail }
    const row = writeDraft(item, base, r.doc, cur.fileDoc, actor)
    db.prepare(`UPDATE ${T_STEPS} SET undone = ?, updated_at = ? WHERE id = ?`).run(dir === 'undo' ? 1 : 0, nowSec(), step.id)
    return { ok: true, doc: r.doc, label: step.label, source: step.source, draft: draftInfo(row) }
  }

  /** A munkapeldany a verzio utan UGYANAZ marad, csak mar az uj verziora epul --
   *  a visszavonasi naplo is vele megy (a Figma is enged verzio-mentes utan
   *  visszavonni). */
  function carryDraft(itemId: string, from: string, to: string): void {
    const db = getDb()
    db.transaction(() => {
      db.prepare(`DELETE FROM ${T_DRAFTS} WHERE work_item_id = ? AND base_version_id = ?`).run(itemId, to)
      db.prepare(`UPDATE ${T_DRAFTS} SET base_version_id = ?, dirty = 0, updated_at = ? WHERE work_item_id = ? AND base_version_id = ?`)
        .run(to, nowSec(), itemId, from)
      db.prepare(`UPDATE ${T_STEPS} SET draft_base = ? WHERE work_item_id = ? AND draft_base = ?`).run(to, itemId, from)
    })()
  }

  /**
   * "Verzio mentese" (K-2.3). Ha a legutobbi verzio ota van mentett valtozas,
   * UJ verzio lesz belole (fajl + verzio, a neve es az oka a metaadatban). Ha
   * nincs, NEM gyartunk egy ugyanolyan masodikat: nev megadasakor a mostani
   * verziot nevezzuk el, kulonben megmondjuk, hogy nincs uj valtozas.
   */
  function saveVersion(
    item: WorkItemRow,
    opts: { label?: unknown; reason?: unknown; actor?: string | null; prompt?: unknown; metadata?: Record<string, unknown> | null } = {},
  ): DraftVersionResult {
    ensureTables()
    const cur = readFull(item.id)
    if (!cur.ok) return cur
    if (!cur.exists || !cur.version_id) return { ok: false, code: `${K}_nothing_to_version`, detail: null }
    const label = String(opts.label ?? '').trim().slice(0, VERSION_LABEL_MAX)
    const reason = REASONS.includes(String(opts.reason)) ? String(opts.reason) : 'manual'
    if (!cur.draft || !cur.draft.since_version) {
      const current = getWorkItemVersion(cur.version_id)
      if (!current) return { ok: false, code: 'version_not_found', detail: null }
      if (!label) return { ok: true, created: false, version: current, item: getWorkItem(item.id) || item, save: null }
      const named = setWorkItemVersionLabel(current.id, label) || current
      return { ok: true, created: false, version: named, item: getWorkItem(item.id) || item, save: null }
    }
    const meta: Record<string, unknown> = { ...(opts.metadata || {}), reason }
    if (label) meta['label'] = label
    const saved = save(item, cur.doc, { createdBy: opts.actor ?? null, name: cur.name, prompt: opts.prompt, metadata: meta })
    if (!saved.ok) return saved
    carryDraft(item.id, cur.version_id, saved.version.id)
    return { ok: true, created: true, version: saved.version, item: saved.item, save: saved }
  }

  function flush(item: WorkItemRow, opts: { label?: unknown; reason?: unknown; actor?: string | null; prompt?: unknown } = {}): DraftVersionResult | null {
    ensureTables()
    if (!item.current_version_id) return null
    const row = draftRow(item.id, item.current_version_id)
    if (!row || row.dirty !== 1) return null
    return saveVersion(item, opts)
  }

  /** Egy arva munkapeldanybol UJ verzio -- igy semmi nem vesz el. Ha a jelenlegi
   *  munkapeldanyban is volt verziozatlan munka, az sem vesz el: most az lesz arva. */
  function restoreOrphan(item: WorkItemRow, baseVersionId: string, actor: string | null = null): DraftOrphanResult {
    ensureTables()
    const base = String(baseVersionId || '')
    const row = draftRow(item.id, base)
    if (!row || base === item.current_version_id) return { ok: false, code: `${K}_orphan_not_found`, detail: null }
    const d = draftDoc(row)
    if (!d.ok) return { ok: false, code: d.code, detail: d.detail }
    const from = getWorkItemVersion(base)
    const cur = readFull(item.id)
    const saved = save(item, d.doc, {
      createdBy: actor,
      name: cur.ok ? cur.name : null,
      metadata: { reason: 'draft', ...(from ? { restored_from: from.id, restored_from_no: from.version_no } : {}) },
    })
    if (!saved.ok) return saved
    getDb().prepare(`DELETE FROM ${T_DRAFTS} WHERE work_item_id = ? AND base_version_id = ?`).run(item.id, base)
    return { ok: true, version: saved.version, item: saved.item, save: saved }
  }

  /** Egy arva munkapeldany eldobasa. A felulet ELOTTE rakerdez: ez vegleges. */
  function discardOrphan(item: WorkItemRow, baseVersionId: string): boolean {
    ensureTables()
    const base = String(baseVersionId || '')
    if (!base || base === item.current_version_id) return false
    return getDb().prepare(`DELETE FROM ${T_DRAFTS} WHERE work_item_id = ? AND base_version_id = ?`).run(item.id, base).changes > 0
  }

  return {
    ensureTables, read, save, history, orphans, commit,
    undo: (item, actor = null) => replay(item, 'undo', actor),
    redo: (item, actor = null) => replay(item, 'redo', actor),
    saveVersion, flush, restoreOrphan, discardOrphan,
  }
}
