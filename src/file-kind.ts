/**
 * MI JELENITHETO MEG A BONGESZOBEN (kartya #164 -> #336, 4. fazis).
 *
 * Eddig ez a tabla az Intezo fajl-kiszolgalojaban (`web/routes/life.ts`) allt.
 * A Munkapad ELONEZETE ugyanezt a kerdest teszi fel ("meg tudom-e mutatni ezt
 * a fajlt?"), ezert a valasz EGY helyre kerult: ha egy uj tipus bejon, mindket
 * felulet egyszerre tanulja meg. Ket masolat elobb-utobb szetcsuszna.
 */
import { extname } from 'node:path'

/** Kiterjesztes -> MIME. Ami nincs benne, azt a bongeszo nem mutatja meg
 *  magatol (docx/xlsx/exe/...): az CSAK letoltheto, vagy atalakitast igenyel. */
export const PREVIEW_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  mp4: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime',
  txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8',
  js: 'text/plain; charset=utf-8', mjs: 'text/plain; charset=utf-8', cjs: 'text/plain; charset=utf-8',
  ts: 'text/plain; charset=utf-8', tsx: 'text/plain; charset=utf-8', jsx: 'text/plain; charset=utf-8',
  json: 'text/plain; charset=utf-8', css: 'text/plain; charset=utf-8',
  html: 'text/plain; charset=utf-8', htm: 'text/plain; charset=utf-8',
  py: 'text/plain; charset=utf-8', sh: 'text/plain; charset=utf-8', bash: 'text/plain; charset=utf-8',
  yml: 'text/plain; charset=utf-8', yaml: 'text/plain; charset=utf-8', csv: 'text/plain; charset=utf-8',
  xml: 'text/plain; charset=utf-8', c: 'text/plain; charset=utf-8', cpp: 'text/plain; charset=utf-8',
  h: 'text/plain; charset=utf-8', hpp: 'text/plain; charset=utf-8', java: 'text/plain; charset=utf-8',
  go: 'text/plain; charset=utf-8', rs: 'text/plain; charset=utf-8', php: 'text/plain; charset=utf-8',
  rb: 'text/plain; charset=utf-8', sql: 'text/plain; charset=utf-8', ini: 'text/plain; charset=utf-8',
  toml: 'text/plain; charset=utf-8', log: 'text/plain; charset=utf-8',
}

/** Az elonezet FAJTAJA -- ezt a felulet forditja le doboztipusra (beagyazott
 *  PDF, kep, szoveg, video, hang). A `null` azt jelenti: nem tudom megmutatni. */
export type PreviewKind = 'pdf' | 'image' | 'video' | 'audio' | 'text' | null

export function fileKind(name: string): { mime: string | null; previewable: boolean; kind: PreviewKind } {
  const ext = extname(String(name || '')).slice(1).toLowerCase()
  const mime = PREVIEW_MIME[ext] || null
  return { mime, previewable: mime !== null, kind: previewKindOf(mime) }
}

export function previewKindOf(mime: string | null): PreviewKind {
  if (!mime) return null
  if (mime === 'application/pdf') return 'pdf'
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('text/')) return 'text'
  return null
}
