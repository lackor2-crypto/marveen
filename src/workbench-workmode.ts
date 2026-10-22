// #758 (Boss TG 4399, 4421 "1A 2A 3A"): the WORK MODE of the Workbench assistant, written down in ONE place for the
// whole install, visible and editable by the owner (Settings -> AI Workbench -> Work mode), and growing by itself.
//
//   1A  The sheet lives in the database, not only in the code: the owner reads and edits it on the Settings page, and
//       the assistant gets it in every turn (context.ts). Never saved = the built-in default in the UI language, so a
//       fresh install has the full sheet without any setup.
//   2A  The assistant does NOT write the sheet. It PROPOSES a rule (workmode.propose) with the reason; the owner sees
//       the preview (the rule and the whole sheet after it) and the rule goes in only on "Elfogadom" / "Accept".
//   3A  The machine check after a move / finalize / upload is in workbench-placement-check.ts.
import { randomUUID } from 'node:crypto'
import { getDb } from './db.js'

export const WORKMODE_MAX_CHARS = 8_000
export const WORKMODE_RULE_MAX_CHARS = 600
export const WORKMODE_REASON_MAX_CHARS = 400
/** More open proposals than this is not "a suggestion" any more: the owner has to decide the old ones first. */
export const WORKMODE_MAX_PENDING = 20
/** What goes into one turn of the assistant (the sheet itself may be longer; the owner sees all of it). */
export const WORKMODE_IN_CONTEXT = 3_500

export const DEFAULT_WORKMODE: Record<'hu' | 'en', string> = {
  hu: `MUNKAMÓD -- így dolgozik az asszisztens minden munkadarabban

1. Kontextus-fájl, Teendők, Kutatás -- kérés nélkül, minden fordulóban
- Ami új tudnivaló (feltöltés, elolvasott irat, döntés, határidő, amit a tulajdonos mond), az azonnal a munkadarab kontextus-fájljába kerül.
- Amivel még tenni kell valamit (csatolandó melléklet, megerősítendő adat, határidő, elküldés), az a Teendők közé kerül; ami kész, azt kipipálom.
- Amit a neten találok és megérdemli, azt a Kutatásba mentem (a megnyitott munkadarabhoz kötve), a lényegét a kontextus-fájlba is beírom.

2. Amit egyszer megtaláltam, nem keresem újra
- Webes keresés előtt mindig a projekt Kutatását nézem meg (először a munkadarabhoz kötöttet). Csak akkor keresek, ha ott nincs meg, vagy elavult.

3. A mappák szerepe
- Feltöltések: amit a tulajdonos feltölt, változatlanul.
- Mellékletek: a beadvány mellé csatolt iratok (K1, Anlage 1, Exhibit A ...).
- Elkészített anyagok: csak a kész, végleges anyag (a végleges PDF és a hozzá generált melléklet-PDF-ek).
- Közös anyagok: ami több munkadarabhoz is kell; ezt belinkelem, nem másolom.
- Az "Agent" mappa fájljai csak nekem szóló hivatkozások: nem csatolom, nem másolom, nem mozgatom őket.

4. Vitáztatás
- Ha egy vitás kérdést több modellel kell körbejáratni, javaslom a tulajdonosnak a vitáztatást (a projekt oldalán kérhető; a kész vita a bal menü Vitáztatás oldalán látszik).
- A vita jelentése a munkadarab Vitáztatás mappájának Jelentés almappájába kerül, a külső vélemények mellé. Mielőtt újra válaszolok a kérdésre, a kész jelentést olvasom el.

5. Költöztetés az Életfába
- A mellékletek NEM mehetnek az Elkészített anyagok közé, és a kész anyag sem a Mellékletek közé (valós eset: 13 melléklet került rossz helyre).
- Elküldés előtt a levél anyaga nem költözik; a költöztetés előtt megnézem, mi hova menne, és ha bizonytalan, megkérdezem.

6. Önellenőrzés
- Költöztetés, véglegesítés és feltöltés után a rendszer gépileg megnézi, rossz helyen áll-e valami. Ha igen, szólok a tulajdonosnak a chatben: melyik fájl, miért, hova való. Magamtól nem mozdítok el semmit, ő dönt.

7. Önfejlődés
- Ha a tulajdonos kijavít vagy ugyanazt többször kéri, javaslatot teszek egy új szabályra ide (indoklással). A szabály csak akkor kerül fel, ha a tulajdonos elfogadja.`,
  en: `WORK MODE -- how the assistant works in every work item

1. Context file, To-dos, Research -- without being asked, in every turn
- Anything new to know (an upload, a document read, a decision, a deadline, what the owner says) goes into the work item's context file at once.
- Anything that still needs doing (an annex to attach, a fact to confirm, a deadline, the sending) goes on the to-do list; what is done gets ticked.
- What I find on the web and is worth keeping goes to Research (linked to the open work item), its gist into the context file as well.

2. What was found once is not searched again
- Before any web search I look at the project's Research (the work item's own first). I search only when it is not there or is out of date.

3. The folders and their roles
- Uploads: what the owner uploads, unchanged.
- Attachments: the documents attached to the filing (K1, Anlage 1, Exhibit A ...).
- Finished materials: only the finished, final material (the final PDF and the annex PDFs made for it).
- Shared materials: what several work items need; I link it, I do not copy it.
- The files of the "Agent" folder are references meant only for me: I never attach, copy or move them.

4. Debate
- When a disputed question should be put to several models, I suggest a debate to the owner (it is asked for on the project page; the finished debate shows on the Debate page of the left menu).
- The debate report goes into the Report subfolder of the work item's Debate folder, beside the outside opinions. Before I answer the question again, I read the finished report.

5. Moving into the Life tree
- Attachments must NOT go among the Finished materials, and finished material not among the Attachments (a real case: 13 attachments ended up in the wrong place).
- Before the letter is sent its material does not move; before a move I look at what would go where, and ask when unsure.

6. Self-check
- After a move, a finalisation and an upload the system machine-checks whether something lies in the wrong place. If so I tell the owner in the chat: which file, why, where it belongs. I never move anything by myself; the owner decides.

7. Learning
- When the owner corrects me or asks for the same thing again, I propose a new rule for this sheet (with the reason). The rule goes in only when the owner accepts it.`,
}

export interface WorkmodeState {
  text: string
  /** false = never saved: the built-in default (in the asked language) is shown and used. */
  custom: boolean
  updated_at: number | null
  updated_by: string | null
}

export interface WorkmodeProposal {
  id: string
  rule: string
  reason: string
  project_id: string | null
  work_item_id: string | null
  status: 'pending' | 'accepted' | 'rejected'
  created_at: number
  decided_at: number | null
  decided_by: string | null
}

export type WorkmodeCode =
  | 'workmode_text_required' | 'workmode_text_too_long'
  | 'workmode_rule_required' | 'workmode_rule_too_long' | 'workmode_reason_too_long'
  | 'workmode_too_many_pending' | 'workmode_duplicate' | 'workmode_not_found' | 'workmode_already_decided'

let tablesDb: unknown = null

export function ensureWorkmodeTables(): void {
  const db = getDb()
  if (tablesDb === db) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS workbench_workmode (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      updated_by TEXT
    );
    CREATE TABLE IF NOT EXISTS workbench_workmode_proposals (
      id TEXT PRIMARY KEY,
      rule TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      project_id TEXT,
      work_item_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      decided_at INTEGER,
      decided_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_workmode_proposals_status ON workbench_workmode_proposals(status, created_at);
  `)
  tablesDb = db
}

const nowSec = (): number => Math.floor(Date.now() / 1000)
const lang2 = (lang: unknown): 'hu' | 'en' => (lang === 'en' ? 'en' : 'hu')

export function getWorkmode(lang: unknown): WorkmodeState {
  ensureWorkmodeTables()
  const row = getDb().prepare("SELECT text, updated_at, updated_by FROM workbench_workmode WHERE id = 'main'").get() as
    { text: string; updated_at: number; updated_by: string | null } | undefined
  if (!row) return { text: DEFAULT_WORKMODE[lang2(lang)], custom: false, updated_at: null, updated_by: null }
  return { text: row.text, custom: true, updated_at: row.updated_at, updated_by: row.updated_by }
}

function writeSheet(text: string, by: string | null): void {
  getDb().prepare(`INSERT INTO workbench_workmode (id, text, updated_at, updated_by) VALUES ('main', ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
    .run(text, nowSec(), by)
}

export function setWorkmode(raw: unknown, by: string | null): { ok: true; state: WorkmodeState } | { ok: false; code: WorkmodeCode } {
  ensureWorkmodeTables()
  const text = String(raw ?? '').replace(/\r\n/g, '\n').trim()
  if (!text) return { ok: false, code: 'workmode_text_required' }
  if (text.length > WORKMODE_MAX_CHARS) return { ok: false, code: 'workmode_text_too_long' }
  writeSheet(text, by)
  return { ok: true, state: getWorkmode('hu') }
}

/** Back to the built-in default: the saved sheet is dropped, the default in the UI language is used again. */
export function resetWorkmode(lang: unknown): WorkmodeState {
  ensureWorkmodeTables()
  getDb().prepare("DELETE FROM workbench_workmode WHERE id = 'main'").run()
  return getWorkmode(lang)
}

/** The sheet with one more rule at its end (what "Accept" will save; the preview shows exactly this). */
export function sheetWithRule(sheet: string, rule: string): string {
  const line = rule.trim().replace(/^[-*]\s*/, '')
  return `${sheet.replace(/\s+$/, '')}\n- ${line}`
}

export function proposeWorkmodeRule(input: { rule: unknown; reason?: unknown; projectId?: string | null; workItemId?: string | null }):
  { ok: true; proposal: WorkmodeProposal } | { ok: false; code: WorkmodeCode } {
  ensureWorkmodeTables()
  const rule = String(input.rule ?? '').replace(/\s+/g, ' ').trim()
  const reason = String(input.reason ?? '').replace(/\s+/g, ' ').trim()
  if (!rule) return { ok: false, code: 'workmode_rule_required' }
  if (rule.length > WORKMODE_RULE_MAX_CHARS) return { ok: false, code: 'workmode_rule_too_long' }
  if (reason.length > WORKMODE_REASON_MAX_CHARS) return { ok: false, code: 'workmode_reason_too_long' }
  const db = getDb()
  const pending = (db.prepare("SELECT COUNT(*) AS n FROM workbench_workmode_proposals WHERE status = 'pending'").get() as { n: number }).n
  if (pending >= WORKMODE_MAX_PENDING) return { ok: false, code: 'workmode_too_many_pending' }
  if (db.prepare("SELECT 1 FROM workbench_workmode_proposals WHERE status = 'pending' AND lower(rule) = lower(?)").get(rule)) {
    return { ok: false, code: 'workmode_duplicate' }
  }
  const p: WorkmodeProposal = {
    id: randomUUID(), rule, reason, project_id: input.projectId ?? null, work_item_id: input.workItemId ?? null,
    status: 'pending', created_at: nowSec(), decided_at: null, decided_by: null,
  }
  db.prepare('INSERT INTO workbench_workmode_proposals (id, rule, reason, project_id, work_item_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(p.id, p.rule, p.reason, p.project_id, p.work_item_id, p.status, p.created_at)
  return { ok: true, proposal: p }
}

export function listWorkmodeProposals(status: 'pending' | 'all' = 'pending'): WorkmodeProposal[] {
  ensureWorkmodeTables()
  const sql = status === 'pending'
    ? "SELECT * FROM workbench_workmode_proposals WHERE status = 'pending' ORDER BY created_at ASC"
    : 'SELECT * FROM workbench_workmode_proposals ORDER BY created_at DESC LIMIT 100'
  return getDb().prepare(sql).all() as WorkmodeProposal[]
}

/** The owner's click. Accept = the rule is added to the end of the CURRENT sheet (the default is saved first). */
export function decideWorkmodeProposal(id: unknown, accept: boolean, by: string | null, lang: unknown):
  { ok: true; proposal: WorkmodeProposal; state: WorkmodeState } | { ok: false; code: WorkmodeCode } {
  ensureWorkmodeTables()
  const db = getDb()
  const p = db.prepare('SELECT * FROM workbench_workmode_proposals WHERE id = ?').get(String(id ?? '')) as WorkmodeProposal | undefined
  if (!p) return { ok: false, code: 'workmode_not_found' }
  if (p.status !== 'pending') return { ok: false, code: 'workmode_already_decided' }
  const status = accept ? 'accepted' : 'rejected'
  const run = db.transaction(() => {
    if (accept) {
      const next = sheetWithRule(getWorkmode(lang).text, p.rule)
      if (next.length > WORKMODE_MAX_CHARS) return false
      writeSheet(next, by)
    }
    db.prepare('UPDATE workbench_workmode_proposals SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?').run(status, nowSec(), by, p.id)
    return true
  })
  if (!run()) return { ok: false, code: 'workmode_text_too_long' }
  return { ok: true, proposal: { ...p, status, decided_at: nowSec(), decided_by: by }, state: getWorkmode(lang) }
}

/** The block of the assistant's context: the sheet (clamped) and the open proposals, so it does not propose them again. */
export function workmodeForContext(lang: unknown): string {
  const st = getWorkmode(lang)
  const sheet = st.text.length > WORKMODE_IN_CONTEXT ? `${st.text.slice(0, WORKMODE_IN_CONTEXT)}\n[... the rest of the sheet is left out of this turn]` : st.text
  const pending = listWorkmodeProposals('pending')
  const open = pending.length
    ? `\nRules you already proposed and the owner has not decided yet (do not propose them again): ${pending.slice(0, 10).map((p) => `"${p.rule}"`).join('; ')}`
    : ''
  return `WORK MODE of the assistant (the owner's rule sheet, ${st.custom ? 'edited by the owner' : 'the built-in default'}; follow it in every turn):\n${sheet}${open}`
}
