/**
 * ELAGAZO BESZELGETES -- amit ez a fajl oriz.
 *
 * A Claude Code naplója nem lista, hanem FA: minden rekord megmondja, melyikre
 * epul (`parentUuid`). A Marveen 2026-09-03-ig FAJLSORRENDBEN olvasta, tehat
 * ket parhuzamos agat egyetlen folyamatos beszelgetesnek mutatott.
 *
 * A VALOS ESET (merve, a 277f9773 naplón). A Boss a Marveen kuldo soraval
 * beirt egy utasitast; a futas a `9431bd96` valaszra epult. Egy oraval kesobb
 * ugyanabba a beszelgetesbe irt a VS Code panelbol is -- az az uzenet UGYANARRA
 * a `9431bd96`-ra epult, mert a panel a sajat memoriajabol dolgozik, es a
 * kozben erkezett fordulóról nem tudott. Ket ag lett belole, es egyik sem latja
 * a masikat: a panelben futo Claude sosem latta a Marveenbol kuldott utasitast.
 * A nezet pedig egymas utan mutatta a kettot, mintha egy szal lenne.
 *
 * A KET SZABALY, amit ez a fajl kikenyszerit:
 *
 *  1. ★ A VALODI KETTEVALAST JELOLJUK. Ket BEIRAS ugyanarrol a szulorol = ket
 *     ag; a masodik kap jelet.
 *  2. ★ A SZERSZAMHIVAS NEM ELAGAZAS. A naplóban minden szerszamhivas kozos
 *     szulorol indit egy `assistant` es egy `user` rekordot -- a merés szerint
 *     32 kozos szulobol 31 ilyen volt. Ha ezeket is jelolnenk, minden forduló
 *     mellett allna egy "elagazas" csik, es a nezo leszokna roluk -- a jel
 *     pontosan akkor veszne el, amikor szamit.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { findConversationBranchStarts, readCodeConversation } from '../web/code-conversation.js'

// ---------------------------------------------------------------------------
// A TISZTA DONTES (fajl es DOM nelkul)
// ---------------------------------------------------------------------------

describe('findConversationBranchStarts: hol valik ketté a beszelgetes', () => {
  it('egyenes szal -> nincs jeloles', () => {
    const starts = findConversationBranchStarts([
      { uuid: 'a', parentUuid: null },
      { uuid: 'b', parentUuid: 'a1' },
      { uuid: 'c', parentUuid: 'b1' },
    ])
    expect(starts.size).toBe(0)
  })

  it('★ ket beiras UGYANARROL a szulorol -> a MASODIK kap jelet', () => {
    const starts = findConversationBranchStarts([
      { uuid: 'marveen', parentUuid: '9431bd96' },
      { uuid: 'panel', parentUuid: '9431bd96' },
    ])
    // Az elso a maga idejeben szabalyos folytatas volt -- nem az tert el.
    expect(starts.has('marveen')).toBe(false)
    expect(starts.has('panel')).toBe(true)
  })

  it('harom ag -> a masodik ES a harmadik is jelet kap', () => {
    const starts = findConversationBranchStarts([
      { uuid: 'x', parentUuid: 'p' },
      { uuid: 'y', parentUuid: 'p' },
      { uuid: 'z', parentUuid: 'p' },
    ])
    expect([...starts].sort()).toEqual(['y', 'z'])
  })

  it('★ a gyokér-beirasok NEM agak egymasnak (kompakt utan mindegyik gyokér)', () => {
    // `/compact` utan uj gyokér nyilik. Ha a `null` szulot egy szulonek
    // vennenk, minden kompakt-hatar hamis elagazast jelentene.
    const starts = findConversationBranchStarts([
      { uuid: 'a', parentUuid: null },
      { uuid: 'b', parentUuid: null },
      { uuid: 'c', parentUuid: null },
    ])
    expect(starts.size).toBe(0)
  })

  it('azonosito nelkuli rekord nem borit fel semmit', () => {
    const starts = findConversationBranchStarts([
      { uuid: '', parentUuid: 'p' },
      { uuid: 'valodi', parentUuid: 'p' },
    ])
    // Az ures azonositot at kell ugrani -- kulonben a kovetkezo beiras
    // hamisan "masodik gyereknek" latszana.
    expect(starts.size).toBe(0)
  })

  it('ures bemenet -> ures eredmeny (nem dob)', () => {
    expect(findConversationBranchStarts([]).size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// A TELJES OLVASAS, valodi naplo-alaku fajlon
// ---------------------------------------------------------------------------

const SESSION = 'cccccccc-0000-4000-8000-00000000beef'
let tmpRoot = ''
let transcript = ''

/** Egy szerszamhivas napló-alakja: KOZOS szulorol indul egy `assistant`
 *  (tool_use) es egy `user` (tool_result) rekord. Ez a 31-szer merte szerkezet. */
function toolCall(parent: string, id: string, ts: string): string[] {
  return [
    JSON.stringify({
      type: 'assistant', uuid: `${id}-a`, parentUuid: parent, timestamp: ts,
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
    }),
    JSON.stringify({
      type: 'user', uuid: `${id}-u`, parentUuid: parent, timestamp: ts,
      message: { content: [{ type: 'tool_result', content: 'ok' }] },
    }),
  ]
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-conv-branch-'))
  const dir = join(tmpRoot, '.claude', 'projects', 'proj')
  mkdirSync(dir, { recursive: true })
  transcript = join(dir, `${SESSION}.jsonl`)
  writeFileSync(transcript, [
    JSON.stringify({
      type: 'user', uuid: 'u1', parentUuid: null, timestamp: '2026-09-02T10:00:00Z',
      message: { content: 'elso kerdes' },
    }),
    JSON.stringify({
      type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-09-02T10:00:01Z',
      message: { content: [{ type: 'text', text: 'elso valasz' }] },
    }),
    // harom szerszamhivas: mind kozos szulorol agazik -- egyik SEM kettevalas
    ...toolCall('a1', 't1', '2026-09-02T10:00:02Z'),
    ...toolCall('a1', 't2', '2026-09-02T10:00:03Z'),
    ...toolCall('a1', 't3', '2026-09-02T10:00:04Z'),
    // az `a1`-re epulo ELSO beiras (ezt kuldte a Marveen)
    JSON.stringify({
      type: 'user', uuid: 'marveen', parentUuid: 'a1', timestamp: '2026-09-02T10:53:00Z',
      message: { content: 'a Marveenbol kuldott utasitas' },
    }),
    JSON.stringify({
      type: 'assistant', uuid: 'a2', parentUuid: 'marveen', timestamp: '2026-09-02T10:53:10Z',
      message: { content: [{ type: 'text', text: 'valasz a Marveennek' }] },
    }),
    // ...es egy oraval kesobb UGYANARRA az `a1`-re epulo masodik beiras
    JSON.stringify({
      type: 'user', uuid: 'panel', parentUuid: 'a1', timestamp: '2026-09-02T11:53:00Z',
      message: { content: 'amit a VS Code panelbe irtam' },
    }),
  ].join('\n') + '\n', 'utf8')
})

afterAll(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true })
})

describe('readCodeConversation: az elagazas latszik a bejegyzeseken', () => {
  it('★ PONTOSAN egy elagazas van -- a harom szerszamhivas nem az', () => {
    const conv = readCodeConversation(transcript, SESSION, { limit: 400, offset: 0 })
    expect(conv.reason).toBeNull()
    expect(conv.branchCount).toBe(1)
  })

  it('★ a jel a MASODIK beirason all, nem az elson', () => {
    const conv = readCodeConversation(transcript, SESSION, { limit: 400, offset: 0 })
    const marked = conv.entries.filter((e) => e.branchStart === true)
    expect(marked.length).toBe(1)
    expect(marked[0]!.text).toContain('VS Code panelbe')
    const first = conv.entries.find((e) => e.text.includes('Marveenbol kuldott'))
    expect(first?.branchStart).toBeUndefined()
  })

  it('a szerszamhivasok egyetlen bejegyzese sem kap elagazas-jelet', () => {
    const conv = readCodeConversation(transcript, SESSION, { limit: 400, offset: 0 })
    for (const e of conv.entries) {
      if (e.kind === 'action') expect(e.branchStart).toBeUndefined()
    }
  })

  it('★ a "nem latok oda" valasz is ad szamot -- nem hianyzo mezot', () => {
    // A NULLA KET DOLGOT JELENTHET: a hibas uton is ertelmezheto szam kell,
    // kulonben a felulet a hianyzo mezot "nulla elagazas"-nak olvasna.
    const conv = readCodeConversation('/etc/passwd', SESSION, { limit: 10, offset: 0 })
    expect(conv.reason).toBe('unsafe-path')
    expect(conv.branchCount).toBe(0)
  })
})
