// #986: where the speech transcript of an audio / video material stands. A light module (database only), so the
// materials list can ask it without pulling in the recogniser; the work itself is in workbench-media-transcript.ts.
import { extname } from 'node:path'
import { getDb } from './db.js'
import { FINISHED_FOLDER_NAMES, FINISHED_FOLDER_OLD_NAMES } from './project-files.js'

/** Audio and video files: what they SAY is read out by the speech recogniser. */
const SPEECH_EXT = new Set(['.m4a', '.mp3', '.wav', '.ogg', '.oga', '.opus', '.flac', '.aac', '.wma', '.amr',
  '.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.3gp'])
export function isSpeechKind(name: string): boolean { return SPEECH_EXT.has(extname(String(name || '')).toLowerCase()) }

const ready = new WeakSet<object>()
/** Our own finished outputs (the generated PDF, the rendered video) are not materials to read back. */
export function isOwnOutputPath(rel: string): boolean {
  const own = new Set<string>([FINISHED_FOLDER_NAMES.hu, FINISHED_FOLDER_NAMES.en, ...FINISHED_FOLDER_OLD_NAMES])
  return rel.split('/').slice(0, -1).some((seg) => own.has(seg))
}

export function ensureExtractTable(): void {
  const db = getDb()
  if (ready.has(db)) return
  db.exec(`CREATE TABLE IF NOT EXISTS work_item_file_extract (
    item_id TEXT NOT NULL, rel TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL,
    method TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
    extracted_at INTEGER NOT NULL, abs TEXT NOT NULL DEFAULT '', PRIMARY KEY (item_id, rel))`)
  const cols = db.prepare('PRAGMA table_info(work_item_file_extract)').all() as { name: string }[]
  if (!cols.some((c) => c.name === 'abs')) db.exec(`ALTER TABLE work_item_file_extract ADD COLUMN abs TEXT NOT NULL DEFAULT ''`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_work_item_file_extract_abs ON work_item_file_extract(abs)')
  ready.add(db)
}

export type TranscriptState = 'waiting' | 'running' | 'done' | 'failed' | 'no_recogniser'
export interface TranscriptInfo { state: TranscriptState; reason?: string }

/** The jobs of this process, by absolute path. `stamp` (size + time) tells a failed file from its newer content. */
const live = new Map<string, { state: 'waiting' | 'running' | 'failed'; reason?: string; stamp: string }>()
export function setLiveTranscript(abs: string, value: { state: 'waiting' | 'running' | 'failed'; reason?: string; stamp: string } | null): void {
  if (value) live.set(abs, value); else live.delete(abs)
}
export function liveTranscript(abs: string): { state: 'waiting' | 'running' | 'failed'; reason?: string; stamp: string } | undefined { return live.get(abs) }

/** Set by workbench-media-transcript when it loads (a cheap file check). Until then the recogniser counts as absent. */
let probe: () => boolean = () => false
export function setRecogniserProbe(p: (() => boolean) | null): void { probe = p || (() => false) }
export function recogniserInstalled(): boolean { return probe() }

/** Not looked at yet counts as waiting: the next pass over the item puts it in line. */
export function transcriptInfo(itemId: string, abs: string): TranscriptInfo {
  const now = live.get(abs)
  if (now) return { state: now.state, reason: now.reason }
  ensureExtractTable()
  const row = getDb().prepare('SELECT error FROM work_item_file_extract WHERE abs = ? ORDER BY (item_id = ?) DESC, extracted_at DESC LIMIT 1')
    .get(abs, itemId) as { error: string } | undefined
  if (row) return row.error ? { state: 'failed', reason: row.error } : { state: 'done' }
  return { state: probe() ? 'waiting' : 'no_recogniser' }
}
