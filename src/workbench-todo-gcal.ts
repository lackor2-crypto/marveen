/**
 * TEENDO A GOOGLE NAPTARBA (kanban #406, 14. pont, B valtozat).
 *
 * A tulajdonos a teendo soran egy gombbal beteheti a teendot a sajat Google
 * Naptaraba. Kikotesek (lackor2-bot dontese, msg 4580):
 *   - CSAK a tulajdonos kattintasara, teendonkent. Automatikus vagy tomeges
 *     iras nincs: ez a modul semmit nem ir magatol.
 *   - MINDEN iras a jovahagyasi kapun megy at: a `calendar_write` autonomia-
 *     kategoria szintje dont (3 = azonnal, 2 = jovahagyasi jegy, 1 = nem
 *     irunk). Olvashatatlan vagy hianyzo beallitas jogot NEM ad: jegy lesz.
 *   - Az esemeny azonositojat a teendon taroljuk; ujabb kattintas UGYANAZT az
 *     esemenyt frissiti, nem keszit masodikat.
 *   - Az .ics letoltes (PR #399) marad: az Google-fiok nelkul is mukodik.
 *
 * Jovahagyasnal a jegybe a PONTOS esemeny kerul (cim, nap, fiok), es dontes
 * utan pontosan az megy ki -- akkor is, ha a teendot kozben atirtak.
 *
 * Friss telepitesen nincs Google-fiok: a `gcalStatus()` ezt kulon allapotkent
 * mondja ki ('no_account'), es a felulet a gomb helyett a Varazslo Google-
 * lepesere mutat. A "nem tudtam megnezni" ('check_failed') ettol KULON all.
 */
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAIN_AGENT_ID, PROJECT_ROOT, STORE_DIR } from './config.js'
import { createAgentMessage, createApproval, getApproval, getDb } from './db.js'
import { loadAutonomyConfig, effectiveLevel } from './autonomy.js'
import { logger } from './logger.js'
import { getProject } from './projects.js'
import { getWorkItem } from './workbench.js'
import { ensureTodoTable, getTodo, nextDay, type TodoRow } from './workbench-todos.js'
import { accountsFromTokenStore } from './web/google-accounts.js'

export const GCAL_CATEGORY = 'calendar_write'
const CALENDAR_SCOPES = ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/calendar.events']
const EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events'
const REJECTED = new Set(['rejected', 'timeout', 'withdrawn', 'expired'])

type Lang = 'hu' | 'en'

export type GcalState = 'ready' | 'no_account' | 'no_scope' | 'check_failed'
export interface GcalStatus { state: GcalState; account: string | null }

/**
 * Van-e Google-fiok, amivel a naptarba irhatunk. A token-fajl HIANYA = nincs
 * fiok (friss telepites); az OLVASHATATLAN fajl = nem tudtuk megnezni.
 * A tokenek erteket nem olvassuk, csak a kulcsokat es a `scope` mezot.
 */
export function gcalStatus(storeDir = STORE_DIR): GcalStatus {
  const p = join(storeDir, 'google-tokens.json')
  if (!existsSync(p)) return { state: 'no_account', account: null }
  let data: Record<string, unknown>
  try { data = JSON.parse(readFileSync(p, 'utf-8')) } catch { return { state: 'check_failed', account: null } }
  if (!data || typeof data !== 'object') return { state: 'check_failed', account: null }
  const accounts = accountsFromTokenStore(data)
  if (!accounts.length) return { state: 'no_account', account: null }
  const account = (accounts.find((a) => a.isDefault) || accounts[0]).id
  const entry = data[account] as { scope?: unknown } | undefined
  // A scope a jovahagyaskor dol el. Ha a mezo nincs meg (regi token), nem
  // talalgatunk: engedjuk, es az iras valodi hibaja mondja meg, ha baj van.
  if (entry && typeof entry.scope === 'string') {
    const scopes = entry.scope.split(/\s+/)
    if (!CALENDAR_SCOPES.some((s) => scopes.includes(s))) return { state: 'no_scope', account }
  }
  return { state: 'ready', account }
}

// --- kulso fuggosegek (tesztben csereljuk) -----------------------------------

export type TokenGetter = (account: string) => Promise<string>
export type HttpCall = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; text: string }>

const defaultToken: TokenGetter = (account) => new Promise((resolve, reject) => {
  execFile('python3', [join(PROJECT_ROOT, 'scripts', 'google-auth.py'), 'token', account], { timeout: 15_000 }, (err, stdout, stderr) => {
    if (err || !stdout.trim()) { reject(new Error((stderr || err?.message || 'no access token').trim().slice(0, 200))); return }
    resolve(stdout.trim())
  })
})

const defaultHttp: HttpCall = async (url, init) => {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) })
  return { status: r.status, text: await r.text() }
}

let tokenGetter: TokenGetter = defaultToken
let httpCall: HttpCall = defaultHttp
let statusReader: () => GcalStatus = () => gcalStatus()
let levelReader: () => number = defaultLevel

/** Csak teszteknek. Argumentum nelkul visszaallit. */
export function _setGcalDeps(d: { token?: TokenGetter; http?: HttpCall; status?: () => GcalStatus; level?: () => number } = {}): void {
  tokenGetter = d.token || defaultToken
  httpCall = d.http || defaultHttp
  statusReader = d.status || (() => gcalStatus())
  levelReader = d.level || defaultLevel
}

/** A kategoria szintje a fo agensre. Olvashatatlan config: 0 (= jegy kell). */
function defaultLevel(): number {
  try {
    const config = loadAutonomyConfig()
    const cat = config.categories.find((c) => c.key === GCAL_CATEGORY)
    return cat ? effectiveLevel(cat, MAIN_AGENT_ID, config) : 0
  } catch { return 0 }
}

// --- az esemeny -----------------------------------------------------------------

export interface GcalEventSnapshot { summary: string; description: string; date: string }

export function eventSnapshot(td: TodoRow, lang: Lang): GcalEventSnapshot | null {
  if (!td.due_date) return null
  const it = getWorkItem(td.work_item_id)
  const project = getProject(td.project_id)
  const L = (hu: string, en: string): string => (lang === 'en' ? en : hu)
  return {
    summary: td.text,
    description: L('Projekt: ', 'Project: ') + (project ? project.name : '') + '\n' + L('Munkadarab: ', 'Work item: ') + (it ? it.title : ''),
    date: td.due_date,
  }
}

function eventBody(todoId: string, ev: GcalEventSnapshot): string {
  return JSON.stringify({
    summary: ev.summary,
    description: ev.description,
    // Egesz napos esemeny: a vege KIZAROLAGOS, tehat a kovetkezo nap.
    start: { date: ev.date },
    end: { date: nextDay(ev.date) },
    transparency: 'transparent',
    extendedProperties: { private: { marveen_todo: todoId } },
  })
}

function setGcal(id: string, fields: Partial<Pick<TodoRow, 'gcal_event_id' | 'gcal_account' | 'gcal_approval_id' | 'gcal_synced_at' | 'gcal_error' | 'gcal_error_detail'>>): void {
  const keys = Object.keys(fields)
  if (!keys.length) return
  getDb().prepare(`UPDATE work_item_todos SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...keys.map((k) => (fields as Record<string, unknown>)[k] ?? null), id)
}

export type GcalWriteResult = { ok: true; event_id: string } | { ok: false; detail: string }

/**
 * Maga az iras. Ha a teendonek mar van esemenye UGYANABBAN a fiokban, azt
 * frissiti; ha a Google szerint az mar nincs meg (404/410 -- a tulajdonos
 * kitorolte), ujat keszit. Siker/hiba a teendon marad.
 */
export async function writeTodoEvent(todoId: string, account: string, ev: GcalEventSnapshot): Promise<GcalWriteResult> {
  ensureTodoTable()
  const td = getTodo(todoId)
  if (!td) return { ok: false, detail: 'to-do no longer exists' }
  let token: string
  try { token = await tokenGetter(account) } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    setGcal(todoId, { gcal_error: 'failed', gcal_error_detail: detail.slice(0, 300) })
    return { ok: false, detail }
  }
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const body = eventBody(todoId, ev)
  try {
    let r: { status: number; text: string } | null = null
    if (td.gcal_event_id && td.gcal_account === account) {
      r = await httpCall(`${EVENTS_URL}/${encodeURIComponent(td.gcal_event_id)}`, { method: 'PATCH', headers, body })
      if (r.status === 404 || r.status === 410) r = null
    }
    if (!r) r = await httpCall(EVENTS_URL, { method: 'POST', headers, body })
    if (r.status < 200 || r.status >= 300) {
      const detail = `Google Calendar ${r.status}: ${r.text.replace(/\s+/g, ' ').slice(0, 240)}`
      setGcal(todoId, { gcal_error: 'failed', gcal_error_detail: detail })
      return { ok: false, detail }
    }
    let id = ''
    try { id = String(JSON.parse(r.text).id || '') } catch { id = '' }
    if (!id) {
      const detail = 'Google Calendar answered without an event id'
      setGcal(todoId, { gcal_error: 'failed', gcal_error_detail: detail })
      return { ok: false, detail }
    }
    setGcal(todoId, { gcal_event_id: id, gcal_account: account, gcal_synced_at: Math.floor(Date.now() / 1000), gcal_error: null, gcal_error_detail: null })
    return { ok: true, event_id: id }
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    setGcal(todoId, { gcal_error: 'failed', gcal_error_detail: detail.slice(0, 300) })
    return { ok: false, detail }
  }
}

export type GcalRequestResult =
  | { ok: true; state: 'done'; event_id: string }
  | { ok: true; state: 'pending'; approval_id: string }
  | { ok: false; code: 'not_found' | 'no_due' | 'no_account' | 'no_scope' | 'check_failed' | 'blocked' | 'failed'; detail?: string }

/**
 * A tulajdonos kattintasa. A kategoria szintje dont: 3 = most irunk,
 * 1 = nem irunk (a felulet megmondja, hol lehet atallitani), minden mas =
 * jovahagyasi jegy. Nyitott jegynel nem nyitunk masodikat.
 */
export async function requestTodoCalendar(todoId: string, lang: Lang, actor: string | null): Promise<GcalRequestResult> {
  ensureTodoTable()
  const td = getTodo(todoId)
  if (!td) return { ok: false, code: 'not_found' }
  const ev = eventSnapshot(td, lang)
  if (!ev) return { ok: false, code: 'no_due' }
  const st = statusReader()
  if (st.state !== 'ready' || !st.account) return { ok: false, code: st.state === 'ready' ? 'no_account' : st.state }
  // Mar ugyanabban a fiokban van esemenye: annak a fioknak a frissitese.
  const account = td.gcal_event_id && td.gcal_account ? td.gcal_account : st.account

  if (td.gcal_approval_id) {
    const open = getApproval(td.gcal_approval_id)
    if (open && open.status === 'pending') return { ok: true, state: 'pending', approval_id: open.id }
  }

  const level = levelReader()
  if (level >= 3) {
    const w = await writeTodoEvent(td.id, account, ev)
    return w.ok ? { ok: true, state: 'done', event_id: w.event_id } : { ok: false, code: 'failed', detail: w.detail }
  }
  if (level === 1) return { ok: false, code: 'blocked' }

  const hu = lang !== 'en'
  const update = !!td.gcal_event_id
  const description = [
    hu ? `Munkapad: teendő ${update ? 'frissítése' : 'felvétele'} a Google Naptárba` : `Workbench: ${update ? 'update' : 'add'} a to-do in Google Calendar`,
    hu ? `Teendő: „${ev.summary}”` : `To-do: "${ev.summary}"`,
    hu ? `Nap: ${ev.date} (egész napos)` : `Day: ${ev.date} (all day)`,
    hu ? `Fiók: ${account}` : `Account: ${account}`,
    ev.description.replace(/\n/g, ' · '),
    actor ? (hu ? `Kérte: ${actor}` : `Requested by: ${actor}`) : '',
    hu ? 'Jóváhagyás után pontosan ez kerül a naptárba; elutasításnál semmi.' : 'After approval exactly this goes into the calendar; on rejection nothing.',
  ].filter(Boolean).join(' · ')
  const id = randomUUID()
  createApproval({
    id,
    agent_id: MAIN_AGENT_ID,
    category: GCAL_CATEGORY,
    action_description: description,
    action_payload: JSON.stringify({ source: 'workbench', tool: 'todo.gcal', project: td.project_id, workItem: td.work_item_id, todo: td.id, account, event: ev, actor }),
  })
  setGcal(td.id, { gcal_approval_id: id, gcal_error: null, gcal_error_detail: null })
  try {
    createAgentMessage('system', MAIN_AGENT_ID, [
      '[APPROVAL_REQUEST]', `id=${id}`, `agent=${MAIN_AGENT_ID}`, `category=${GCAL_CATEGORY}`, `action=${description}`, 'timeout_at=null',
    ].join(' '))
  } catch (err) {
    logger.warn({ err, approvalId: id }, 'workbench-todo-gcal: approval notification failed')
  }
  return { ok: true, state: 'pending', approval_id: id }
}

/**
 * A mar eldontott naptar-jegyek feldolgozasa: jovahagyott -> a jegyben tarolt
 * esemeny kimegy; elutasitott/lejart -> a teendon latszik. Egy jegy egy futas:
 * a sort atomian foglaljuk le (a jegy-azonosito nullazasa feltetelhez kotott).
 */
export async function settleTodoCalendarApprovals(): Promise<number> {
  ensureTodoTable()
  const rows = getDb().prepare('SELECT id, gcal_approval_id FROM work_item_todos WHERE gcal_approval_id IS NOT NULL').all() as { id: string; gcal_approval_id: string }[]
  let done = 0
  for (const row of rows) {
    const a = getApproval(row.gcal_approval_id)
    if (a && a.status === 'pending') continue
    const claimed = getDb().prepare('UPDATE work_item_todos SET gcal_approval_id = NULL WHERE id = ? AND gcal_approval_id = ?').run(row.id, row.gcal_approval_id).changes === 1
    if (!claimed) continue
    done++
    if (!a) { setGcal(row.id, { gcal_error: 'approval_missing' }); continue }
    if (REJECTED.has(a.status)) { setGcal(row.id, { gcal_error: 'rejected' }); continue }
    if (a.status !== 'approved') continue
    let p: { account?: unknown; event?: GcalEventSnapshot } = {}
    try { p = JSON.parse(a.action_payload || '{}') } catch { p = {} }
    const ev = p.event
    if (typeof p.account !== 'string' || !ev || typeof ev.date !== 'string' || typeof ev.summary !== 'string') {
      setGcal(row.id, { gcal_error: 'failed', gcal_error_detail: 'the approval carries no event' })
      continue
    }
    const w = await writeTodoEvent(row.id, p.account, { summary: ev.summary, description: String(ev.description || ''), date: ev.date })
    if (!w.ok) logger.warn({ todo: row.id, detail: w.detail }, 'workbench-todo-gcal: approved write failed')
  }
  return done
}
