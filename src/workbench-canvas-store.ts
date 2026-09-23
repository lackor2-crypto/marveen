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
 *   2. A REGI SOSE VESZ EL. Minden mentes UJ verziot ir (`createWorkItemVersion`),
 *      es a fajl-iro (`writeProjectFile`) sem ir felul semmit: foglalt nevnel
 *      szabad nevet keres, es MEGMONDJA, hogy atnevezte.
 */
import { readFileSync, statSync } from 'node:fs'
import { getProject, type ProjectRow } from './projects.js'
import { resolveLifePath } from './life-explorer.js'
import { fileKind } from './file-kind.js'
import { writeProjectFile } from './project-files.js'
import { getWorkItem, createWorkItemVersion, type WorkItemRow, type WorkItemVersionRow } from './workbench.js'
import { buildPreview } from './workbench-preview.js'
import {
  emptyCanvas, parseCanvas, isCanvasFile, canvasFileName, renderCanvasSvg,
  CANVAS_EMBED_MAX_BYTES, type CanvasDoc, type ImageResolve,
} from './workbench-graphic.js'

/** Ennel nagyobb vaszon-fajlt nem olvasunk be (a vaszon szoveges adat: ekkora
 *  mar nem rajz, hanem hiba). */
export const CANVAS_FILE_MAX_BYTES = 2 * 1024 * 1024

export interface CanvasRead {
  ok: true
  doc: CanvasDoc
  /** Van-e mar MENTETT rajz. `false` = meg nincs (ures vaszon, nem hiba). */
  exists: boolean
  rel: string | null
  name: string | null
  version_id: string | null
  version_no: number | null
}
export type CanvasReadResult = CanvasRead | { ok: false; code: string; detail: string | null }

/**
 * A munkadarab AKTUALIS (vagy a kert verziohoz tartozo) vaszna.
 *
 * A fajl megkeresese a MEGLEVO elonezet-uton megy (`buildPreview`), hogy a
 * Munkapadban EGY helyen dolgozzon el, melyik fajl tartozik egy verziohoz.
 */
export function readCanvas(itemId: string, wantedVersion?: unknown): CanvasReadResult {
  const item = getWorkItem(String(itemId || ''))
  if (!item) return { ok: false, code: 'not_found', detail: null }
  const p = buildPreview(item.id, wantedVersion)
  const base = { version_id: p.version_id, version_no: p.version_no }

  // Nincs (meg) vaszon-fajl: ez a KEZDOALLAPOT, nem hiba. A felulet ures
  // vasznat nyit, es a felhasznalo elkezdhet rajta dolgozni.
  if (!p.rel || !isCanvasFile(p.name || p.rel)) {
    return { ok: true, doc: emptyCanvas(), exists: false, rel: null, name: null, ...base }
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
  return { ok: true, doc: parsed.doc, exists: true, rel: p.rel, name: p.name, ...base }
}

export interface CanvasSave {
  ok: true
  item: WorkItemRow
  version: WorkItemVersionRow
  rel: string
  name: string
  renamed: boolean
}
export type CanvasSaveResult = CanvasSave | { ok: false; code: string; detail: string | null }

/**
 * A vaszon mentese: fajl a PROJEKT mappajaba + UJ VERZIO.
 *
 * A fajlnev alapbol a munkadarab cimebol szuletik. Ha a nev foglalt, a
 * `writeProjectFile` szabad nevet ad -- ezt a hivo KIMONDJA a felhasznalonak,
 * nem cseréljuk ki csendben.
 */
export function saveCanvas(
  item: WorkItemRow,
  doc: CanvasDoc,
  opts: { prompt?: unknown; createdBy?: string | null; sub?: unknown; name?: unknown } = {},
): CanvasSaveResult {
  const project = getProject(item.project_id)
  if (!project) return { ok: false, code: 'project_not_found', detail: null }
  const wanted = String(opts.name ?? '').trim() || canvasFileName(item.title)
  const name = isCanvasFile(wanted) ? wanted : `${wanted.replace(/\.json$/i, '')}${'.canvas.json'}`
  const data = Buffer.from(JSON.stringify(doc, null, 2), 'utf-8')
  const out = writeProjectFile(project, opts.sub ?? null, name, data)
  if (!out.ok) return { ok: false, code: out.code, detail: out.message || null }
  const v = createWorkItemVersion(item.id, {
    source_path: out.rel,
    prompt: opts.prompt,
    created_by: opts.createdBy ?? null,
  })
  if (!v.ok) return { ok: false, code: v.code, detail: null }
  return { ok: true, item: v.item, version: v.version, rel: out.rel, name: out.name, renamed: out.renamed }
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
