// Kanban 8382d142 -- "ne legyen ketszer fent."
//
// A valos eset (2026-09-06): a #134 kartyat KET vegrehajto csinalta meg
// parhuzamosan. Ket teljes megoldas szuletett ugyanarra a hibara, 11 masodperc
// kulonbseggel; a masodik mar utkozve erkezett a main-re, es kezzel kellett
// duplikatumkent lezarni. Egyik vegrehajto sem hibazott: a kiadas pillanataban
// SEMMI nem tudta megmondani, hogy azon a kartyan mar dolgozik valaki.
//
// Ez a modul azt a hianyzo kerdest teszi fel a kiadas ELOTT: "erre a kartyara
// megy MOST munka, vagy landolt mar valami?"
//
// HAROM SZABALY, amit betart:
//
// 1. A kartya-hivatkozast a FORRASTOL kerdezi meg. A szovegben talalt `#134`
//    vagy `ab9d1f19` onmagaban csak egy karaktersor -- csak akkor szamit
//    kartyanak, ha a kanban tablaban tenyleg van ilyen, es EGYETLENEGY.
//
// 2. A NULLA KET DOLGOT JELENTHET. "Nincs korabbi munka" es "nem tudtam
//    megnezni" kulon valasz (`clear` vs `unknown`), es az `unknown` mindig
//    megmondja, MELYIK meres nem sikerult es mi volt a hibauzenet. Friss
//    telepitesen (ures tabla, meg egy task sincs) a valasz `clear` es NEMA --
//    ott tenyleg nincs mit jelenteni.
//
// 3. Csak azt tiltja, ami biztosan duplikatum. Egy FUTO vagy VARAKOZO masik
//    task ugyanarra a kartyara: elutasitas (felul lehet birni). Egy mar
//    LANDOLT munka: csak figyelmeztetes -- a folytatas (javitas, kovetkezo
//    lepes) teljesen jogos, epp ilyen volt a #134 utani probe-munka is.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { APP_LANG, PROJECT_ROOT } from '../config.js'
import { getDb } from '../db.js'

const GIT = existsSync('/usr/bin/git') ? '/usr/bin/git' : 'git'
const GIT_ENV = { ...process.env, LC_ALL: 'C', LANGUAGE: 'C', GIT_TERMINAL_PROMPT: '0' }
/** Hany commit cimet nezunk vissza. Egy landolt munka ennel frissebb. */
const GIT_LOG_DEPTH = 300

export interface CardRef {
  /** A kartya teljes azonositoja. */
  cardId: string
  /** A sorszam, amit a felulet `#134`-kent mutat (a sor rowid-ja). */
  seq: number
  title: string
  status: string
  /** A szovegben talalt alak, amivel hivatkoztak ra ("#134" vagy "ab9d1f19"). */
  token: string
}

/** Egy kiadas, ami NEM kod-hid task: egy agensnek uzenetben atadott munka.
 *  Azert kell, mert a 2026-09-06-i duplikacio epp igy tortent: az egyik
 *  vegrehajto uzenetben kapta a feladatot (semmi nyoma nem volt a
 *  `code_tasks`-ban), a masik a kod-hidon. Egyik oldal sem lathatta a masikat. */
export interface CardClaimRef {
  id: number
  holder: string
  kind: string
  ref: string | null
  createdAt: number
  expiresAt: number
}

export interface ActiveTaskRef {
  id: string
  project: string
  status: string
  requestedBy: string | null
  createdAt: number
}

export interface LandedCommitRef {
  hash: string
  subject: string
}

export type CardWorkVerdict =
  /** Megmertuk: erre a kartyara most nem megy munka, es nem is landolt. */
  | { kind: 'clear'; refs: CardRef[] }
  /** Ugyanarra a kartyara MAR fut/var egy masik kiadas. */
  | { kind: 'active'; card: CardRef; tasks: ActiveTaskRef[]; claims: CardClaimRef[]; refs: CardRef[] }
  /** Erre a kartyara mar landolt munka a fo agon. */
  | { kind: 'landed'; card: CardRef; commits: LandedCommitRef[]; refs: CardRef[] }
  /** Nem tudtuk megmerni -- ez NEM ugyanaz, mint hogy nincs semmi. */
  | { kind: 'unknown'; refs: CardRef[]; detail: string }

/** Meddig el egy bejelentett munkavegzes magatol. Egy vegrehajto, aki soha nem
 *  jelent vissza (osszeomlott, kifutott a kerete), nem zarhatja le a kartyat
 *  orokre -- de a tipikus feladat alatt vegig ervenyes marad. */
export const CARD_CLAIM_TTL_MS = 6 * 60 * 60 * 1000

// A "kesz vagyok" jelzot a DB-PELDANYHOZ kotjuk, nem egy bool-hoz: egy
// ujrainicializalt adatbazis (teszt, vagy egy uj store) mas peldany, es egy
// modul-szintu `true` ott "letezik a tabla"-t hazudna egy ures DB-re.
let claimTableDb: unknown = null
function ensureClaimTable(): void {
  const db = getDb()
  if (claimTableDb === db) return
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS card_work_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id TEXT NOT NULL,
      holder TEXT NOT NULL,
      kind TEXT NOT NULL,
      ref TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      released_at INTEGER
    )
  `)
  getDb().exec('CREATE INDEX IF NOT EXISTS idx_card_claims_card ON card_work_claims(card_id, expires_at)')
  claimTableDb = db
}

/** Bejelenti, hogy `holder` MOST dolgozik ezen a kartyan. Ugyanaz a holder
 *  ugyanarra a kartyara nem duplazza a sort -- csak megujitja a sajatjat. */
export function claimCardWork(input: { cardId: string; holder: string; kind: string; ref?: string | null; ttlMs?: number }): CardClaimRef {
  ensureClaimTable()
  const now = Date.now()
  const expiresAt = now + (input.ttlMs ?? CARD_CLAIM_TTL_MS)
  const existing = getDb().prepare(
    `SELECT id FROM card_work_claims
      WHERE card_id = ? AND holder = ? AND released_at IS NULL AND expires_at > ?
      ORDER BY id DESC LIMIT 1`,
  ).get(input.cardId, input.holder, now) as { id: number } | undefined
  if (existing) {
    getDb().prepare('UPDATE card_work_claims SET expires_at = ?, ref = COALESCE(?, ref) WHERE id = ?')
      .run(expiresAt, input.ref ?? null, existing.id)
    return listCardClaims(input.cardId).find(c => c.id === existing.id)!
  }
  const info = getDb().prepare(
    'INSERT INTO card_work_claims (card_id, holder, kind, ref, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(input.cardId, input.holder, input.kind, input.ref ?? null, now, expiresAt)
  return { id: Number(info.lastInsertRowid), holder: input.holder, kind: input.kind, ref: input.ref ?? null, createdAt: now, expiresAt }
}

/** A munka vege: a bejelentes lezarul, es tobbe nem all senki utjaba. */
export function releaseCardWork(opts: { cardId: string; holder: string }): number {
  ensureClaimTable()
  return getDb().prepare(
    'UPDATE card_work_claims SET released_at = ? WHERE card_id = ? AND holder = ? AND released_at IS NULL',
  ).run(Date.now(), opts.cardId, opts.holder).changes
}

/** Az ELO bejelentesek egy kartyan (lejart es lezart nelkul). */
export function listCardClaims(cardId: string): CardClaimRef[] {
  ensureClaimTable()
  const rows = getDb().prepare(
    `SELECT id, holder, kind, ref, created_at, expires_at FROM card_work_claims
      WHERE card_id = ? AND released_at IS NULL AND expires_at > ?
      ORDER BY created_at ASC`,
  ).all(cardId, Date.now()) as { id: number; holder: string; kind: string; ref: string | null; created_at: number; expires_at: number }[]
  return rows.map(r => ({ id: r.id, holder: r.holder, kind: r.kind, ref: r.ref, createdAt: r.created_at, expiresAt: r.expires_at }))
}

/**
 * A szovegben elofordulo lehetseges kartya-hivatkozasok, MEG feloldas elott.
 * A `#134` alak es a 8-32 jegyu hexa azonosito (`ab9d1f19`) egyarant szamit.
 */
export function extractCardTokens(text: string): { seqs: number[]; ids: string[] } {
  const seqs = new Set<number>()
  const ids = new Set<string>()
  for (const m of text.matchAll(/#(\d{1,6})\b/g)) seqs.add(Number(m[1]))
  for (const m of text.matchAll(/\b([0-9a-f]{8,32})\b/gi)) ids.add(m[1].toLowerCase())
  return { seqs: [...seqs], ids: [...ids] }
}

/**
 * A hivatkozasok feloldva a kanban tablabol. Ami nem oldodik fel EGYETLEN
 * kartyara, az nem kartya-hivatkozas -- egy commit-hash vagy egy PR-szam nem
 * valhat "kartyava" attol, hogy hasonlit ra.
 */
export function resolveCardRefs(text: string): CardRef[] {
  const { seqs, ids } = extractCardTokens(text)
  if (seqs.length === 0 && ids.length === 0) return []

  const db = getDb()
  const out = new Map<string, CardRef>()

  for (const seq of seqs) {
    const row = db.prepare(
      'SELECT rowid AS seq, id, title, status FROM kanban_cards WHERE rowid = ? AND archived_at IS NULL',
    ).get(seq) as { seq: number; id: string; title: string; status: string } | undefined
    if (row) out.set(row.id, { cardId: row.id, seq: row.seq, title: row.title, status: row.status, token: `#${seq}` })
  }

  for (const id of ids) {
    // Csak EGYERTELMU prefix szamit: ket talalatnal a talalgatas rossz kartyara
    // mutatna, es egy rossz kartya-hivatkozas rosszabb, mint semmi.
    const rows = db.prepare(
      'SELECT rowid AS seq, id, title, status FROM kanban_cards WHERE id LIKE ? AND archived_at IS NULL LIMIT 2',
    ).all(`${id}%`) as { seq: number; id: string; title: string; status: string }[]
    if (rows.length !== 1) continue
    const row = rows[0]!
    if (!out.has(row.id)) out.set(row.id, { cardId: row.id, seq: row.seq, title: row.title, status: row.status, token: id })
  }

  return [...out.values()]
}

/** Egy szoveg hivatkozik-e erre a kartyara (sorszammal vagy azonosito-prefixszel). */
function textMentionsCard(text: string, card: CardRef): boolean {
  const { seqs, ids } = extractCardTokens(text)
  if (seqs.includes(card.seq)) return true
  return ids.some(id => card.cardId.toLowerCase().startsWith(id))
}

/**
 * Egy commit CIME errol a kartyarol szol-e?
 *
 * Csak a HATOKOR-helyen allo szam szamit (`feat(134): ...`) vagy a kartya
 * azonositoja. A cim VEGEN allo `(#28)` a PR szama -- ha azt is beszamitanank,
 * majdnem minden commit "landolt munka" lenne valamelyik kartyan.
 */
export function subjectMentionsCard(subject: string, card: { seq: number; cardId: string }): boolean {
  const scope = new RegExp(`^[a-z]+\\(([^)]*\\b)?#?${card.seq}\\)`, 'i')
  if (scope.test(subject)) return true
  return subject.toLowerCase().includes(card.cardId.slice(0, 8).toLowerCase())
}

/**
 * Landolt-e mar munka erre a kartyara a fo agon?
 *
 * A commit CIMEBEN keressuk a kartyat, de CSAK a hatokor-helyen
 * (`feat(134): ...`) vagy a kartya azonositojaval -- a cim VEGEN allo `(#28)`
 * a PR szama, nem kartyaszam, es ha azt is beszamitanank, majdnem minden
 * commit talalat lenne.
 */
function landedCommits(card: CardRef): { ok: true; commits: LandedCommitRef[] } | { ok: false; detail: string } {
  let ref = ''
  for (const candidate of ['origin/main', 'origin/master', 'HEAD']) {
    try {
      execFileSync(GIT, ['rev-parse', '--verify', '--quiet', candidate], {
        cwd: PROJECT_ROOT, timeout: 5_000, encoding: 'utf-8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'],
      })
      ref = candidate
      break
    } catch { /* a kovetkezo jelolt */ }
  }
  // Nincs egyetlen olvashato ag sem: ez "nem latok oda", nem "nincs semmi".
  if (!ref) return { ok: false, detail: 'nincs olvashato git ag (origin/main, origin/master, HEAD)' }

  let out = ''
  try {
    out = execFileSync(GIT, ['log', `-n${GIT_LOG_DEPTH}`, '--format=%h%x00%s', ref], {
      cwd: PROJECT_ROOT, timeout: 10_000, encoding: 'utf-8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    const text = err instanceof Error ? `${err.message}` : String(err)
    return { ok: false, detail: text.slice(0, 200) }
  }

  const commits: LandedCommitRef[] = []
  for (const line of out.split('\n')) {
    if (!line) continue
    const [hash, subject = ''] = line.split('\0')
    if (subjectMentionsCard(subject, card)) {
      commits.push({ hash: hash!, subject })
      if (commits.length >= 3) break
    }
  }
  return { ok: true, commits }
}

export interface CardWorkOptions {
  /** Ezt a taskot ne szamitsa magaval szembe (pl. ujraindulaskor). */
  ignoreTaskId?: string
  /** Csak az aktiv kiadast nezze -- a git-lekerdezes nelkul (gyors ut). */
  skipLanded?: boolean
  /** Ennek a bejelentonek a sajat munkaja nem utkozes onmagaval. */
  ignoreHolder?: string
}

/**
 * A kiadas elotti kerdes: megy-e mar munka erre a kartyara?
 *
 * A hivo NEM kap "nincs semmi" valaszt olyankor, amikor a meres maga nem
 * sikerult -- arra kulon `unknown` ag van, a tenyleges hibauzenettel.
 */
export function checkCardWork(text: string, opts: CardWorkOptions = {}): CardWorkVerdict {
  const refs = resolveCardRefs(text)
  if (refs.length === 0) return { kind: 'clear', refs }

  // 1. Aktiv kiadas ugyanarra a kartyara. Ez a szigoru ag: ket egyszerre futo
  //    vegrehajto ugyanazon a kartyan biztosan duplikatum.
  let activeRows: { id: string; project: string; status: string; requested_by: string | null; created_at: number; prompt: string; card_ref: string | null }[]
  try {
    activeRows = getDb().prepare(
      `SELECT id, project, status, requested_by, created_at, prompt, card_ref
         FROM code_tasks WHERE status IN ('queued','running') ORDER BY created_at DESC LIMIT 50`,
    ).all() as typeof activeRows
  } catch (err) {
    // A tabla meg nem letezik (a kod-hidat meg soha nem hasznaltak), vagy nem
    // olvashato. Az elso esetben tenyleg nincs aktiv task -- ezt meg is tudjuk
    // kulonboztetni: a hianyzo tabla sajat hibauzenetet ad.
    const detail = err instanceof Error ? err.message : String(err)
    if (/no such table/i.test(detail)) return { kind: 'clear', refs }
    return { kind: 'unknown', refs, detail }
  }

  for (const card of refs) {
    const hits = activeRows.filter(r =>
      r.id !== opts.ignoreTaskId &&
      (r.card_ref === card.cardId || textMentionsCard(r.prompt, card)))
    const claims = listCardClaims(card.cardId).filter(c => c.holder !== opts.ignoreHolder)
    if (hits.length > 0 || claims.length > 0) {
      return {
        kind: 'active',
        card,
        refs,
        claims,
        tasks: hits.map(r => ({ id: r.id, project: r.project, status: r.status, requestedBy: r.requested_by, createdAt: r.created_at })),
      }
    }
  }

  if (opts.skipLanded) return { kind: 'clear', refs }

  // 2. Mar landolt munka. Ez CSAK figyelmeztetes: a folytatas jogos.
  for (const card of refs) {
    const landed = landedCommits(card)
    if (!landed.ok) return { kind: 'unknown', refs, detail: landed.detail }
    if (landed.commits.length > 0) return { kind: 'landed', card, commits: landed.commits, refs }
  }

  return { kind: 'clear', refs }
}

/** A figyelmeztetes ket alakja, szandekosan egyutt:
 *   - `key` + `params` -> a felulet a sajat nyelven mondja ki (t()),
 *   - `message`        -> aki NEM a feluleten ul (curl, agent-msg.sh, naplo),
 *     az is EMBERI mondatot lat, ne egy gepi kulcsot.
 *  Ugyanaz az elv, mint a CodeBridgeError `error` + `errorKey` parosanal. */
export interface CardWorkNotice {
  key: string
  params: Record<string, string>
  message: string
}

const NOTICE_TEXT: Record<string, { hu: string; en: string }> = {
  'cb.err.card_busy': {
    hu: 'Erre a kártyára ({card} -- {title}) MÁR fut egy kiadás: a(z) {task} feladat {status} állapotban van a(z) {project} projektben, {who} adta ki. Két végrehajtó ugyanazon a kártyán duplán dolgozna, ezért ezt nem küldöm el. Ha tudod, hogy a másik már nem dolgozik rajta, küldd el újra a "mégis" kapcsolóval.',
    en: 'This card ({card} -- {title}) ALREADY has a dispatch in flight: task {task} is {status} in project {project}, sent by {who}. Two executors on one card do the same work twice, so this one was not sent. If you know the other one has stopped, send it again with the "anyway" switch.',
  },
  'cb.warn.card_forced': {
    hu: 'Elküldtem, pedig a(z) {card} kártyán már fut a(z) {task} feladat -- te kérted, hogy mégis menjen.',
    en: 'Sent, even though task {task} is already running on card {card} -- you asked for it anyway.',
  },
  'cb.warn.card_active_msg': {
    hu: 'Elküldtem, de figyelem: a(z) {card} kártyán MÁR dolgozik valaki ({who} -- {what}). Nézzétek meg, mielőtt két ügynök ugyanazt csinálja meg.',
    en: 'Sent, but heads up: someone is ALREADY working on card {card} ({who} -- {what}). Check before two agents do the same work twice.',
  },
  'cb.warn.card_landed': {
    hu: 'Figyelem: a(z) {card} kártyára már landolt munka a fő ágon ({commit} -- {subject}). Ha ez folytatás vagy javítás, minden rendben; ha nem tudtál róla, nézd meg, mielőtt kétszer csináljátok meg.',
    en: 'Heads up: work for card {card} has already landed on the main branch ({commit} -- {subject}). If this is a follow-up or a fix, all good; if you did not know about it, check before it gets done twice.',
  },
  'cb.warn.card_uncheckable': {
    hu: 'Nem tudtam megnézni, dolgozik-e már valaki ezen a kártyán: {detail}. Elküldtem, de ezt nem ellenőriztem.',
    en: 'I could not check whether someone is already working on this card: {detail}. It was sent, but this was not verified.',
  },
}

/** Behelyettesitett, ember-olvashato mondat a telepites nyelven. Ismeretlen
 *  kulcsnal a kulcsot adja vissza -- az legalabb kereshetó, szemben egy ures
 *  sztringgel, ami ugy nezne ki, mintha nem lett volna figyelmeztetes. */
export function cardWorkNotice(key: string, params: Record<string, string>): CardWorkNotice {
  const row = NOTICE_TEXT[key]
  const raw = row ? (APP_LANG === 'en' ? row.en : row.hu) : key
  const message = raw.replace(/\{(\w+)\}/g, (m, name: string) => params[name] ?? m)
  return { key, params, message }
}
