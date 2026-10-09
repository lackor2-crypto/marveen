// A STABLE ID FOR A DOCUMENT (#510, step 3).
//
// Boss's document specification (chapters 14 and 35): "Minden dokumentumnak
// legyen stabil belso azonositoja [...] A dokumentumkapcsolatok alapja ne a
// fajl neve vagy az eleresi ut legyen." A file's name and folder change; the
// id does not. A project is to refer to a document by this id, and the
// duplicate check of #513 compares content through it.
//
// A record is made ON DEMAND (ensureDocumentId), never by sweeping the tree:
// the tree is tens of gigabytes on a slow mount. Hashing is on demand too.
//
// Three things this module is careful about:
//   - a hash is only as good as the file it was taken from: it is stored with
//     the size and mtime it was computed at, and reported as absent the moment
//     those no longer match (a stale hash would call two different files
//     duplicates);
//   - reading is done in small chunks with a retry: on the 9p depot a 1 MB
//     read has answered "Cannot allocate memory";
//   - a file that is not where its record says is NOT forgotten. Not found is
//     not deleted: the disk may be unmounted.
import { createHash, randomBytes } from 'node:crypto'
import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { getDb } from './db.js'
import { depotRoot } from './depot.js'
import { logger } from './logger.js'
import { listMounts } from './life-mounts.js'
import { trashRelPath, legacyTrashRelPath } from './life-tree.js'

export interface LifeDocument {
  id: string
  /** Where the file is, relative to the depot root, `/`-separated. */
  rel: string
  size: number
  mtimeMs: number
  /** `null` = not hashed yet, OR the file changed since it was hashed. */
  sha256: string | null
  /** The same, as the Drive API reports it (`md5Checksum`), for a comparison without a download. */
  md5: string | null
}

interface Row { id: string; rel: string; size: number; mtime_ms: number; sha256: string | null; md5: string | null; hashed_size: number | null; hashed_mtime_ms: number | null }

const norm = (rel: string): string => String(rel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
const READ_CHUNK = 64 * 1024
const ENOMEM_RETRIES = 4
const WALK_MAX_DEPTH = 10
const WALK_MAX_DIRS = 30_000

let tablesDb: unknown = null
export function ensureLifeDocTables(): void {
  const db = getDb()
  if (tablesDb === db) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS life_documents (
      id TEXT PRIMARY KEY,
      rel TEXT NOT NULL UNIQUE,
      size INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL,
      sha256 TEXT,
      md5 TEXT,
      hashed_size INTEGER,
      hashed_mtime_ms INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_life_documents_size ON life_documents(size);
    CREATE INDEX IF NOT EXISTS idx_life_documents_sha ON life_documents(sha256);
    CREATE INDEX IF NOT EXISTS idx_life_documents_md5 ON life_documents(md5);
  `)
  tablesDb = db
}

/** A hash counts only while the file is the size and age it was hashed at. */
function fresh(r: Row): boolean {
  return r.hashed_size === r.size && r.hashed_mtime_ms === r.mtime_ms
}

function toDoc(r: Row): LifeDocument {
  const ok = fresh(r)
  return { id: r.id, rel: r.rel, size: r.size, mtimeMs: r.mtime_ms, sha256: ok ? r.sha256 : null, md5: ok ? r.md5 : null }
}

const COLS = 'id, rel, size, mtime_ms, sha256, md5, hashed_size, hashed_mtime_ms'

function absOf(rel: string): string | null {
  const root = depotRoot()
  return root ? join(root, ...norm(rel).split('/')) : null
}

function newId(): string {
  // Readable and unambiguous: no 0/O, 1/I/L. Same shape as the specification's example (DOC-8F42K7Q1).
  const abc = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
  const b = randomBytes(8)
  let s = ''
  for (let i = 0; i < 8; i++) s += abc[b[i] % abc.length]
  return `DOC-${s}`
}

/** The id of the file at this path, if it has one. Does not make one. */
export function documentIdFor(rel: string): string | null {
  ensureLifeDocTables()
  const r = getDb().prepare('SELECT id FROM life_documents WHERE rel = ?').get(norm(rel)) as { id: string } | undefined
  return r ? r.id : null
}

/**
 * The id of the file at this path; made now if it has none. `null` when there
 * is no file there to give an id to (no depot, missing, a folder).
 */
export async function ensureDocumentId(rel: string): Promise<string | null> {
  ensureLifeDocTables()
  const key = norm(rel)
  const abs = absOf(key)
  if (!key || !abs) return null
  let st
  try { st = await stat(abs) } catch { return null }
  if (!st.isFile()) return null
  const db = getDb()
  const have = db.prepare('SELECT id FROM life_documents WHERE rel = ?').get(key) as { id: string } | undefined
  const mtime = Math.round(st.mtimeMs)
  if (have) {
    // Keep the measured size/age current: that is what makes an old hash drop out.
    db.prepare('UPDATE life_documents SET size = ?, mtime_ms = ? WHERE id = ?').run(st.size, mtime, have.id)
    return have.id
  }
  for (let i = 0; i < 5; i++) {
    const id = newId()
    try {
      db.prepare('INSERT INTO life_documents (id, rel, size, mtime_ms, created_at) VALUES (?, ?, ?, ?, ?)').run(id, key, st.size, mtime, Date.now())
      return id
    } catch (err: any) {
      // The path got a record meanwhile (two callers at once): that one is the id.
      const again = db.prepare('SELECT id FROM life_documents WHERE rel = ?').get(key) as { id: string } | undefined
      if (again) return again.id
      if (i === 4) throw err
    }
  }
  return null
}

export function documentById(id: string): LifeDocument | null {
  ensureLifeDocTables()
  const r = getDb().prepare(`SELECT ${COLS} FROM life_documents WHERE id = ?`).get(String(id)) as Row | undefined
  return r ? toDoc(r) : null
}

/** Cheap pre-filter for a duplicate search: only files of this size are worth hashing. */
export function documentsBySize(size: number): LifeDocument[] {
  ensureLifeDocTables()
  return (getDb().prepare(`SELECT ${COLS} FROM life_documents WHERE size = ? ORDER BY rel`).all(Number(size)) as Row[]).map(toDoc)
}

/** Documents with this content. A record whose file changed since it was hashed is NOT returned. */
export function documentsByHash(sha256: string): LifeDocument[] {
  ensureLifeDocTables()
  const h = String(sha256 || '').toLowerCase()
  if (!h) return []
  return (getDb().prepare(`SELECT ${COLS} FROM life_documents WHERE sha256 = ? ORDER BY rel`).all(h) as Row[]).filter(fresh).map(toDoc)
}

/** The same by the Drive-style md5 (`md5Checksum`). */
export function documentsByMd5(md5: string): LifeDocument[] {
  ensureLifeDocTables()
  const h = String(md5 || '').toLowerCase()
  if (!h) return []
  return (getDb().prepare(`SELECT ${COLS} FROM life_documents WHERE md5 = ? ORDER BY rel`).all(h) as Row[]).filter(fresh).map(toDoc)
}

/**
 * Look at the file again. `missing: true` = it is not at its path (the record
 * is kept). Otherwise the size and age are brought up to date, which makes a
 * hash taken from an older content drop out.
 */
export async function verifyDocument(id: string): Promise<{ doc: LifeDocument; missing: boolean } | null> {
  ensureLifeDocTables()
  const db = getDb()
  const r = db.prepare(`SELECT ${COLS} FROM life_documents WHERE id = ?`).get(String(id)) as Row | undefined
  if (!r) return null
  const abs = absOf(r.rel)
  let st
  try { st = abs ? await stat(abs) : null } catch { st = null }
  if (!st || !st.isFile()) return { doc: toDoc(r), missing: true }
  const mtime = Math.round(st.mtimeMs)
  if (st.size !== r.size || mtime !== r.mtime_ms) {
    db.prepare('UPDATE life_documents SET size = ?, mtime_ms = ? WHERE id = ?').run(st.size, mtime, r.id)
    r.size = st.size
    r.mtime_ms = mtime
  }
  return { doc: toDoc(r), missing: false }
}

async function hashFile(abs: string): Promise<{ sha256: string; md5: string; size: number }> {
  const sha = createHash('sha256')
  const md5 = createHash('md5')
  const buf = Buffer.allocUnsafe(READ_CHUNK)
  const fh = await open(abs, 'r')
  let size = 0
  try {
    for (;;) {
      let n = 0
      for (let attempt = 0; ; attempt++) {
        try { n = (await fh.read(buf, 0, READ_CHUNK, size)).bytesRead; break } catch (err: any) {
          // The 9p mount answers ENOMEM under load; the same read succeeds a moment later.
          if (err?.code !== 'ENOMEM' || attempt >= ENOMEM_RETRIES) throw err
          await new Promise<void>((r) => setTimeout(r, 100 * (attempt + 1)))
        }
      }
      if (!n) break
      const part = buf.subarray(0, n)
      sha.update(part)
      md5.update(part)
      size += n
    }
  } finally { await fh.close() }
  return { sha256: sha.digest('hex'), md5: md5.digest('hex'), size }
}

/**
 * The content hash of a document (SHA-256; the md5 is stored beside it).
 * Computed once and kept while the file does not change. `null` = the file is
 * not there, or it could not be read (the reason is logged, never guessed).
 */
export async function hashDocument(id: string): Promise<string | null> {
  const v = await verifyDocument(id)
  if (!v || v.missing) return null
  if (v.doc.sha256) return v.doc.sha256
  const abs = absOf(v.doc.rel)
  if (!abs) return null
  try {
    const h = await hashFile(abs)
    // Changed WHILE we read it: the hash belongs to no stable content, do not keep it.
    const after = await stat(abs)
    if (after.size !== v.doc.size || Math.round(after.mtimeMs) !== v.doc.mtimeMs || h.size !== v.doc.size) return null
    getDb().prepare('UPDATE life_documents SET sha256 = ?, md5 = ?, hashed_size = ?, hashed_mtime_ms = ? WHERE id = ?')
      .run(h.sha256, h.md5, v.doc.size, v.doc.mtimeMs, v.doc.id)
    return h.sha256
  } catch (err: any) {
    logger.warn({ id, rel: v.doc.rel, err: String(err?.code || err?.message || err) }, '[eletfa] a document could not be hashed')
    return null
  }
}

/**
 * A file or a folder was renamed / moved: the documents on it and under it
 * follow (called from followFolderMove). A record already at the new path
 * belonged to a file that is no longer there -- the one that arrives wins.
 */
export function moveDocumentsPrefix(fromRel: string, toRel: string): number {
  const from = norm(fromRel)
  const to = norm(toRel)
  if (!from || !to || from === to) return 0
  ensureLifeDocTables()
  const db = getDb()
  const like = from.replace(/[\\%_]/g, (c) => '\\' + c) + '/%'
  const rows = db.prepare(`SELECT id, rel FROM life_documents WHERE rel = ? OR rel LIKE ? ESCAPE '\\'`).all(from, like) as { id: string; rel: string }[]
  if (!rows.length) return 0
  const drop = db.prepare('DELETE FROM life_documents WHERE rel = ? AND id != ?')
  const upd = db.prepare('UPDATE life_documents SET rel = ? WHERE id = ?')
  db.transaction(() => {
    for (const r of rows) {
      const next = to + r.rel.slice(from.length)
      drop.run(next, r.id)
      upd.run(next, r.id)
    }
  })()
  return rows.length
}

/**
 * The file is not at its path: look for it by CONTENT (a rename or a move done
 * outside Marveen). Only a document that was hashed before can be recognised,
 * and only when exactly one file matches -- two files with the same content
 * are a copy, and guessing which one is "the" document would be a lie.
 * Returns the new path when the record was moved there.
 */
export async function relocateDocument(id: string): Promise<string | null> {
  const v = await verifyDocument(id)
  if (!v || !v.missing) return null
  ensureLifeDocTables()
  const row = getDb().prepare(`SELECT ${COLS} FROM life_documents WHERE id = ?`).get(String(id)) as Row | undefined
  const root = depotRoot()
  if (!row || !root || !row.sha256 || !fresh(row)) return null
  try { if (!(await stat(root)).isDirectory()) return null } catch { return null }

  const skip = new Set<string>([norm(trashRelPath()), norm(legacyTrashRelPath())])
  for (const m of listMounts()) skip.add(m.rel)
  const sameSize: string[] = []
  const seen = new Set<string>()
  let dirs = 0
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (depth > WALK_MAX_DEPTH || dirs >= WALK_MAX_DIRS || seen.has(rel)) return
    seen.add(rel)
    let entries: import('node:fs').Dirent[]
    try { entries = await readdir(rel ? join(root, ...rel.split('/')) : root, { withFileTypes: true }) } catch { return }
    if (++dirs % 64 === 0) await new Promise<void>((r) => setImmediate(r))
    if (entries.some((e) => e.name === '.git')) return
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      const child = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) { if (!skip.has(child)) await walk(child, depth + 1); continue }
      if (!e.isFile()) continue
      try { if ((await stat(join(root, ...child.split('/')))).size === row.size) sameSize.push(child) } catch { /* gone meanwhile */ }
    }
  }
  // Beside its old place first; the whole tree only if it is not there.
  const parent = row.rel.includes('/') ? row.rel.slice(0, row.rel.lastIndexOf('/')) : ''
  await walk(parent, WALK_MAX_DEPTH - 1)
  if (!sameSize.length) { seen.clear(); await walk('', 0) }

  const matches: string[] = []
  for (const rel of [...new Set(sameSize)]) {
    try { if ((await hashFile(join(root, ...rel.split('/')))).sha256 === row.sha256) matches.push(rel) } catch { /* unreadable: not a match we can prove */ }
  }
  if (matches.length !== 1) return null
  const to = matches[0]
  const st = await stat(join(root, ...to.split('/')))
  const mtime = Math.round(st.mtimeMs)
  const db = getDb()
  db.transaction(() => {
    db.prepare('DELETE FROM life_documents WHERE rel = ? AND id != ?').run(to, row.id)
    db.prepare('UPDATE life_documents SET rel = ?, size = ?, mtime_ms = ?, hashed_size = ?, hashed_mtime_ms = ? WHERE id = ?')
      .run(to, st.size, mtime, st.size, mtime, row.id)
  })()
  logger.info({ id: row.id, from: row.rel, to }, '[eletfa] a document moved outside Marveen was found by its content')
  return to
}
