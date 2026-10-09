/**
 * MUNKAPAD: A POSZT PLATFORM-KEPEI (kanban #406, Boss TG 6642/6653, 3-4. lepes).
 *
 * A Munkapad a posztkepet a BONGESZOBEN vagja a platform pontos meretere (a
 * huzott kivagassal). A betekinto link lapja (/view/<token>) viszont szkript
 * nelkul fut, ott nem lehet vagni -- ezert a kesz kepet a felhasznalo egy
 * kattintassal elmenti: UJ fajlkent a munkadarab melle (sosem ir felul), es
 * itt feljegyezzuk, melyik platformhoz tartozik. A /view lap ezt kinalja
 * letoltesre.
 *
 * Amit a szerver ellenoriz: a platform ismert, a bajtok tenyleg PNG / JPEG
 * (a TARTALOMBOL), es a kep PONTOSAN a platform merete -- igy a letoltott fajl
 * az, amit a nev igér.
 */
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { getDb } from './db.js'
import { resolveLifePath } from './life-explorer.js'
import { writeProjectFile, type FileErrorCode } from './project-files.js'
import type { ProjectRow } from './projects.js'
import { sniffImage } from './workbench-image-edit.js'
import { itemOutputFolder } from './workbench-assets.js'
import type { WorkItemRow } from './workbench.js'

/** Ugyanaz a lista, mint a feluleten (web/workbench.js POST_PLATFORMS). */
export const POST_PLATFORMS: Record<string, { w: number; h: number }> = {
  fb_feed: { w: 1080, h: 1350 },
  fb_square: { w: 1080, h: 1080 },
  fb_link: { w: 1200, h: 630 },
  fb_story: { w: 1080, h: 1920 },
  ig_feed: { w: 1080, h: 1350 },
  ig_portrait: { w: 1080, h: 1440 },
  ig_square: { w: 1080, h: 1080 },
  ig_story: { w: 1080, h: 1920 },
  li_landscape: { w: 1200, h: 627 },
  li_square: { w: 1080, h: 1080 },
  li_portrait: { w: 1080, h: 1350 },
}

/** Egy PNG egy ilyen meretnel bovon ez alatt marad. */
export const POST_FILE_MAX_BYTES = 30 * 1024 * 1024

export interface PostFileRow {
  id: string
  work_item_id: string
  platform: string
  rel: string
  bytes: number
  created_at: number
  created_by: string | null
}

export type PostFileCode =
  | 'post_bad_platform' | 'post_not_image' | 'post_wrong_size' | 'post_too_large' | 'post_empty'
  | FileErrorCode

let tablesDb: unknown = null

function ensureTable(): void {
  const db = getDb()
  if (tablesDb === db) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_item_post_files (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      rel TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      created_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_work_item_post_files_item ON work_item_post_files(work_item_id, created_at);
  `)
  tablesDb = db
}

/** A kep merete a fejlecbol (PNG IHDR, JPEG SOFn). Ismeretlennel null. */
export function imageSize(buf: Buffer): { w: number; h: number } | null {
  const fmt = sniffImage(buf)
  if (fmt === 'png') {
    if (buf.length < 24 || buf.toString('ascii', 12, 16) !== 'IHDR') return null
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
  }
  if (fmt === 'jpg') {
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue }
      const m = buf[i + 1]
      if (m === 0xff) { i++; continue }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue }
      const len = buf.readUInt16BE(i + 2)
      // SOF0..SOF15, kiveve DHT (c4), JPG (c8), DAC (cc)
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) }
      }
      if (len < 2) return null
      i += 2 + len
    }
  }
  return null
}

export function postFileName(title: string, platform: string, ext: string): string {
  const pf = POST_PLATFORMS[platform]
  const base = String(title || '').replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'poszt'
  return `${base} - ${platform} ${pf.w}x${pf.h}.${ext}`
}

export function savePostFile(
  item: WorkItemRow, project: ProjectRow, platform: unknown, data: Buffer, createdBy: string | null,
): { ok: true; file: PostFileRow; name: string } | { ok: false; code: PostFileCode; message?: string } {
  const key = String(platform ?? '')
  const pf = Object.prototype.hasOwnProperty.call(POST_PLATFORMS, key) ? POST_PLATFORMS[key] : null
  if (!pf) return { ok: false, code: 'post_bad_platform' }
  if (!data.length) return { ok: false, code: 'post_empty' }
  if (data.length > POST_FILE_MAX_BYTES) return { ok: false, code: 'post_too_large' }
  const fmt = sniffImage(data)
  if (fmt !== 'png' && fmt !== 'jpg') return { ok: false, code: 'post_not_image' }
  const size = imageSize(data)
  if (!size || size.w !== pf.w || size.h !== pf.h) return { ok: false, code: 'post_wrong_size' }
  // #496: into the post's own folder (else beside its file, else the work-items box), never the project root.
  const out = writeProjectFile(project, itemOutputFolder(project, item), postFileName(item.title, key, fmt), data)
  if (!out.ok) return out
  ensureTable()
  const row: PostFileRow = {
    id: randomUUID(), work_item_id: item.id, platform: key, rel: out.rel, bytes: out.bytes,
    created_at: Math.floor(Date.now() / 1000), created_by: createdBy,
  }
  getDb().prepare(`INSERT INTO work_item_post_files (id, work_item_id, platform, rel, bytes, created_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(row.id, row.work_item_id, row.platform, row.rel, row.bytes, row.created_at, row.created_by)
  return { ok: true, file: row, name: out.name }
}

export interface PostFileView extends PostFileRow {
  name: string
  /** false: a fajl azota eltunt vagy nem erheto el (a sor megmarad, de nem kinaljuk). */
  available: boolean
  abs: string | null
}

/** A munkadarab platform-kepei, platformonkent a LEGUJABB. Egy regebbi mentes
 *  fajlja a mappaban marad, csak a lista a frisset mutatja. */
export function listPostFiles(workItemId: string): PostFileView[] {
  ensureTable()
  const rows = getDb().prepare('SELECT * FROM work_item_post_files WHERE work_item_id = ? ORDER BY created_at DESC, rowid DESC')
    .all(String(workItemId || '')) as PostFileRow[]
  const seen = new Set<string>()
  const out: PostFileView[] = []
  for (const r of rows) {
    if (seen.has(r.platform)) continue
    seen.add(r.platform)
    const abs = resolveLifePath(r.rel)
    let available = false
    if (abs) { try { available = statSync(abs).isFile() } catch { available = false } }
    out.push({ ...r, name: r.rel.split('/').pop() || r.rel, available, abs: available ? abs : null })
  }
  return out
}

export function getPostFile(workItemId: string, id: string): PostFileView | null {
  return listPostFiles(workItemId).find((f) => f.id === id) ?? null
}
