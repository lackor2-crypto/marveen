/**
 * Kanban 8382d142 -- "ne legyen ketszer fent".
 *
 * A valos eset (2026-09-06): ugyanarra a kartyara (#134) ket vegrehajto kapott
 * munkat. Az egyik a kod-hidon (`code_tasks` sor), a MASIK egy inter-agent
 * uzenetben -- annak semmi nyoma nem volt a task-tablaban. Mindketten
 * vegigcsinaltak, es a masodik PR utkozott a landolt elsovel.
 *
 * Amit ez a suite lezar:
 *   (a) a kiadas ELOTT megkerdezzuk a kartyat, es a MASODIK kiadas elakad,
 *   (b) az uzenetben kiadott munka is latszik (claim), nem csak a task,
 *   (c) a NULLA ket dolgot jelenthet: "meg nincs semmi" vs "nem lattam oda" --
 *       az utobbi kulon `unknown` ag, sose csendes zold,
 *   (d) a mondat EMBERI, nem gepi kod, es mindket nyelven megvan.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initDatabase, getDb, createKanbanCard } from '../db.js'
import {
  checkCardWork, resolveCardRefs, extractCardTokens, subjectMentionsCard,
  claimCardWork, releaseCardWork, listCardClaims, cardWorkNotice,
  CARD_CLAIM_TTL_MS,
} from '../web/card-work-guard.js'
import {
  resetCodeBridgeTablesForTests, upsertCodeSession, enqueueCodeTask, completeCodeTask, claimNextCodeTask,
} from '../web/code-bridge-store.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(join(__dirname, '../../', rel), 'utf-8')

const CARD_ID = 'ab9d1f19-0000-4000-8000-000000000134'
const OTHER_ID = 'cc001122-0000-4000-8000-000000000222'
const PROJ = { project: 'marvin', workspacePath: 'C:\\ws\\marvin', sessionId: 'aaaaaaaa-0000-4000-8000-000000000001' }

function seedCard(id = CARD_ID, title = 'A backfill mondja meg, miert nem tortent semmi'): number {
  createKanbanCard({ id, title, status: 'in_progress' })
  return getDb().prepare('SELECT rowid AS seq FROM kanban_cards WHERE id = ?').get(id) as unknown as number
}
function seqOf(id: string): number {
  return (getDb().prepare('SELECT rowid AS seq FROM kanban_cards WHERE id = ?').get(id) as { seq: number }).seq
}

beforeEach(() => {
  initDatabase(':memory:')
})

describe('kartya-hivatkozas felismerese', () => {
  it('a sorszamot es az azonosito-prefixet is megtalalja', () => {
    const { seqs, ids } = extractCardTokens('a #134 kartyan dolgozom, id: ab9d1f19')
    expect(seqs).toContain(134)
    expect(ids).toContain('ab9d1f19')
  })

  it('csak VALODI kartyara oldja fel -- egy PR-szam nem lesz kartya', () => {
    seedCard()
    const seq = seqOf(CARD_ID)
    expect(resolveCardRefs(`munka a #${seq} kartyan`).map(r => r.cardId)).toEqual([CARD_ID])
    // A tablaban nincs ilyen rowid: a szam marad szam.
    expect(resolveCardRefs('lasd a #999999 hivatkozast')).toEqual([])
  })

  it('ket kartyara illeszkedo prefixet NEM talalgat meg', () => {
    createKanbanCard({ id: 'deadbeef-1111-4000-8000-000000000001', title: 'egyik' })
    createKanbanCard({ id: 'deadbeef-2222-4000-8000-000000000002', title: 'masik' })
    expect(resolveCardRefs('a deadbeef kartya')).toEqual([])
  })

  it('az archivalt kartya nem allitja meg a munkat', () => {
    seedCard()
    getDb().prepare('UPDATE kanban_cards SET archived_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000), CARD_ID)
    expect(resolveCardRefs(`#${seqOf(CARD_ID)}`)).toEqual([])
  })
})

describe('friss telepites: a nulla ket dolgot jelenthet', () => {
  it('nincs kod-hid tabla -> ez tenyleg "meg nincs semmi", nem hiba', () => {
    seedCard()
    // Szandekosan NEM hivunk resetCodeBridgeTablesForTests()-et: a code_tasks
    // tabla nem letezik, mint egy friss telepitesen.
    const v = checkCardWork(`#${seqOf(CARD_ID)}`, { skipLanded: true })
    expect(v.kind).toBe('clear')
  })

  it('olvashatatlan tabla -> "nem lattam oda", a valodi hibauzenettel', () => {
    seedCard()
    // Van code_tasks, de nem az, amit varunk: a lekerdezes elhasal. Ez NEM
    // ugyanaz, mint hogy nincs aktiv munka -- kulon agnak kell lennie.
    getDb().exec('CREATE TABLE code_tasks (id TEXT)')
    const v = checkCardWork(`#${seqOf(CARD_ID)}`, { skipLanded: true })
    expect(v.kind).toBe('unknown')
    if (v.kind === 'unknown') expect(v.detail).toMatch(/no such column/i)
  })

  it('hivatkozas nelkuli szoveg nem all meg semmin', () => {
    resetCodeBridgeTablesForTests()
    expect(checkCardWork('csinald meg a bejelentkezest').kind).toBe('clear')
  })
})

describe('masodik kiadas ugyanarra a kartyara', () => {
  beforeEach(() => {
    resetCodeBridgeTablesForTests()
    upsertCodeSession(PROJ)
  })

  it('a kod-hid elutasitja a masodikat, EMBERI mondattal', () => {
    seedCard()
    const seq = seqOf(CARD_ID)
    const first = enqueueCodeTask({ project: 'marvin', prompt: `Csinald meg a #${seq} kartyat`, origin: 'dashboard', requestedBy: 'boss' })
    expect('task' in first).toBe(true)

    const second = enqueueCodeTask({ project: 'marvin', prompt: `Meg egyszer a #${seq}`, origin: 'dashboard', requestedBy: 'marvin' })
    expect('error' in second).toBe(true)
    if ('error' in second) {
      expect(second.errorKey).toBe('cb.err.card_busy')
      // A hivo EMBERI mondatot lat: benne a kartya, nem egy gepi kod.
      expect(second.error).toContain(`#${seq}`)
      expect(second.error).not.toMatch(/^[a-z_.]+$/)
      expect(second.error.length).toBeGreaterThan(40)
    }
  })

  it('a "megis" kapcsolo atengedi, de MEGMONDJA', () => {
    seedCard()
    const seq = seqOf(CARD_ID)
    enqueueCodeTask({ project: 'marvin', prompt: `#${seq} elso`, origin: 'dashboard', requestedBy: 'boss' })
    const forced = enqueueCodeTask({ project: 'marvin', prompt: `#${seq} masodik`, origin: 'dashboard', requestedBy: 'boss', force: true })
    expect('task' in forced).toBe(true)
    if ('task' in forced) {
      expect(forced.warning?.key).toBe('cb.warn.card_forced')
      expect(forced.warning?.message).toContain(`#${seq}`)
    }
  })

  it('a befejezett task mar nem all utban', () => {
    seedCard()
    const seq = seqOf(CARD_ID)
    const first = enqueueCodeTask({ project: 'marvin', prompt: `#${seq} elso`, origin: 'dashboard', requestedBy: 'boss' })
    if (!('task' in first)) throw new Error('elso kiadas nem sikerult')
    const claimed = claimNextCodeTask('marvin', 'worker')
    expect(claimed?.id).toBe(first.task.id)
    completeCodeTask(first.task.id, { ok: true, result: 'kesz' })
    const again = enqueueCodeTask({ project: 'marvin', prompt: `#${seq} folytatas`, origin: 'dashboard', requestedBy: 'boss' })
    expect('task' in again).toBe(true)
  })

  it('MAS kartya nem utkozik', () => {
    seedCard()
    createKanbanCard({ id: OTHER_ID, title: 'masik munka' })
    const a = seqOf(CARD_ID), b = seqOf(OTHER_ID)
    enqueueCodeTask({ project: 'marvin', prompt: `#${a}`, origin: 'dashboard', requestedBy: 'boss' })
    expect('task' in enqueueCodeTask({ project: 'marvin', prompt: `#${b}`, origin: 'dashboard', requestedBy: 'boss' })).toBe(true)
  })

  it('a kartya a taskhoz van rogzitve (card_ref), nem csak a prompt szovegeben', () => {
    seedCard()
    const seq = seqOf(CARD_ID)
    const first = enqueueCodeTask({ project: 'marvin', prompt: `#${seq} munka`, origin: 'dashboard', requestedBy: 'boss' })
    if (!('task' in first)) throw new Error('kiadas nem sikerult')
    expect(first.task.cardRef).toBe(CARD_ID)
  })
})

describe('uzenetben kiadott munka is latszik (a valos duplikacio utja)', () => {
  beforeEach(() => { resetCodeBridgeTablesForTests(); upsertCodeSession(PROJ) })

  it('egy bejelentett (claim) munka megallitja a kod-hid kiadast', () => {
    seedCard()
    const seq = seqOf(CARD_ID)
    claimCardWork({ cardId: CARD_ID, holder: 'vscode-tab', kind: 'message', ref: '1989' })
    const out = enqueueCodeTask({ project: 'marvin', prompt: `#${seq} csinald meg`, origin: 'dashboard', requestedBy: 'boss' })
    expect('error' in out).toBe(true)
    if ('error' in out) expect(out.errorKey).toBe('cb.err.card_busy')
  })

  it('a sajat bejelentesed nem utkozes onmagaddal', () => {
    seedCard()
    claimCardWork({ cardId: CARD_ID, holder: 'usalackor', kind: 'message' })
    const v = checkCardWork(`#${seqOf(CARD_ID)}`, { skipLanded: true, ignoreHolder: 'usalackor' })
    expect(v.kind).toBe('clear')
  })

  it('ugyanaz a gazda nem duplazza a sort, csak megujitja', () => {
    seedCard()
    claimCardWork({ cardId: CARD_ID, holder: 'vscode-tab', kind: 'message' })
    claimCardWork({ cardId: CARD_ID, holder: 'vscode-tab', kind: 'message' })
    expect(listCardClaims(CARD_ID)).toHaveLength(1)
  })

  it('a felszabaditas utan ujra szabad a kartya', () => {
    seedCard()
    claimCardWork({ cardId: CARD_ID, holder: 'vscode-tab', kind: 'message' })
    expect(releaseCardWork({ cardId: CARD_ID, holder: 'vscode-tab' })).toBe(1)
    expect(checkCardWork(`#${seqOf(CARD_ID)}`, { skipLanded: true }).kind).toBe('clear')
  })

  it('egy osszeomlott vegrehajto nem zarja le a kartyat orokre (TTL)', () => {
    seedCard()
    claimCardWork({ cardId: CARD_ID, holder: 'halott-agens', kind: 'message', ttlMs: -1 })
    expect(listCardClaims(CARD_ID)).toEqual([])
    expect(checkCardWork(`#${seqOf(CARD_ID)}`, { skipLanded: true }).kind).toBe('clear')
    expect(CARD_CLAIM_TTL_MS).toBeGreaterThan(60 * 60 * 1000)
  })
})

describe('landolt munka felismerese', () => {
  it('a hatokorben allo szam szamit, a cim vegen allo PR-szam NEM', () => {
    const card = { seq: 28, cardId: '11da9dcb-0000-4000-8000-000000000028' }
    expect(subjectMentionsCard('feat(28): elo-probe', card)).toBe(true)
    expect(subjectMentionsCard('feat(life,#28): elo-probe', card)).toBe(true)
    // Ez egy MASIK kartya munkaja, a vegen a PR szamaval -- nem talalat.
    expect(subjectMentionsCard('fix(agent-scaffold): stale hook matcher (#28)', card)).toBe(false)
  })

  it('a kartya azonositoja is elegendo', () => {
    const card = { seq: 28, cardId: '11da9dcb-0000-4000-8000-000000000028' }
    expect(subjectMentionsCard('chore: kartya 11da9dcb lezarasa', card)).toBe(true)
  })
})

describe('a mondat ember-olvashato es ketnyelvu', () => {
  const HU = read('web/lang/hu.js')
  const EN = read('web/lang/en.js')
  const KEYS = [
    'cb.err.card_busy', 'cb.warn.card_forced', 'cb.warn.card_active_msg',
    'cb.warn.card_landed', 'cb.warn.card_uncheckable',
    'cb.confirm.card_force', 'cb.status.card_busy_cancelled',
  ]

  it('minden kulcs megvan magyarul ES angolul', () => {
    for (const k of KEYS) {
      expect(HU.includes(`'${k}'`), `hianyzik hu.js-bol: ${k}`).toBe(true)
      expect(EN.includes(`'${k}'`), `hianyzik en.js-bol: ${k}`).toBe(true)
    }
  })

  it('a behelyettesites nem hagy ott {kapcsos} helyorzot', () => {
    const n = cardWorkNotice('cb.warn.card_landed', { card: '#134', commit: '9f5708b', subject: 'feat(134): ok' })
    expect(n.message).toContain('#134')
    expect(n.message).toContain('9f5708b')
    expect(n.message).not.toMatch(/\{[a-z]+\}/)
  })

  it('ismeretlen kulcsnal a kulcsot adja vissza, nem ures mondatot', () => {
    expect(cardWorkNotice('cb.warn.nincs.ilyen', {}).message).toBe('cb.warn.nincs.ilyen')
  })
})

describe('uzenetet SOHA nem utasitunk el', () => {
  it('a /api/messages guard-ja csak figyelmeztet, nem valaszol hibat', () => {
    const src = read('src/web/routes/messages.ts')
    const start = src.indexOf('const verdict = checkCardWork(')
    const end = src.indexOf('const msg = createAgentMessage(')
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    // A guard es az uzenet letrehozasa kozott nincs valasz-kuldes: az uzenet
    // MINDIG elmegy. Egy kerdes vagy egy visszajelzes nem duplikatum.
    expect(src.slice(start, end)).not.toContain('json(res,')
  })
})
