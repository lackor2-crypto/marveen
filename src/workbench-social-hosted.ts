/**
 * A NYILVANOS TARHELYEN LEVO VIDEOK NYILVANTARTASA (munkadarab "Video fejlesztes", 8/e).
 *
 * A tarhely (Cloudinary ingyenes szint) kozos havi keretet ad, ezert csak a kozzetetelre szant ROVID, vegleges klip
 * megy fel, egyesevel, es EGYSZERRE LEGFELJEBB `HOSTED_KEEP` (3) marad fent. Amikor egy ujabb feltoltes a limit fole
 * vinne, a LEGREGEBBIEKET toroljuk. Szabalyok:
 *   - A nyilvantartas tartos (SQLite): ebbol tudjuk, mi van fent, mi torlodott, es mit kell ujraprobalni.
 *   - A torles hibaja SOSEM akasztja meg a posztolast: a sor `delete_failed` allapotban marad, a kovetkezo
 *     feltoltesnel (vagy a panel "Torles ujraprobalasa" gombjara) ujra megyunk ra.
 *   - Ugyanaz a tartalom (ugyanaz a klip, ugyanaz az SHA-256) nem tolt fel ketszer: a fent levo masolatot hasznaljuk.
 *   - A titok sehol nem kerul hibauzenetbe vagy naplóba (lasd `redactSecret`).
 */
import { createHash } from 'node:crypto'
import { getDb } from './db.js'
import { logger } from './logger.js'
import { destroyPublicVideo, hostConfigFromVault, redactSecret, type HostConfig, type HostDeps } from './workbench-social-host.js'

/** Ennyi video maradhat egyszerre a tarhelyen (Boss kerese: kettő-három, nagyon ovatosan). */
export const HOSTED_KEEP = 3
/** A torolt sorok ennyi legutobbi darabja marad meg a panel "mi torlodott" listajahoz. */
const REMOVED_HISTORY = 20

export type HostedState = 'hosted' | 'delete_failed' | 'deleted'
export interface HostedRow {
  public_id: string
  clip_key: string
  url: string
  bytes: number
  sha256: string
  uploaded_at: number
  state: HostedState
  deleted_at: number | null
  delete_error: string | null
  delete_tries: number
}

let tablesDb: unknown = null
export function ensureHostedTable(): void {
  const db = getDb()
  if (tablesDb === db) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS wb_social_hosted (
      public_id TEXT PRIMARY KEY,
      clip_key TEXT NOT NULL,
      url TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      uploaded_at INTEGER NOT NULL,
      state TEXT NOT NULL,
      deleted_at INTEGER,
      delete_error TEXT,
      delete_tries INTEGER NOT NULL DEFAULT 0
    )
  `)
  tablesDb = db
}

export function sha256Of(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex') }

/** A tarhelyi azonosito: a klip + a tartalom rovid kivonata, igy a megvaltozott klip uj cimet kap (nincs CDN-gyorsitotar-zavar). */
export function hostedPublicId(clipKey: string, sha256: string): string {
  const base = clipKey.replace(/[^A-Za-z0-9_\-/]+/g, '-').slice(0, 100)
  return `marveen/${base}-${sha256.slice(0, 8)}`
}

/** Monoton ido-bélyeg (ms): ket feltoltes soha nem kap azonos erteket, igy a "legregebbi" egyertelmu. */
function nextStamp(now: number): number {
  const last = getDb().prepare('SELECT MAX(uploaded_at) AS m FROM wb_social_hosted').get() as { m: number | null }
  return Math.max(now, (last.m ?? 0) + 1)
}

/** A fent levo, ugyanilyen tartalmu masolat; ha van, nem kell ujra feltolteni. (A `delete_failed` sor nem biztos, hogy meg ott van: azt ujra feltoltjuk.) */
export function findHostedCopy(publicId: string, sha256: string): HostedRow | null {
  ensureHostedTable()
  const r = getDb().prepare("SELECT * FROM wb_social_hosted WHERE public_id = ? AND sha256 = ? AND state = 'hosted'").get(publicId, sha256) as HostedRow | undefined
  return r ?? null
}

/** Feljegyzi a (friss vagy ujrahasznalt) feltoltest: ez lesz a legujabb. */
export function recordHosted(input: { publicId: string; clipKey: string; url: string; bytes: number; sha256: string; now?: number }): void {
  ensureHostedTable()
  const at = nextStamp(input.now ?? Date.now())
  getDb().prepare(`INSERT INTO wb_social_hosted (public_id, clip_key, url, bytes, sha256, uploaded_at, state, deleted_at, delete_error, delete_tries)
    VALUES (?, ?, ?, ?, ?, ?, 'hosted', NULL, NULL, 0)
    ON CONFLICT(public_id) DO UPDATE SET clip_key = excluded.clip_key, url = excluded.url, bytes = excluded.bytes, sha256 = excluded.sha256,
      uploaded_at = excluded.uploaded_at, state = 'hosted', deleted_at = NULL, delete_error = NULL, delete_tries = 0`)
    .run(input.publicId, input.clipKey, input.url, input.bytes, input.sha256, at)
}

export interface PruneOutcome {
  /** A most torolt videok azonositoi. */
  deleted: string[]
  /** A torlesi kiserlet, ami nem sikerult (a sor `delete_failed`; a kovetkezo alkalommal ujra megyunk ra). */
  failed: { publicId: string; code: string; detail: string }[]
  /** Igaz, ha a torlest kihagytuk, mert nincs tarhely-hozzaferes (Vault). */
  skipped: boolean
}

/**
 * A `keep` legujabb videon kivul mindent torol a tarhelyrol (a legregebbivel kezdve). Soha nem dob hibat.
 * A korabban sikertelen torlesek ugyanigy ujra sorra kerulnek.
 */
export async function pruneHostedVideos(deps: HostDeps & { keep?: number } = {}): Promise<PruneOutcome> {
  const out: PruneOutcome = { deleted: [], failed: [], skipped: false }
  try {
    ensureHostedTable()
    const cfg: HostConfig | null = deps.config === undefined ? hostConfigFromVault() : deps.config
    const db = getDb()
    const keep = Math.max(1, deps.keep ?? HOSTED_KEEP)
    const alive = db.prepare("SELECT * FROM wb_social_hosted WHERE state != 'deleted' ORDER BY uploaded_at DESC").all() as HostedRow[]
    const excess = alive.slice(keep).reverse()
    if (!excess.length) return out
    if (!cfg) { out.skipped = true; return out }
    const now = deps.now ? deps.now() : Date.now()
    for (const row of excess) {
      const r = await destroyPublicVideo(row.public_id, deps)
      if (r.ok) {
        db.prepare("UPDATE wb_social_hosted SET state = 'deleted', deleted_at = ?, delete_error = NULL WHERE public_id = ?").run(now, row.public_id)
        out.deleted.push(row.public_id)
      } else {
        const detail = redactSecret(r.detail, cfg.apiSecret)
        db.prepare("UPDATE wb_social_hosted SET state = 'delete_failed', delete_error = ?, delete_tries = delete_tries + 1 WHERE public_id = ?").run(`${r.code}: ${detail}`.slice(0, 300), row.public_id)
        out.failed.push({ publicId: row.public_id, code: r.code, detail })
        logger.warn({ publicId: row.public_id, code: r.code, detail }, 'social host: deleting an old video failed, will retry at the next upload')
      }
    }
    // A torolt sorokbol csak a legutobbi REMOVED_HISTORY marad (a lista ne nojon vegtelenre).
    db.prepare(`DELETE FROM wb_social_hosted WHERE state = 'deleted' AND public_id NOT IN
      (SELECT public_id FROM wb_social_hosted WHERE state = 'deleted' ORDER BY deleted_at DESC, uploaded_at DESC LIMIT ?)`).run(REMOVED_HISTORY)
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    logger.warn({ detail }, 'social host: pruning the hosted videos crashed (posting is not affected)')
  }
  return out
}

export interface HostedView {
  keep: number
  /** Ami most fent van a tarhelyen (a legujabb elol), a sikertelenul torolt is. */
  live: HostedRow[]
  /** Az utoljara torolt videok (legfrissebb elol). */
  removed: HostedRow[]
}

export function hostedView(): HostedView {
  ensureHostedTable()
  const db = getDb()
  return {
    keep: HOSTED_KEEP,
    live: db.prepare("SELECT * FROM wb_social_hosted WHERE state != 'deleted' ORDER BY uploaded_at DESC").all() as HostedRow[],
    removed: db.prepare("SELECT * FROM wb_social_hosted WHERE state = 'deleted' ORDER BY deleted_at DESC, uploaded_at DESC LIMIT 5").all() as HostedRow[],
  }
}
