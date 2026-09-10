// Kanban 2741d289 (#252) -- "ha a kartya le van zarva, oda mar ne irjunk tobbet."
//
// Boss hanguzenete (2026-09-10): "amig van kanban kartya, akkor a kanban
// kartyat kell figyelni, hogy ha az mar le van zarva, akkor oda mar nem irok
// tobbet."
//
// A PROBLEMA. A kod-hid (VS Code) egy feladatot mindig egy KONKRET
// beszelgetesbe ad ki, es az a beszelgetes a munka utan is ott marad nyitva. A
// kovetkezo kiadas -- akar egy MASIK agens kiadasa -- semmibol nem latja, hogy
// az a szal mar lezarult: a cset utolso uzenete tovabbra is egy befejezett
// munka eredmenye, ami ugy nez ki, mint egy elo temas beszelgetes. Igy megy a
// kovetkezo, mar mas temahoz tartozo feladat egy halott szalba.
//
// AMIT EZ A MODUL CSINAL. Amikor egy kanban kartya `done` lesz (barmelyik
// uton: a kanban mozgatas-vegponton VAGY a jovahagyas elfogadasakor), beir egy
// ZARO UZENETET abba a beszelgetesbe, amelyikben a kartya munkaja tenylegesen
// futott. Ettol a cset UTOLSO uzenete maga mondja ki, hogy le van zarva --
// tehat a kovetkezo dispatch (ember vagy agens) latja, hogy uj beszelgetest
// kell nyitnia.
//
// HAROM SZABALY, amit betart:
//
// 1. NEM TALALGAT, MELYIK BESZELGETES VOLT. A kapcsolat mar tarolva van:
//    `code_tasks.card_ref` = a kartya azonositoja, `code_tasks.session_id` =
//    a beszelgetes, amiben a munka FUTOTT (a `target_session_id` csak az volt,
//    ahova KERTEK). Ha egyik sincs meg, nem irunk sehova -- egy rossz szalba
//    kuldott "lezarva" rosszabb, mint a csend.
//
// 2. A NULLA KET DOLGOT JELENTHET. "Ezen a kartyan nem futott kod-hid munka"
//    (friss telepites: ez a normalis, es NEMA) es "nem latok ra arra a
//    projektre" (a worker all, vagy a mappa mar nincs kituzve) KET KULON
//    kimenet -- az utobbi a naploban is megnevezi, mi nem sikerult.
//
// 3. EGYSZER IR, NEM KETSZER. Ket ut vezet `done`-ra, es a kartya vissza-oda
//    is mozoghat. A (kartya, beszelgetes) parost egy sajat tabla jegyzi meg,
//    igy ugyanabba a csetbe nem megy ket zaro uzenet.
import { APP_LANG } from '../config.js'
import { getDb, getKanbanCard } from '../db.js'
import { logger } from '../logger.js'
import { enqueueCodeTask, resolveProject } from './code-bridge-store.js'

let ensured = false
function ensureTable(): void {
  if (ensured) return
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS code_session_close_notices (
      card_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      task_id TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (card_id, session_id)
    )
  `)
  ensured = true
}

/** Csak a tesztek hivjak: a tabla ujraletrehozasat kenyszeriti ki. */
export function _resetCloseNoticeTable(): void {
  ensured = false
}

/** Egy kod-hid feladat annyi resze, amennyi a zaro uzenethez kell. */
export interface CloseNoticeTaskRef {
  project: string
  /** Az a beszelgetes, amiben a munka FUTOTT (vagy ahova cimezve volt). */
  sessionId: string | null
  createdAt: number
}

export interface CloseNoticeCard {
  id: string
  /** A felulet `#252` sorszama. `null`, ha a sor nem adta vissza -- olyankor a
   *  szoveg a nyolc karakteres azonositoval hivatkozik a kartyara, es NEM
   *  talal ki egy sorszamot. */
  seq: number | null
  title: string
}

export type CloseNoticeOutcome =
  /** Kimeneteles: a zaro uzenet sorba allt ebbe a beszelgetesbe. */
  | { kind: 'sent'; project: string; sessionId: string; taskId: string }
  /** Nem futott kod-hid munka ezen a kartyan -- ez a normalis eset, nema. */
  | { kind: 'no-task' }
  /** Futott munka, de egyik feladat sem jegyezte fel, melyik beszelgetesben. */
  | { kind: 'no-session' }
  /** Mar kikuldtuk ugyanebbe a beszelgetesbe. */
  | { kind: 'already-sent'; sessionId: string }
  /** A projekt neve mar nem oldodik fel a SAJAT beszelgetesere. */
  | { kind: 'project-unreachable'; project: string; detail: string }
  /** Sorbaallitas kozben hiba: a kartya mozgatasat ez sosem allitja meg. */
  | { kind: 'enqueue-failed'; project: string; sessionId: string; detail: string }

const NOTICE_TEXT: Record<'hu' | 'en', string> = {
  hu:
    '🔒 LEZARVA. A(z) {cardLabel} kanban kartya ("{title}") jova lett hagyva, ' +
    'a hozza tartozo munka befejezodott.\n\n' +
    'Ez a beszelgetes ezzel lezarult. NE kezdj semmilyen uj munkaba ennek az uzenetnek a hatasara: ' +
    'valaszként eleg egyetlen rovid nyugta. Aki legkozelebb ide irna feladatot -- ember vagy agens -- ' +
    'annak UJ beszelgetest kell nyitnia, mert ez a szal mar nem az o temajahoz tartozik.',
  en:
    '🔒 CLOSED. Kanban card {cardLabel} ("{title}") has been approved and the work on it is finished.\n\n' +
    'This conversation is closed. Do NOT start any new work because of this message: ' +
    'a single short acknowledgement is enough as a reply. Whoever would send work here next -- human or agent -- ' +
    'must open a NEW conversation, because this thread no longer belongs to their topic.',
}

/** A zaro uzenet szovege a telepites nyelven. Kivul is lathato, hogy a teszt
 *  ne a szoveget masolja le, hanem ugyanabbol a forrasbol vegye. */
export function closeNoticeText(card: CloseNoticeCard, lang: string = APP_LANG): string {
  const raw = lang === 'en' ? NOTICE_TEXT.en : NOTICE_TEXT.hu
  // Az azonosito MINDIG ott van a sorszam mellett: Boss valos esete
  // (2026-08-11) az volt, hogy egy csupasz szamot a rossz keresobe irt be.
  const idWord = lang === 'en' ? 'kanban card id' : 'kanban-azonosito'
  const cardLabel = card.seq === null ? card.id : `#${card.seq} (${idWord}: ${card.id})`
  return raw
    .replace('{cardLabel}', cardLabel)
    .replace('{title}', card.title)
}

export interface CloseNoticeDeps {
  /** A kartyahoz tartozo kod-hid feladatok, LEGFRISSEBB eloszor. */
  tasksForCard: (cardId: string) => CloseNoticeTaskRef[]
  /** Feloldja-e a projekt neve MEG MINDIG a sajat beszelgetesere?
   *  `null` = nem latunk oda (vagy mar mas mappara oldodna fel). */
  resolveOwnProject: (project: string) => string | null
  /** Sorba allitja a zaro uzenetet a megadott beszelgetesbe. */
  enqueue: (input: { project: string; sessionId: string; prompt: string }) =>
    | { ok: true; taskId: string }
    | { ok: false; detail: string }
  wasSent: (cardId: string, sessionId: string) => boolean
  markSent: (cardId: string, sessionId: string, taskId: string) => void
}

/**
 * A dontes maga, mellekhatas-mentesen tesztelhetoen: MELYIK beszelgetesbe
 * (ha egyaltalan) menjen a zaro uzenet, es mi torteneik, ha nem tudunk odairni.
 */
export function runCodeSessionCloseNotice(card: CloseNoticeCard, deps: CloseNoticeDeps): CloseNoticeOutcome {
  const tasks = deps.tasksForCard(card.id)
  if (tasks.length === 0) return { kind: 'no-task' }

  const withSession = tasks.find((t) => (t.sessionId ?? '').trim().length > 0)
  if (!withSession) return { kind: 'no-session' }
  const sessionId = withSession.sessionId!.trim()

  if (deps.wasSent(card.id, sessionId)) return { kind: 'already-sent', sessionId }

  // A projekt nevet ujra fel kell oldani, MERT a kod-hid a nem kituzott nevet
  // egy MASIK, eppen elerheto beszelgetesre ejti vissza. Egy zaro uzenetnel ez
  // a legrosszabb, ami tortenhet: egy IDEGEN cset kapna egy "lezarva" sort.
  // Ezert itt nem engedunk vissza-eses: ha a nev nem SAJAT magara old fel,
  // inkabb nem irunk, es megmondjuk, miert.
  const resolvedProject = deps.resolveOwnProject(withSession.project)
  if (resolvedProject === null) {
    return {
      kind: 'project-unreachable',
      project: withSession.project,
      detail: 'a projekt neve nem oldodik fel a sajat beszelgetesere (nincs kituzve, vagy nem latunk oda)',
    }
  }

  const enq = deps.enqueue({
    project: resolvedProject,
    sessionId,
    prompt: closeNoticeText(card),
  })
  if (!enq.ok) {
    return { kind: 'enqueue-failed', project: resolvedProject, sessionId, detail: enq.detail }
  }
  deps.markSent(card.id, sessionId, enq.taskId)
  return { kind: 'sent', project: resolvedProject, sessionId, taskId: enq.taskId }
}

/** Az eles bekotes: SQLite + kod-hid sor. */
export function liveCloseNoticeDeps(): CloseNoticeDeps {
  return {
    tasksForCard: (cardId) => {
      ensureTable()
      const rows = getDb()
        .prepare(
          `SELECT project, COALESCE(session_id, target_session_id) AS sid, created_at
             FROM code_tasks
            WHERE card_ref = ? COLLATE NOCASE
            ORDER BY created_at DESC`,
        )
        .all(cardId) as { project: string; sid: string | null; created_at: number }[]
      return rows.map((r) => ({ project: r.project, sessionId: r.sid, createdAt: r.created_at }))
    },
    resolveOwnProject: (project) => {
      const r = resolveProject(project)
      if ('error' in r) return null
      // A visszaeses (`pickFallbackSession`) itt NEM ok: csak akkor irunk, ha a
      // nev sajat magara oldodott fel.
      return r.session.project === project ? r.session.project : null
    },
    enqueue: ({ project, sessionId, prompt }) => {
      // `force`: a kartya-orseg (card-work-guard) a mar landolt/futo munka miatt
      // elutasitana a kiadast -- de ez NEM munka, hanem egy lezaro kozlemeny,
      // ami epp azert megy ki, mert a munka befejezodott.
      const r = enqueueCodeTask({ project, sessionId, prompt, origin: 'api', requestedBy: 'kanban-close', force: true })
      if ('error' in r) return { ok: false, detail: r.error }
      return { ok: true, taskId: r.task.id }
    },
    wasSent: (cardId, sessionId) => {
      ensureTable()
      const row = getDb()
        .prepare('SELECT 1 FROM code_session_close_notices WHERE card_id = ? AND session_id = ?')
        .get(cardId, sessionId)
      return row !== undefined
    },
    markSent: (cardId, sessionId, taskId) => {
      ensureTable()
      getDb()
        .prepare(
          `INSERT OR REPLACE INTO code_session_close_notices (card_id, session_id, task_id, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(cardId, sessionId, taskId, Date.now())
    },
  }
}

/**
 * Best-effort bekotes a ket `done` utra. SOHA nem dobhat: a kartya mozgatasa
 * mar megtortent, es egy elmaradt zaro uzenet miatt nem bukhat el a keres.
 */
export function fireCodeSessionCloseNotice(cardId: string, deps: CloseNoticeDeps = liveCloseNoticeDeps()): void {
  try {
    const card = getKanbanCard(cardId)
    if (!card) return
    const outcome = runCodeSessionCloseNotice(
      { id: card.id, seq: card.seq ?? null, title: card.title },
      deps,
    )
    switch (outcome.kind) {
      case 'sent':
        logger.info(
          { cardId, project: outcome.project, session: outcome.sessionId.slice(0, 8), taskId: outcome.taskId.slice(0, 8) },
          'Kanban done: close notice queued into the VS Code conversation that did the work',
        )
        break
      case 'no-task':
        // Friss telepitesen ez a normalis: nem futott kod-hid munka. Nema.
        break
      case 'no-session':
        logger.info({ cardId }, 'Kanban done: code-bridge work exists but no conversation was recorded -- no close notice')
        break
      case 'already-sent':
        logger.debug({ cardId, session: outcome.sessionId.slice(0, 8) }, 'Kanban done: close notice already sent')
        break
      case 'project-unreachable':
        logger.warn({ cardId, project: outcome.project, detail: outcome.detail }, 'Kanban done: close notice NOT sent')
        break
      case 'enqueue-failed':
        logger.warn(
          { cardId, project: outcome.project, session: outcome.sessionId.slice(0, 8), detail: outcome.detail },
          'Kanban done: close notice could not be queued',
        )
        break
    }
  } catch (err) {
    logger.warn({ err, cardId }, 'Kanban done: close notice failed (the card move itself still succeeded)')
  }
}
