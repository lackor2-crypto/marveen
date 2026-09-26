/**
 * MUNKAPAD: FAJLBOL UJ MUNKADARAB (kanban #406, 3. pont -- behuzas es
 * feltoltes, telefonrol is).
 *
 * A felhasznalo egy fajlt huz a Munkapadra (vagy telefonon kivalasztja /
 * lefenykepezi): a fajl a PROJEKT mappajaba kerul (ott keresi, es a mentes is
 * viszi), es egy UJ munkadarab szuletik, aminek ez a fajl a forrasa. A fajtat
 * a SZERVER dontei el a fajl nevebol -- a bongeszo altal kuldott tipus csak
 * tartalek, mert az telefononkent mas es mas.
 */
import { extname } from 'node:path'
import { fileKind } from './file-kind.js'
import { isCanvasFile } from './workbench-graphic.js'
import { TITLE_MAX, type WorkItemType } from './workbench.js'

/** A fajl -> munkadarab-fajta. Ami nem kep/video/grafika/jegyzet, az dokumentum
 *  (a dokumentum-elonezet mindent kezel, amit lehet, es megmondja, ha nem). */
export function workItemTypeForFile(name: string, mime?: string | null): WorkItemType {
  const n = String(name || '')
  if (isCanvasFile(n)) return 'graphic'
  const ext = extname(n).slice(1).toLowerCase()
  if (ext === 'svg') return 'graphic'
  if (ext === 'md' || ext === 'txt') return 'note'
  const k = fileKind(n).kind
  if (k === 'image') return 'image'
  if (k === 'video') return 'video'
  if (k === 'pdf' || k === 'text' || k === 'audio') return 'document'
  const m = String(mime || '').toLowerCase()
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('video/')) return 'video'
  return 'document'
}

/** A munkadarab neve a fajlnevbol: kiterjesztes nelkul, az elvalasztok
 *  szokozze alakitva ("ajanlat_kovacs-v2.docx" -> "ajanlat kovacs v2"). */
export function titleFromFileName(name: string): string {
  const base = String(name || '').replace(/^.*[\\/]/, '')
  const stem = base.replace(/\.[^.]+$/, '') || base
  const nice = stem.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim()
  return (nice || base || 'file').slice(0, TITLE_MAX)
}
