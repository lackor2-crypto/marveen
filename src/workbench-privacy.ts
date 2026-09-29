/**
 * ADATVEDELEM A MUNKAPADON (kanban #441, v4 spec 7.3, K-1.32 ... K-1.34).
 *
 * "ERZEKENY" JELOLES (K-1.32), a szakmai minta szerint (erzekenysegi cimke a
 * tarolon es az elemen, mint a Microsoft Purview "sensitivity label"):
 *   - projekt VAGY munkadarab szintjen; a projekt jelolese minden munkadarabjara
 *     all (a munkadarab nem lehet kevesbe szigoru a projektjenel);
 *   - a Munkapad Agentje maga is kulso AI-szolgaltatas (Claude), a jeloles
 *     ezert NEM o kikapcsolasa (K-1.34), hanem a TOVABBI kulso szolgaltatasokra
 *     vonatkozik: internetes kereses, kulso kepszerkeszto/kepgenerator, kulso
 *     szovegfelismeres;
 *   - a szovegfelismeres mindig helyben fut (tesseract, K-1.5), kulso
 *     szovegfelismero es kepszolgaltatas ma nincs: az `externalServiceAllowed`
 *     az a kapu, amin egy jovobeli (K-2.11) atmegy;
 *   - az internetes keresesbe NEM kerulhet szemelyes adat (DLP-minta): a
 *     szerkezetes adatot (ugyszam, cim, szamlaszam, e-mail, telefon, szuletesi
 *     datum) mintaval, a NEVEKET pontos egyezessel (EDM) fogjuk meg -- a
 *     munkadarab irataiban es vazlataban szereplo nevek, meg a tulajdonos neve.
 *     Egy intezmeny ("Landgericht Berlin") nem nev: az nem allitja meg.
 *
 * KIMENO ADATOK NAPLOJA (K-1.33): milyen adat melyik szolgaltatashoz ment ki,
 * es mikor. A MEGLEVO naplokbol all ossze (Agent-beszelgetes, eszkozhivasok,
 * kod-hid feladatok, Google Naptar-iras), nem uj irasi pontokbol -- igy a mar
 * korabban kiment adat is latszik, es nincs ket igazsag.
 */
import { getDb } from './db.js'
import { currentOwnerName, OWNER_NAME_PLACEHOLDER } from './config.js'
import { getWorkItem } from './workbench.js'
import { findAddresses, findCaseNumbers, findNameCandidates, fold } from './workbench-doccheck.js'

let tablesDb: unknown = null

export function ensurePrivacyTables(): void {
  const db = getDb()
  if (tablesDb === db) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS wb_item_privacy (
      work_item_id TEXT PRIMARY KEY,
      sensitive INTEGER NOT NULL,
      set_at INTEGER NOT NULL,
      set_by TEXT
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS wb_project_privacy (
      project_id TEXT PRIMARY KEY,
      sensitive INTEGER NOT NULL,
      set_at INTEGER NOT NULL,
      set_by TEXT
    )
  `)
  tablesDb = db
}

const now = (): number => Math.floor(Date.now() / 1000)

export function projectSensitive(projectId: string): boolean {
  ensurePrivacyTables()
  const r = getDb().prepare('SELECT sensitive FROM wb_project_privacy WHERE project_id = ?').get(projectId) as { sensitive: number } | undefined
  return !!r && r.sensitive === 1
}

function itemFlag(itemId: string): boolean {
  ensurePrivacyTables()
  const r = getDb().prepare('SELECT sensitive FROM wb_item_privacy WHERE work_item_id = ?').get(itemId) as { sensitive: number } | undefined
  return !!r && r.sensitive === 1
}

export interface PrivacyState {
  /** A tenyleges allapot: a munkadarab VAGY a projektje erzekeny. */
  sensitive: boolean
  item: boolean
  project: boolean
}

export function privacyState(projectId: string, itemId: string | null): PrivacyState {
  const project = projectSensitive(projectId)
  const item = itemId ? itemFlag(itemId) : false
  return { sensitive: project || item, item, project }
}

export function setItemSensitive(itemId: string, on: boolean, by: string | null): void {
  ensurePrivacyTables()
  getDb().prepare(`INSERT INTO wb_item_privacy (work_item_id, sensitive, set_at, set_by) VALUES (?, ?, ?, ?)
    ON CONFLICT(work_item_id) DO UPDATE SET sensitive = excluded.sensitive, set_at = excluded.set_at, set_by = excluded.set_by`)
    .run(itemId, on ? 1 : 0, now(), by)
}

export function setProjectSensitive(projectId: string, on: boolean, by: string | null): void {
  ensurePrivacyTables()
  getDb().prepare(`INSERT INTO wb_project_privacy (project_id, sensitive, set_at, set_by) VALUES (?, ?, ?, ?)
    ON CONFLICT(project_id) DO UPDATE SET sensitive = excluded.sensitive, set_at = excluded.set_at, set_by = excluded.set_by`)
    .run(projectId, on ? 1 : 0, now(), by)
}

/** A projekt sajat jelolesu (erzekeny) munkadarabjai -- a lista jelvenyehez. */
export function sensitiveItemIds(projectId: string): string[] {
  ensurePrivacyTables()
  return (getDb().prepare(`SELECT p.work_item_id AS id FROM wb_item_privacy p JOIN work_items w ON w.id = p.work_item_id
    WHERE p.sensitive = 1 AND w.project_id = ?`).all(projectId) as { id: string }[]).map((r) => r.id)
}

// ---------------------------------------------------------------------------
// Kulso szolgaltatasok kapuja (K-1.32, K-1.34)
// ---------------------------------------------------------------------------

/** A Munkapad Agentjen (Claude) KIVULI szolgaltatasok fajtai. */
export type ExternalService = 'web_search' | 'image_edit' | 'image_generate' | 'ocr_external'

/**
 * Kaphat-e adatot egy kulso szolgaltatas ettol a munkadarabtol? Erzekenynel a
 * fajlt kapo szolgaltatas (kepszerkeszto, kepgenerator, kulso szovegfelismeres)
 * NEM; a kereses igen, de szemelyes adat nelkul (azt a `searchBlock` nezi).
 */
export function externalServiceAllowed(projectId: string, itemId: string | null, service: ExternalService): boolean {
  if (service === 'web_search') return true
  return !privacyState(projectId, itemId).sensitive
}

// ---------------------------------------------------------------------------
// Szemelyes adat egy (kereso)szovegben
// ---------------------------------------------------------------------------

export type PersonalDataKind = 'name' | 'case_number' | 'address' | 'iban' | 'account' | 'email' | 'phone' | 'birth_date'

export interface PersonalDataHit { kind: PersonalDataKind; value: string }

const UP = 'A-ZÁÉÍÓÖŐÚÜŰÄ'
const LOW = 'a-záéíóöőúüűäß'
const PATTERNS: { kind: PersonalDataKind; re: RegExp }[] = [
  { kind: 'iban', re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,4})?\b/g },
  { kind: 'account', re: /\b\d{8}-\d{8}(?:-\d{8})?\b/g },
  { kind: 'email', re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g },
  { kind: 'phone', re: /(?:\+|\b00)\d{1,3}[ /-]?\(?\d{1,4}\)?(?:[ /-]?\d{2,4}){2,4}\b|\b06[ /-]?\d{1,2}[ /-]?\d{3}[ /-]?\d{3,4}\b/g },
  { kind: 'birth_date', re: /\b(?:szül(?:etett|etési dátum|\.)?|geb(?:oren|urtsdatum|\.)|born|date of birth|DOB)\s*:?\s*[\d.\/ -]{6,12}\d/giu },
  // Utca + hazszam iranyitoszam nelkul is (a `findAddresses` iranyitoszamot ker).
  { kind: 'address', re: new RegExp(`[${UP}][${LOW}]+(?: [${UP}][${LOW}]+)? (?:utca|út|tér|körút|köz|sor|u\\.|krt\\.) \\d+[a-zA-Z/]*`, 'gu') },
  { kind: 'address', re: new RegExp(`[${UP}][${LOW}]+(?:straße|strasse|str\\.|weg|platz|allee|gasse) \\d+[a-zA-Z]*`, 'gu') },
  { kind: 'address', re: /\b\d{1,5} [A-Z][a-z]+(?: [A-Z][a-z]+)? (?:Street|St\.|Avenue|Ave\.|Road|Rd\.|Boulevard|Blvd\.|Lane|Drive)\b/g },
]

/** Nem szemelynev, ha ilyen szo van benne (intezmeny, ceg, hivatal, hely). */
const NOT_PERSON = new Set([
  'birosag', 'torvenyszek', 'kuria', 'hivatal', 'hatosag', 'ugyeszseg', 'kormanyhivatal', 'onkormanyzat', 'bank', 'kft', 'zrt', 'bt', 'nyrt', 'egyesulet', 'alapitvany',
  'gericht', 'landgericht', 'amtsgericht', 'oberlandesgericht', 'bundesgerichtshof', 'verwaltungsgericht', 'arbeitsgericht', 'sozialgericht', 'finanzgericht', 'behorde', 'amt', 'gmbh', 'ag', 'kg', 'ev', 'bundesamt', 'jobcenter', 'finanzamt',
  'court', 'district', 'county', 'state', 'department', 'office', 'inc', 'llc', 'ltd', 'corp', 'university', 'city', 'united', 'states', 'republic',
  'europai', 'europaischen', 'european', 'union', 'magyarorszag', 'deutschland', 'germany', 'hungary', 'budapest', 'berlin', 'wien', 'munchen',
])

function personLike(name: string): boolean {
  return !name.split(/[\s-]+/).some((w) => NOT_PERSON.has(fold(w)))
}

const KNOWN_NAMES_MAX = 500

/**
 * A munkadarabhoz tartozo, NEVEN ismert szemelyek (pontos egyezeshez): a
 * tulajdonos, es a munkadarab vazlataban, meg a mar elolvasott irataiban
 * biztosan nevkent allo, nem intezmeny-szeru kifejezesek.
 */
export function knownNames(itemId: string | null): string[] {
  const texts: string[] = []
  const owner = currentOwnerName()
  const out = new Map<string, string>()
  if (owner && owner !== OWNER_NAME_PLACEHOLDER && owner.trim().includes(' ')) out.set(fold(owner.trim()), owner.trim())
  if (itemId) {
    const db = getDb()
    const has = (t: string): boolean => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)
    if (has('wb_doc_sections') && has('wb_doc_blocks')) {
      for (const r of db.prepare('SELECT s.title AS t FROM wb_doc_sections s WHERE s.work_item_id = ?').all(itemId) as { t: string }[]) texts.push(r.t)
      for (const r of db.prepare('SELECT b.text AS t FROM wb_doc_blocks b JOIN wb_doc_sections s ON s.id = b.section_id WHERE s.work_item_id = ?').all(itemId) as { t: string }[]) texts.push(r.t)
    }
    if (has('work_item_assets') && has('doc_pages')) {
      const live = (db.prepare('PRAGMA table_info(work_item_assets)').all() as { name: string }[]).some((c) => c.name === 'removed_at') ? ' AND removed_at IS NULL' : ''
      for (const r of db.prepare(`SELECT p.text AS t FROM doc_pages p WHERE p.sha256 IN
        (SELECT sha256 FROM work_item_assets WHERE work_item_id = ?${live})`).all(itemId) as { t: string }[]) texts.push(r.t)
    }
  }
  for (const t of texts) {
    for (const c of findNameCandidates(t)) {
      if (!c.sure || !personLike(c.name)) continue
      const k = fold(c.name)
      if (!out.has(k)) out.set(k, c.name)
      if (out.size >= KNOWN_NAMES_MAX) break
    }
    if (out.size >= KNOWN_NAMES_MAX) break
  }
  return [...out.values()]
}

/** A szovegben allo szemelyes adatok: minta szerint + a megadott ismert nevek (pontos egyezes, ekezet es kisbetu nelkul). */
export function personalDataIn(text: string, names: string[]): PersonalDataHit[] {
  const t = String(text || '')
  const hits: PersonalDataHit[] = []
  const seen = new Set<string>()
  const push = (kind: PersonalDataKind, value: string): void => {
    const v = value.trim()
    const k = `${kind}:${fold(v)}`
    if (!v || seen.has(k)) return
    seen.add(k)
    hits.push({ kind, value: v })
  }
  for (const c of findCaseNumbers(t)) push('case_number', c)
  for (const a of findAddresses(t)) push('address', a.raw)
  for (const p of PATTERNS) for (const m of t.matchAll(p.re)) push(p.kind, m[0])
  const hay = ` ${fold(t).replace(/[^\p{L}\p{N}]+/gu, ' ')} `
  for (const n of names) {
    const needle = fold(n).replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    // A nev eleje szohatarra esik; a toldalekolt alak ("Kovács Annát") is talalat.
    if (needle && hay.includes(` ${needle}`)) push('name', n)
  }
  return hits
}

/**
 * Erzekeny munkadarabnal (vagy projektnel) a keresokifejezes nem vihet ki
 * szemelyes adatot. null = mehet; kulonben a talalt adatok (a hivo megmondja
 * az agentnek, mit kell kihagynia).
 */
export function searchBlock(projectId: string, itemId: string | null, query: string): PersonalDataHit[] | null {
  if (!privacyState(projectId, itemId).sensitive) return null
  const hits = personalDataIn(query, knownNames(itemId))
  return hits.length ? hits : null
}

// ---------------------------------------------------------------------------
// Kimeno adatok naploja (K-1.33)
// ---------------------------------------------------------------------------

export type EgressService = 'claude' | 'web_search' | 'claude_code' | 'google_calendar'

export interface EgressRow {
  /** Masodperc. */
  at: number
  service: EgressService
  /** A fiok (e-mail/nev), ha tudjuk; 'api_key' = API-kulccsal ment. */
  account: string | null
  /** Mi ment ki: `message_chars` + az abban a korben elolvasott fajlok; keresesnel a kifejezes; naptarnal a teendo. */
  message_chars?: number
  files?: string[]
  query?: string
  todo?: string
  due?: string | null
  status: 'sent' | 'blocked' | 'failed'
}

/** Az eszkozok, amelyek fajl-tartalmat adnak vissza (ami igy a Claude ele kerul). */
const READ_TOOLS = new Set(['file.read', 'document.read', 'document.pages', 'file.preview', 'source.verifyQuote'])
export const EGRESS_MAX = 300

function tableExists(t: string): boolean {
  return !!getDb().prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)
}

function pathOf(inputJson: string | null): string | null {
  try {
    const v = JSON.parse(inputJson || '{}') as Record<string, unknown>
    const p = v['path'] ?? v['file']
    return typeof p === 'string' && p.trim() ? p.trim() : null
  } catch { return null }
}

/** Mi ment ki ettol a munkadarabtol, melyik szolgaltatashoz, mikor -- a legujabb elol. */
export function egressLog(itemId: string): EgressRow[] {
  const item = getWorkItem(itemId)
  if (!item) return []
  const db = getDb()
  const rows: EgressRow[] = []
  const sessions = tableExists('workbench_agent_sessions')
    ? (db.prepare('SELECT id FROM workbench_agent_sessions WHERE work_item_id = ?').all(itemId) as { id: string }[]).map((r) => r.id)
    : []
  for (const sid of sessions) {
    const msgs = tableExists('workbench_agent_messages')
      ? db.prepare('SELECT role, content, created_at, via_kind, via_account FROM workbench_agent_messages WHERE session_id = ? ORDER BY created_at, rowid').all(sid) as
        { role: string; content: string; created_at: number; via_kind: string | null; via_account: string | null }[]
      : []
    const calls = tableExists('workbench_agent_tool_calls')
      ? db.prepare('SELECT tool_name, input_json, output_json, status, started_at FROM workbench_agent_tool_calls WHERE session_id = ? ORDER BY started_at, rowid').all(sid) as
        { tool_name: string; input_json: string | null; output_json: string | null; status: string; started_at: number }[]
      : []
    const users = msgs.filter((m) => m.role === 'user')
    const tasks = tableExists('code_tasks')
      ? (db.prepare("SELECT status, created_at FROM code_tasks WHERE origin = 'workbench' AND chat_id = ?").all(sid) as { status: string; created_at: number }[])
        .map((t) => ({ status: t.status, at: Math.floor(t.created_at / 1000) }))
      : []
    users.forEach((u, i) => {
      const end = i + 1 < users.length ? (users[i + 1] as { created_at: number }).created_at : Number.MAX_SAFE_INTEGER
      const reply = msgs.find((m) => m.role === 'assistant' && m.created_at >= u.created_at && m.created_at < end)
      const inTurn = calls.filter((c) => c.started_at >= u.created_at && c.started_at < end)
      const files = [...new Set(inTurn.filter((c) => READ_TOOLS.has(c.tool_name) && c.status === 'ok').map((c) => pathOf(c.input_json)).filter((p): p is string => !!p))]
      // A teljes erteku ugynok (kod-hid / elo Claude Code): kod-hid feladat tartozik a korhoz,
      // vagy a valasznak nincs "melyik fiokon ment" jelolese (azt csak a Munkapad Agentje irja).
      const task = tasks.find((t) => t.at >= u.created_at - 5 && t.at < end)
      const full = !!task || (!!reply && !reply.via_kind)
      rows.push({
        at: u.created_at, service: full ? 'claude_code' : 'claude',
        account: reply ? (reply.via_kind === 'api_key' ? 'api_key' : reply.via_account) : null,
        message_chars: u.content.length, files,
        // A kerdes kiment akkor is, ha valasz nem jott.
        status: task && task.status === 'error' ? 'failed' : 'sent',
      })
      for (const c of inTurn.filter((x) => x.tool_name === 'web.search')) {
        let q = ''
        try { q = String((JSON.parse(c.input_json || '{}') as Record<string, unknown>)['query'] ?? '') } catch { q = '' }
        const blocked = (c.output_json || '').includes('sensitive_personal_data')
        rows.push({ at: c.started_at, service: 'web_search', account: null, query: q, status: blocked ? 'blocked' : c.status === 'ok' ? 'sent' : 'failed' })
      }
    })
  }
  if (tableExists('work_item_todos')) {
    const cols = new Set((db.prepare('PRAGMA table_info(work_item_todos)').all() as { name: string }[]).map((c) => c.name))
    if (cols.has('gcal_event_id') && cols.has('gcal_synced_at')) {
      for (const t of db.prepare('SELECT text, due_date, gcal_account, gcal_synced_at FROM work_item_todos WHERE work_item_id = ? AND gcal_event_id IS NOT NULL').all(itemId) as
        { text: string; due_date: string | null; gcal_account: string | null; gcal_synced_at: number | null }[]) {
        const at = t.gcal_synced_at ?? 0
        rows.push({ at: at > 1e12 ? Math.floor(at / 1000) : at, service: 'google_calendar', account: t.gcal_account, todo: t.text, due: t.due_date, status: 'sent' })
      }
    }
  }
  rows.sort((a, b) => b.at - a.at)
  return rows.slice(0, EGRESS_MAX)
}
