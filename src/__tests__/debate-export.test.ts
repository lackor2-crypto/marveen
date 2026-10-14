// The debate as a report (#597, phase 6): the pure builder and the Markdown. The document work item is in debate-reports-routes.test.ts.
import { describe, it, expect } from 'vitest'
import { buildReport, reportMarkdown, reportFileName, paragraphsOf } from '../debate-export.js'
import { splitLong } from '../debate-export-doc.js'
import { parseObjections, parseReplies } from '../debate-modes.js'
import { buildObjectionBoard, summarizeBoard } from '../debate-board.js'

const OBJ = 'K1 [accuracy]\nQUOTE: "30 nap"\nOBJECTION: 15 nap a helyes.\n\nK2 [wording]\nQUOTE: "kerjuk szepen"\nOBJECTION: hang.'
const REP = 'K1: ACCEPT\nREASON: igaz, a torveny 15 napot mond\nREWRITE: 15 nap\n\nK2: REJECT\nREASON: a hang megfelelo'

function reviewState(over: Record<string, unknown> = {}): any {
  const rounds = [{ round: 1, prompt: 'Jo a level?', responses: [
    { model: 'openai/gpt-5.5', ok: true, role: 'critic', text: OBJ, objections: parseObjections(OBJ) },
    { model: 'anthropic/claude-opus-4.1', ok: true, role: 'defender', text: REP, replies: parseReplies(REP) },
  ] }]
  const board = buildObjectionBoard(rounds)
  return {
    id: 's1', project: 'p1', mode: 'critic', modeName: null, maxRounds: 6, strength: 'hard', swapRoles: false, judge: 'google/gemini-3-pro',
    models: ['openai/gpt-5.5', 'anthropic/claude-opus-4.1'], question: 'Jo a level?\n\nA hatarido 30 nap.', attachments: [{ name: 'level.pdf', text: 'x' }],
    rounds, concluded: true, consensus: false, summary: 'Eredmeny sor 1.\n\nMasodik bekezdes.', summaryBy: 'google/gemini-3-pro',
    orderCheck: { agree: false, consensus: [true, false], onlyFirst: ['K2'], onlySecond: [] }, board, boardSummary: summarizeBoard(board), advice: { stop: false }, conformity: { suspicious: false },
    ...over,
  }
}

const titles = (r: ReturnType<typeof buildReport>) => r.sections.map(s => s.title)

describe('buildReport', () => {
  it('lezart ujraolvasas-jelzes vitanal: kerdes, beallitasok, eredmeny, kifogas-tabla ebben a sorrendben (magyarul)', () => {
    const r = buildReport(reviewState(), 'hu')
    expect(r.title).toMatch(/^Vitáztatás jelentés: Jo a level\?/)
    expect(titles(r)).toEqual(['Kérdés vagy feladat', 'A vita beállításai', 'Eredmény', 'Kifogás-tábla'])
    const settings = r.sections[1].paragraphs
    expect(settings).toContain('Mód: Kötekedő és védő')
    expect(settings).toContain('1. modell: openai/gpt-5.5 (kötekedő)')
    expect(settings).toContain('2. modell: anthropic/claude-opus-4.1 (védő)')
    expect(settings).toContain('Kötekedés erőssége: Kemény')
    expect(settings).toContain('Bíró modell: google/gemini-3-pro')
    expect(r.sections[0].paragraphs.at(-1)).toBe('Segédanyag: level.pdf')
  })

  it('az eredmeny: egyetertes, ki irta, a ket olvasat eltereset es az osszefoglalo bekezdeseit kiirja', () => {
    const res = buildReport(reviewState(), 'hu').sections[2].paragraphs
    expect(res[0]).toBe('Nem jutottak teljes egyetértésre.')
    expect(res.some(p => p.includes('gemini-3-pro'))).toBe(true)
    expect(res.some(p => p.startsWith('Figyelem: a két olvasat nem egyezik') && p.includes('K2'))).toBe(true)
    expect(res.slice(-2)).toEqual(['Eredmeny sor 1.', 'Masodik bekezdes.'])
  })

  it('a kifogas-tabla minden sora: szam, fajta, allapot, idezet, kifogas, a vedo valasza, javasolt szoveg', () => {
    const b = buildReport(reviewState(), 'hu').sections[3].paragraphs
    expect(b[0]).toBe('Összesen 2 kifogás: 1 elfogadva, 0 részben, 1 elutasítva, 0 visszavonva, 0 nyitott.')
    expect(b).toContain('K1 [pontosság] – elfogadva')
    expect(b).toContain('Idézet: „30 nap”')
    expect(b).toContain('Kifogás: 15 nap a helyes.')
    expect(b.some(p => p.startsWith('A védő válasza (1. kör): elfogadja – igaz'))).toBe(true)
    expect(b).toContain('Javasolt új szöveg: 15 nap')
    expect(b).toContain('K2 [szóhasználat] – elutasítva (vita tárgya)')
  })

  it('angolul ugyanez', () => {
    const r = buildReport(reviewState(), 'en')
    expect(r.title).toMatch(/^Debate report: /)
    expect(titles(r)).toEqual(['Question or task', 'Debate settings', 'Result', 'Objection board'])
    expect(r.sections[3].paragraphs).toContain('K1 [accuracy] – accepted')
    expect(r.sections[1].paragraphs).toContain('Mode: Critic and defender')
  })

  it('nem lezart vita: kiirja, hogy nincs vegeredmeny, es nem talal ki egyet', () => {
    const r = buildReport(reviewState({ concluded: false, consensus: null, summary: null, summaryBy: null, orderCheck: null }), 'hu')
    expect(r.sections[2].paragraphs).toEqual(['A vita még nincs lezárva, ezért nincs végeredmény.'])
  })

  it('egyenrangu vita: nincs szerep, nincs erosseg, nincs kifogas-tabla', () => {
    const peer = reviewState({
      mode: 'peer', board: [], boardSummary: null,
      rounds: [{ round: 1, prompt: 'q', responses: [{ model: 'a/x', ok: true, text: 'valasz A' }, { model: 'b/y', ok: true, text: 'valasz B' }] }],
      models: ['a/x', 'b/y'], judge: null,
    })
    const r = buildReport(peer, 'hu')
    expect(titles(r)).toEqual(['Kérdés vagy feladat', 'A vita beállításai', 'Eredmény'])
    expect(r.sections[1].paragraphs.join('|')).not.toMatch(/kötekedő|erőssége|Bíró/)
    expect(r.sections[1].paragraphs).toContain('Mód: Egyenrangú')
  })

  it('sajat mod neve a modbol jon; ismeretlen azonosito sem dob', () => {
    expect(buildReport(reviewState({ mode: 'm-12345678', modeName: 'Szigoru atnezes' }), 'hu').sections[1].paragraphs[0]).toBe('Mód: Szigoru atnezes')
    expect(buildReport(reviewState({ mode: 'valami-uj', modeName: null }), 'hu').sections[1].paragraphs[0]).toBe('Mód: valami-uj')
  })

  it('"teljes menet": minden korhoz egy szakasz, modellenkent a valasz; a sikertelen modell hibaja is', () => {
    const st = reviewState()
    st.rounds[0].responses[1] = { model: 'anthropic/claude-opus-4.1', ok: false, error: 'timeout', role: 'defender' }
    const r = buildReport(st, 'hu', { full: true })
    expect(titles(r).at(-1)).toBe('1. kör')
    const paras = r.sections.at(-1)!.paragraphs
    expect(paras).toContain('gpt-5.5 (kötekedő)')
    expect(paras).toContain('Ez a modell nem válaszolt: timeout')
    expect(titles(buildReport(st, 'hu'))).not.toContain('1. kör')
  })

  it('a hosszu kerdes a cimben le van vagva, a szakasz viszont a teljes szoveget tartja', () => {
    const long = 'szo '.repeat(100)
    const r = buildReport(reviewState({ question: long }), 'hu')
    expect(r.title.length).toBeLessThan(120)
    expect(r.title.endsWith('…')).toBe(true)
    expect(r.sections[0].paragraphs[0]).toBe(long.trim())
  })
})

describe('reportMarkdown / reportFileName / paragraphsOf', () => {
  it('Markdown: cim, szakaszcimek, bekezdesek ures sorral; nincs hármas ures sor', () => {
    const md = reportMarkdown(buildReport(reviewState(), 'hu'))
    expect(md.startsWith('# Vitáztatás jelentés: ')).toBe(true)
    expect(md).toContain('\n## Eredmény\n\nNem jutottak teljes egyetértésre.\n\n')
    expect(md).not.toMatch(/\n{3,}/)
    expect(md.endsWith('\n')).toBe(true)
  })

  it('fajlnev: ekezet nelkuli, rovid, kiterjesztessel; ures kerdesnel is van', () => {
    expect(reportFileName({ question: 'Megfelelő a hiánypótló válaszlevél? Mi hiányzik belőle?' }, 'md')).toBe('Megfelelo-a-hianypotlo-valaszlevel-Mi-vita.md')
    expect(reportFileName({ question: '???' }, 'md')).toBe('vita-vita.md')
    expect(reportFileName({ question: 'x'.repeat(300) }, 'md').length).toBeLessThan(60)
  })

  it('paragraphsOf: ures sor valaszt, ures / hianyzo szoveg semmit', () => {
    expect(paragraphsOf('a\nb\n\n\nc')).toEqual(['a\nb', 'c'])
    expect(paragraphsOf(null)).toEqual([])
    expect(paragraphsOf('  ')).toEqual([])
  })
})

describe('splitLong (a dokumentum blokk-hatara)', () => {
  it('rovid szoveg egyben marad', () => { expect(splitLong('rovid', 100)).toEqual(['rovid']) })
  it('hosszu szoveg mondat- vagy szohataron vagodik, semmi nem vesz el', () => {
    const text = 'Elso mondat itt. Masodik mondat itt. Harmadik mondat itt. Negyedik mondat itt.'
    const parts = splitLong(text, 40)
    expect(parts.every(p => p.length <= 40)).toBe(true)
    expect(parts.join(' ')).toBe(text)
  })
  it('szokoz nelkuli hosszu szo is vagodik (nem vegtelen ciklus)', () => {
    const parts = splitLong('x'.repeat(95), 40)
    expect(parts.map(p => p.length)).toEqual([40, 40, 15])
  })
})
