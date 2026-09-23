/**
 * MUNKAPAD ELONEZET (kanban #336, 4. fazis).
 *
 * "Mit lat a felhasznalo a kozepso panelen?" -- ez a modul EZT az egy kerdest
 * valaszolja meg, es MINDIG megmondja, MIERT nem lat semmit, ha nem lat.
 *
 * A NULLA KET DOLGOT JELENTHET. Egy ures elonezet lehet:
 *   - "meg nincs mit mutatni" (uj, ures munkadarab)  -> baratsagos mondat, nem hiba
 *   - "nem latok oda" (nincs Raktar / nincs projektmappa / eltunt a fajl)
 *                                                    -> HANGOS, teendot mondo sor
 * Ezert a forrast KULON kerdezzuk meg (van-e Raktar, van-e mappa, ott van-e a
 * fajl), es sosem a talalatok szamabol kovetkeztetunk.
 *
 * Amit NEM csinal: nem alakit at semmit. A PDF-et a bongeszo maga jeleniti meg
 * (nincs uj csomag-fuggoseg, es friss telepitesen, halozat nelkul is mukodik);
 * a DOCX-fele atalakitas a 7. fazis, es addig SAJAT, emberi mondatot kap.
 */
import { statSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { resolveLifePath, explorerRoot } from './life-explorer.js'
import { getProject, type ProjectRow } from './projects.js'
import { fileKind, type PreviewKind } from './file-kind.js'
import {
  getWorkItem, listWorkItemVersions, listWorkItemParts,
  type WorkItemRow, type WorkItemVersionRow,
} from './workbench.js'

/** Szovegbol ennyi karaktert mutatunk (a tobbit a "nyisd meg" ut adja). */
export const PREVIEW_TEXT_MAX = 20_000
/** Ennel nagyobb fajlt nem agyazunk be -- ott a letoltes a jo valasz. */
export const PREVIEW_MAX_BYTES = 200 * 1024 * 1024

export type PreviewReason =
  | 'no_source' | 'no_depot' | 'no_folder' | 'missing' | 'unreachable'
  | 'unsupported' | 'too_large' | 'unreadable'

export interface PreviewResult {
  available: boolean
  /** 'parts' = a munkadarab sajat reszei (szoveg + kep) a tartalom. */
  kind: PreviewKind | 'parts' | null
  version_id: string | null
  version_no: number | null
  rel: string | null
  name: string | null
  mime: string | null
  size: number | null
  /** Szoveges elonezetnel a tartalom (levagva), kulonben null. */
  text: string | null
  truncated: boolean
  /** A bongeszo gyorsitotarahoz: verzio + modositas + meret. Valtozasra valtozik. */
  etag: string | null
  reason: PreviewReason | null
  /** Gepi kodbol emberi mondat -- a hivo (HTTP-reteg) forditja le. */
  detail: string | null
}

function empty(reason: PreviewReason, extra: Partial<PreviewResult> = {}): PreviewResult {
  return {
    available: false, kind: null, version_id: null, version_no: null, rel: null,
    name: null, mime: null, size: null, text: null, truncated: false, etag: null,
    reason, detail: null, ...extra,
  }
}

/** Melyik verzio elonezete? A kert, kulonben a jelenlegi, kulonben a legfrissebb. */
export function pickVersion(item: WorkItemRow, wanted?: unknown): WorkItemVersionRow | null {
  const versions = listWorkItemVersions(item.id)
  if (!versions.length) return null
  const id = String(wanted ?? '').trim()
  if (id) return versions.find((v) => v.id === id) || null
  if (item.current_version_id) {
    const cur = versions.find((v) => v.id === item.current_version_id)
    if (cur) return cur
  }
  return versions[0] || null
}

/** Letezik-e ez az ut a Raktarban? A feloldas MAGA nem valasz: a
 *  `resolveLifePath` a meg nem letezo utat is feloldja (az a kilepes-ellenorzes
 *  dolga, nem a letezese), ezert KULON meg kell kerdezni a lemezt. */
function existsRel(rel: string): boolean {
  const abs = resolveLifePath(rel)
  if (!abs) return false
  try { statSync(abs); return true } catch { return false }
}

/** A megmutatando fajl UTJA (Raktar-relativ), vagy `null`, ha nincs ilyen.
 *  Sorrend: a verzio elonezet-fajlja -> a munkadarab forrasfajlja. */
function sourceRel(item: WorkItemRow, version: WorkItemVersionRow | null, project: ProjectRow | null): string | null {
  const candidates = [version?.preview_path, item.source_path]
  for (const c of candidates) {
    const raw = String(c ?? '').trim()
    if (!raw) continue
    // Ket irast is elfogadunk: Raktar-relativ ut, vagy a PROJEKT mappajahoz
    // kepest megadott nev. Amelyik LETEZIK, az nyer -- talalgatas nelkul.
    const joined = project?.folder_path
      ? `${project.folder_path}/${raw.replace(/^[./\\]+/, '')}`
      : null
    if (existsRel(raw)) return raw
    if (joined && existsRel(joined)) return joined
    // Egyik sem all a lemezen. A projektmappas irast adjuk vissza, ha van:
    // a hivo igy a felhasznalo sajat mappajara mutatva mondja meg, MI hianyzik.
    return joined || raw
  }
  return null
}

export function buildPreview(itemId: string, wantedVersion?: unknown): PreviewResult {
  const item = getWorkItem(String(itemId || ''))
  if (!item) return empty('no_source')
  const project = getProject(item.project_id) || null
  const version = pickVersion(item, wantedVersion)
  const vIds = { version_id: version ? version.id : null, version_no: version ? version.version_no : null }

  const rel = sourceRel(item, version, project)
  if (!rel) {
    // Nincs FAJL. Ez nem feltetlenul ures: a vegyes munkadarab tartalma a sajat
    // reszeiben (szoveg + kep) all, azt a felulet maga rajzolja ki.
    // A KERT verzio pillanatkepe: egy regi verzio a sajat resz-sorait mutatja,
    // a jelenlegi az eloket. (5. fazis: minden verzionak sajat resz-sorai vannak.)
    const snapshot = version && version.id !== item.current_version_id ? version.id : null
    const parts = listWorkItemParts(item.id, snapshot)
    if (parts.length) {
      return { ...empty('no_source', vIds), available: true, kind: 'parts' }
    }
    return empty('no_source', vIds)
  }

  // A forrast KULON kerdezzuk meg: a "nem latok oda" nem ugyanaz, mint a "nincs".
  if (!explorerRoot()) return empty('no_depot', { ...vIds, rel, name: basename(rel) })
  const abs = resolveLifePath(rel)
  if (!abs) {
    // Feloldhatatlan ut. Ha a projektnek nincs is mappaja, AZ a teendo.
    if (project && !project.folder_path) return empty('no_folder', { ...vIds, rel, name: basename(rel) })
    return empty('unreachable', { ...vIds, rel, name: basename(rel) })
  }
  let st: ReturnType<typeof statSync>
  try { st = statSync(abs) } catch { return empty('missing', { ...vIds, rel, name: basename(rel) }) }
  if (st.isDirectory()) return empty('unsupported', { ...vIds, rel, name: basename(rel) })

  const name = basename(abs)
  const k = fileKind(name)
  const base = { ...vIds, rel, name, mime: k.mime, size: st.size }
  if (!k.previewable) return { ...empty('unsupported', base) }
  if (st.size > PREVIEW_MAX_BYTES) return { ...empty('too_large', base) }

  const etag = `${version ? version.id : item.id}-${Math.floor(st.mtimeMs)}-${st.size}`
  if (k.kind === 'text') {
    let text = ''
    try { text = readFileSync(abs, 'utf-8') } catch (e: any) {
      return { ...empty('unreadable', base), detail: e?.message ? String(e.message) : null }
    }
    const truncated = text.length > PREVIEW_TEXT_MAX
    return {
      available: true, kind: 'text', ...base, etag,
      text: truncated ? text.slice(0, PREVIEW_TEXT_MAX) : text,
      truncated, reason: null, detail: null,
    }
  }
  return {
    available: true, kind: k.kind, ...base, etag,
    text: null, truncated: false, reason: null, detail: null,
  }
}
