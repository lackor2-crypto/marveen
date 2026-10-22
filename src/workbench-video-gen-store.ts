/**
 * A VIDEOGENERALAS TARTOS FELADATAI (munkadarab "Video fejlesztes", 2. fazis).
 *
 * Miert adatbazis: egy generalas penzbe kerul es PERCEKIG fut az OpenRouternel, akkor is, ha a Marvin kozben
 * ujraindul. A memoriaban eltarolt feladat (`workbench-video-jobs.ts`) ilyenkor elveszne, vele a feladatazonosito
 * es a kifizetett video.
 *
 * A szabaly, amit ez a fajl oriz: a sor a kerés ELOTT jon letre ('preparing'), az OpenRouter-azonositot a valasz utan
 * azonnal beleirjuk ('running'). Ha a folyamat a ketto kozott all le, a sor 'failed' lesz es NEM probaljuk magunktol
 * ujra (lehet, hogy a generalas elindult, es az ujrapróbalkozas masodszor fizettetne); a tulajdonos az OpenRouter
 * tevekenysegei kozt latja, es o dont.
 */
import { getDb } from './db.js'
import { randomUUID } from 'node:crypto'

export type VideoGenState = 'preparing' | 'running' | 'done' | 'failed'

export interface VideoGenRow {
  id: string
  work_item_id: string
  project_id: string
  model: string
  prompt: string
  params_json: string
  state: VideoGenState
  remote_id: string | null
  est_usd: number | null
  cost_usd: number | null
  file_rel: string | null
  error_code: string | null
  error_detail: string | null
  created_at: number
  updated_at: number
}

let tablesDb: unknown = null

export function ensureVideoGenTables(): void {
  const db = getDb()
  if (tablesDb === db) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS wb_video_gen (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt TEXT NOT NULL,
      params_json TEXT NOT NULL,
      state TEXT NOT NULL,
      remote_id TEXT,
      est_usd REAL,
      cost_usd REAL,
      file_rel TEXT,
      error_code TEXT,
      error_detail TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_wb_video_gen_item ON wb_video_gen(work_item_id, created_at)')
  tablesDb = db
}

const now = (): number => Math.floor(Date.now() / 1000)

export function getVideoGen(id: string): VideoGenRow | null {
  ensureVideoGenTables()
  return (getDb().prepare('SELECT * FROM wb_video_gen WHERE id = ?').get(id) as VideoGenRow | undefined) ?? null
}

export function listVideoGens(itemId: string): VideoGenRow[] {
  ensureVideoGenTables()
  return getDb().prepare('SELECT * FROM wb_video_gen WHERE work_item_id = ? ORDER BY created_at DESC, rowid DESC').all(itemId) as VideoGenRow[]
}

/** Munkadarabonkent egyszerre egy generalas fut: ez a masodik (veletlen ketszer kuldott) kerest allitja meg. */
export function activeVideoGen(itemId: string): VideoGenRow | null {
  ensureVideoGenTables()
  return (getDb().prepare(`SELECT * FROM wb_video_gen WHERE work_item_id = ? AND state IN ('preparing','running') ORDER BY created_at DESC LIMIT 1`).get(itemId) as VideoGenRow | undefined) ?? null
}

export function createVideoGen(input: { itemId: string; projectId: string; model: string; prompt: string; params: unknown; estUsd: number | null }): VideoGenRow {
  ensureVideoGenTables()
  const id = randomUUID()
  const t = now()
  getDb().prepare(`INSERT INTO wb_video_gen (id, work_item_id, project_id, model, prompt, params_json, state, est_usd, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'preparing', ?, ?, ?)`).run(id, input.itemId, input.projectId, input.model, input.prompt, JSON.stringify(input.params), input.estUsd, t, t)
  return getVideoGen(id)!
}

export function setRemoteId(id: string, remoteId: string): void {
  ensureVideoGenTables()
  getDb().prepare(`UPDATE wb_video_gen SET remote_id = ?, state = 'running', updated_at = ? WHERE id = ?`).run(remoteId, now(), id)
}

export function finishVideoGen(id: string, r: { costUsd: number | null; fileRel: string }): void {
  ensureVideoGenTables()
  getDb().prepare(`UPDATE wb_video_gen SET state = 'done', cost_usd = ?, file_rel = ?, error_code = NULL, error_detail = NULL, updated_at = ? WHERE id = ?`).run(r.costUsd, r.fileRel, now(), id)
}

export function failVideoGen(id: string, code: string, detail: string, costUsd: number | null = null): void {
  ensureVideoGenTables()
  getDb().prepare(`UPDATE wb_video_gen SET state = 'failed', error_code = ?, error_detail = ?, cost_usd = COALESCE(?, cost_usd), updated_at = ? WHERE id = ?`).run(code, detail.slice(0, 500), costUsd, now(), id)
}

/** Egy kesz videohoz tartozo, de meg le nem toltott/elmentett generalas: a letoltes hibaja utan ujra megprobalhato (nem fizet ujra). */
export function resumableVideoGens(): VideoGenRow[] {
  ensureVideoGenTables()
  return getDb().prepare(`SELECT * FROM wb_video_gen WHERE state = 'running' AND remote_id IS NOT NULL`).all() as VideoGenRow[]
}

/** Indulaskor: ami 'preparing' maradt, annak a kerese lehet, hogy elment -- NEM probaljuk ujra. */
export function failOrphanPreparing(): number {
  ensureVideoGenTables()
  const r = getDb().prepare(`UPDATE wb_video_gen SET state = 'failed', error_code = 'video_interrupted_before_id',
    error_detail = 'The app stopped before the job id was saved. The request may have started: check the OpenRouter activity page before trying again.', updated_at = ?
    WHERE state = 'preparing' AND remote_id IS NULL`).run(now())
  return Number(r.changes)
}

/** A havi koltseg (UTC honap eleje ota): a tenyleges koltseg, ennek hianyaban a becsult; a sikertelen, de nem fizetett nem szamit. */
export function monthSpendUsd(at: Date = new Date()): number {
  ensureVideoGenTables()
  const start = Math.floor(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1) / 1000)
  const r = getDb().prepare(`SELECT COALESCE(SUM(CASE
      WHEN state = 'failed' THEN COALESCE(cost_usd, 0)
      ELSE COALESCE(cost_usd, est_usd, 0) END), 0) AS usd
    FROM wb_video_gen WHERE created_at >= ?`).get(start) as { usd: number }
  return Math.round(r.usd * 10000) / 10000
}

export function itemVideoCost(itemId: string): { usd: number; clips: number } {
  ensureVideoGenTables()
  const r = getDb().prepare(`SELECT COALESCE(SUM(COALESCE(cost_usd, 0)), 0) AS usd, COUNT(*) AS n FROM wb_video_gen WHERE work_item_id = ? AND state = 'done'`).get(itemId) as { usd: number; n: number }
  return { usd: Math.round(r.usd * 10000) / 10000, clips: r.n }
}
