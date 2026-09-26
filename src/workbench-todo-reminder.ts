/**
 * TEENDO-EMLEKEZTETO a tulajdonos SAJAT csatornajan (kanban #406, otlet a5ecabbe).
 *
 * A Munkapad hatarideju teendoirol a hatarido elott (alapbol az elozo nap
 * 18:00-kor) a Marveen EGY uzenetben szol a tulajdonosnak -- csak neki, a sajat
 * csatornajan, soha masnak. Ugyanarra a hataridore egy teendo csak egyszer kerul
 * be; ha a hatarido valtozik, az emlekezteto ujra elesedik.
 *
 * KULDES ELOTT NEM JELOLUNK: a teendo csak SIKERES kuldes utan kap "mar
 * emlekeztetve" jelet. Forditva egy elutasitott kuldes ugyanugy nezne ki, mint
 * egy sikeres, es az emlekezteto soha nem menne ki.
 *
 * NULLA != "NEM LATTAM": ha nincs bekotott csatorna, az allapot ezt mondja ki
 * (`no_channel`), es a felulet megmutatja -- nem hallgat ugy, mintha nem lenne
 * mirol szolni.
 *
 * Friss telepitesen: bekapcsolva indul, a teendokon kivul semmi nem kell hozza;
 * a beallitas es az allapot a Teendok panelen latszik es modosithato.
 */
import { getDb } from './db.js'
import { APP_LANG } from './config.js'
import { ensureTodoTable } from './workbench-todos.js'
import { ownerChannelReady, sendOwnerChannelChecked } from './notify.js'

export interface ReminderSettings {
  enabled: boolean
  /** Hany nappal a hatarido ELOTT (0 = aznap). */
  days_before: number
  /** Helyi ido, HH:MM. */
  time: string
}

export interface ReminderStatus extends ReminderSettings {
  /** Van-e csatorna, ahova kimehet. */
  channel: 'ok' | 'no_channel'
  /** Utolso sikeres kuldes (mp), vagy null. */
  last_sent_at: number | null
  /** Utolso sikertelen kuldes oka (a kovetkezo sikeresnel torlodik). */
  last_error: string | null
  last_error_at: number | null
}

export const REMINDER_DEFAULTS: ReminderSettings = { enabled: true, days_before: 1, time: '18:00' }
export const REMINDER_DAYS_BEFORE = [0, 1, 2, 3, 7] as const
/** A hatter-sopres gyakorisaga. */
export const REMINDER_SWEEP_MS = 5 * 60 * 1000
/** Sikertelen kuldes utan ennyi ideig nem probaljuk ujra (nem arasztjuk el a naplot). */
export const REMINDER_RETRY_AFTER_S = 30 * 60
/** Egy uzenetben legfeljebb ennyi teendo sorat irjuk ki; a tobbit a szam mondja. */
export const REMINDER_LIST_MAX = 20

let tableDb: unknown = null
function ensureTable(): void {
  const db = getDb()
  if (tableDb === db) return
  db.exec(`CREATE TABLE IF NOT EXISTS workbench_todo_reminder (
    key TEXT PRIMARY KEY,
    value TEXT
  )`)
  tableDb = db
}

function readKv(): Record<string, string> {
  ensureTable()
  const out: Record<string, string> = {}
  for (const r of getDb().prepare('SELECT key, value FROM workbench_todo_reminder').all() as { key: string; value: string | null }[]) {
    if (r.value != null) out[r.key] = r.value
  }
  return out
}

function writeKv(key: string, value: string | null): void {
  ensureTable()
  getDb().prepare('INSERT INTO workbench_todo_reminder (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

function cleanTime(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim())
  if (!m) return null
  const h = Number(m[1]); const mi = Number(m[2])
  if (h > 23 || mi > 59) return null
  return `${String(h).padStart(2, '0')}:${m[2]}`
}

export function getReminderSettings(): ReminderSettings {
  const kv = readKv()
  const days = Number(kv['days_before'])
  return {
    enabled: kv['enabled'] == null ? REMINDER_DEFAULTS.enabled : kv['enabled'] === '1',
    days_before: (REMINDER_DAYS_BEFORE as readonly number[]).includes(days) ? days : REMINDER_DEFAULTS.days_before,
    time: cleanTime(kv['time']) ?? REMINDER_DEFAULTS.time,
  }
}

export type ReminderSettingsResult = { ok: true; settings: ReminderSettings } | { ok: false; code: 'bad_time' | 'bad_days_before' }

export function setReminderSettings(patch: { enabled?: unknown; days_before?: unknown; time?: unknown }): ReminderSettingsResult {
  if (patch.time !== undefined && !cleanTime(patch.time)) return { ok: false, code: 'bad_time' }
  if (patch.days_before !== undefined && !(REMINDER_DAYS_BEFORE as readonly number[]).includes(Number(patch.days_before))) {
    return { ok: false, code: 'bad_days_before' }
  }
  if (patch.enabled !== undefined) writeKv('enabled', patch.enabled ? '1' : '0')
  if (patch.days_before !== undefined) writeKv('days_before', String(Number(patch.days_before)))
  if (patch.time !== undefined) writeKv('time', cleanTime(patch.time))
  return { ok: true, settings: getReminderSettings() }
}

export function getReminderStatus(channelReady: () => boolean = ownerChannelReady): ReminderStatus {
  const kv = readKv()
  const num = (k: string): number | null => (kv[k] != null && Number.isFinite(Number(kv[k])) ? Number(kv[k]) : null)
  return {
    ...getReminderSettings(),
    channel: channelReady() ? 'ok' : 'no_channel',
    last_sent_at: num('last_sent_at'),
    last_error: kv['last_error'] ?? null,
    last_error_at: num('last_error_at'),
  }
}

function ymd(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** A hatarido, amire MOST mar szolni kell: a legkesobbi nap, amelyiknek az emlekeztetoje elerkezett. */
export function remindUpTo(settings: ReminderSettings, now: Date): string {
  const [h, m] = settings.time.split(':').map(Number)
  const passed = now.getHours() * 60 + now.getMinutes() >= h * 60 + m
  // Ha a mai idopont elmult, a mai naptol `days_before` napra levo hatarido esedekes;
  // ha meg nem, csak az eggyel korabbi.
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate() + settings.days_before - (passed ? 0 : 1))
  return ymd(base)
}

export interface DueReminderRow {
  id: string
  text: string
  due_date: string
  project_name: string
  item_title: string
}

/**
 * A most esedekes emlekeztetok: nyitott, hataridos teendo, aktiv projektben,
 * a hatarido meg nem mult el (a lejartrol mar keso szolni), es erre a
 * hataridore meg nem ment ki emlekezteto.
 */
export function dueReminders(now = new Date(), settings = getReminderSettings()): DueReminderRow[] {
  ensureTodoTable()
  return getDb().prepare(`
    SELECT t.id, t.text, t.due_date, p.name AS project_name, COALESCE(w.title, '') AS item_title
      FROM work_item_todos t
      JOIN projects p ON p.id = t.project_id
      LEFT JOIN work_items w ON w.id = t.work_item_id
     WHERE t.done_at IS NULL
       AND t.due_date IS NOT NULL
       AND t.due_date >= ?
       AND t.due_date <= ?
       AND (t.reminded_for IS NULL OR t.reminded_for <> t.due_date)
       AND p.archived_at IS NULL
     ORDER BY t.due_date, p.name, t.created_at
  `).all(ymd(now), remindUpTo(settings, now)) as DueReminderRow[]
}

function dayLabel(due: string, today: string, lang: 'hu' | 'en'): string {
  const [y, m, d] = due.split('-').map(Number)
  const [ty, tm, td] = today.split('-').map(Number)
  const diff = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(ty, tm - 1, td)) / 86400000)
  if (diff === 0) return lang === 'en' ? 'today' : 'ma'
  if (diff === 1) return lang === 'en' ? 'tomorrow' : 'holnap'
  const date = new Date(y, m - 1, d).toLocaleDateString(lang === 'en' ? 'en-GB' : 'hu-HU', { weekday: 'long', month: 'long', day: 'numeric' })
  return date
}

/** Az uzenet szovege, a telepites nyelven. Sima szoveg, jelolonyelv nelkul. */
export function reminderText(rows: DueReminderRow[], now = new Date(), lang: 'hu' | 'en' = APP_LANG === 'en' ? 'en' : 'hu'): string {
  const today = ymd(now)
  const head = lang === 'en'
    ? (rows.length === 1 ? 'Reminder: a to-do on the Workbench is coming due.' : `Reminder: ${rows.length} to-dos on the Workbench are coming due.`)
    : (rows.length === 1 ? 'Emlékeztető: közeleg egy teendő határideje a Munkapadon.' : `Emlékeztető: ${rows.length} teendő határideje közeleg a Munkapadon.`)
  const lines = rows.slice(0, REMINDER_LIST_MAX).map((r) => {
    const where = r.item_title ? `${r.project_name} / ${r.item_title}` : r.project_name
    return `• ${dayLabel(r.due_date, today, lang)}: ${r.text} (${where})`
  })
  const more = rows.length - lines.length
  if (more > 0) lines.push(lang === 'en' ? `…and ${more} more on the Workbench.` : `…és még ${more} a Munkapadon.`)
  return [head, '', ...lines].join('\n')
}

export type ReminderRun =
  | { kind: 'off' }
  | { kind: 'nothing' }
  | { kind: 'no_channel'; pending: number }
  | { kind: 'backoff'; pending: number }
  | { kind: 'sent'; count: number }
  | { kind: 'failed'; pending: number; error: string }

let running = false

/**
 * Egy kor: ha van esedekes emlekezteto, EGY uzenetben kikuldi, es csak a
 * sikeres kuldes utan jeloli meg a teendoket (a hatarido pillanatnyi ertekere:
 * ha kozben atirtak, a teendo a kovetkezo korben ujra esedekes lehet).
 */
export async function runTodoReminders(
  now = new Date(),
  send: (text: string) => Promise<'sent' | 'no_channel'> = sendOwnerChannelChecked,
): Promise<ReminderRun> {
  if (running) return { kind: 'nothing' }
  running = true
  try {
    const settings = getReminderSettings()
    if (!settings.enabled) return { kind: 'off' }
    const rows = dueReminders(now, settings)
    if (!rows.length) return { kind: 'nothing' }
    const nowS = Math.floor(now.getTime() / 1000)
    const kv = readKv()
    const lastErrAt = Number(kv['last_error_at'])
    if (kv['last_error'] && Number.isFinite(lastErrAt) && nowS - lastErrAt < REMINDER_RETRY_AFTER_S) {
      return { kind: 'backoff', pending: rows.length }
    }
    let outcome: 'sent' | 'no_channel'
    try {
      outcome = await send(reminderText(rows, now))
    } catch (err) {
      const error = (err instanceof Error ? err.message : String(err)).slice(0, 300)
      writeKv('last_error', error)
      writeKv('last_error_at', String(nowS))
      return { kind: 'failed', pending: rows.length, error }
    }
    if (outcome === 'no_channel') return { kind: 'no_channel', pending: rows.length }
    const mark = getDb().prepare('UPDATE work_item_todos SET reminded_for = ? WHERE id = ? AND due_date = ?')
    getDb().transaction(() => { for (const r of rows) mark.run(r.due_date, r.id, r.due_date) })()
    writeKv('last_sent_at', String(nowS))
    writeKv('last_error', null)
    writeKv('last_error_at', null)
    return { kind: 'sent', count: rows.length }
  } finally {
    running = false
  }
}

export function startTodoReminderSweeper(onError?: (err: unknown) => void): NodeJS.Timeout {
  const run = (): void => { runTodoReminders().catch((err) => onError?.(err)) }
  const first = setTimeout(run, 45_000)
  if (typeof first.unref === 'function') first.unref()
  const t = setInterval(run, REMINDER_SWEEP_MS)
  if (typeof t.unref === 'function') t.unref()
  return t
}
