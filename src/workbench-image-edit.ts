/**
 * MUNKAPAD: KEPSZERKESZTES EGERREL (kanban #406, 16. pont).
 *
 * "Vagas, atmeretezes, felirat, hatter eltavolitasa -- huzogatva, nem csak
 * keressel." A szerkesztes a BONGESZOBEN tortenik (canvas: vagokeret huzasa,
 * forgatas, meret, felirat, egyszinu hatter kivetele), igy nem kell hozza a
 * gepre semmilyen kepszerkeszto program -- friss telepitesen, telefonon is
 * megy. A szerver dolga csak a MENTES: a kesz kep UJ fajlba kerul a regi melle
 * (ugyanabba a mappaba), es UJ verzio mutat ra. A regi kep erintetlen, egy
 * kattintassal visszaallithato.
 *
 * Amit a szerver ellenoriz: a keres a MOSTANI verziorol szol (kozben nem
 * keszult ujabb -- kulonben egy masik mentes csendben elveszne), a munkadarab
 * forrasa tenyleg kep, es a bajtok tenyleg PNG / JPEG / WebP (a kiterjesztes a
 * TARTALOMBOL jon, nem a kerestol).
 */
import { basename } from 'node:path'
import type { ProjectRow } from './projects.js'
import { buildPreview } from './workbench-preview.js'
import { saveBytesAsNewVersion, type TextSaveResult } from './workbench-edit.js'
import type { WorkItemRow } from './workbench.js'

export type ImageFormat = 'png' | 'jpg' | 'webp'

/** A kep fajtaja a TARTALOM elso bajtjaibol. */
export function sniffImage(buf: Buffer): ImageFormat | null {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return 'png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg'
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp'
  return null
}

/** Az uj fajl neve: a regi neve, a TARTALOM szerinti kiterjesztessel
 *  ("foto.jpg" + atlatszo hatter -> "foto.png"; a " (2)" a mentesnel jon). */
export function editedImageName(rel: string, fmt: ImageFormat): string {
  const base = basename(String(rel || '')) || 'kep'
  const stem = base.replace(/\.[^.]+$/, '') || base
  return `${stem}.${fmt}`
}

export function saveEditedImage(
  item: WorkItemRow, project: ProjectRow, data: Buffer,
  opts: { baseVersion: unknown; created_by?: string | null },
): TextSaveResult {
  const base = String(opts.baseVersion ?? '')
  if (!base || base !== (item.current_version_id || '')) return { ok: false, code: 'image_edit_stale' }
  const fmt = sniffImage(data)
  if (!fmt) return { ok: false, code: 'image_edit_not_image' }
  const p = buildPreview(item.id)
  if (!p.available || p.kind !== 'image' || !p.rel) {
    return { ok: false, code: p.reason && p.reason !== 'no_source' ? 'preview_' + p.reason : 'image_edit_unsupported' }
  }
  return saveBytesAsNewVersion(item, project, p.rel, data, {
    created_by: opts.created_by ?? null, edit: 'image', fileName: editedImageName(p.rel, fmt),
  })
}
