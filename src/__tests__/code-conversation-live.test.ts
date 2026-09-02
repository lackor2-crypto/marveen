/**
 * ELO KOVETES a VS Code chat-ablakban -- amit ez a fajl oriz.
 *
 * A kod-hid beszelgetes-ablaka 2026-09-02-ig EGYSZER toltott: aki latni akarta,
 * mit ir eppen a Claude Code, bezarta es ujranyitotta. Ez a teszt harom olyan
 * szabalyt rogzit, amit a "csak toltsuk ujra" megoldas mindharmat megsertene:
 *
 *  1. ★ A KONNYU KERDES OLCSO MARAD. Egy transcript ebben a mappaban 50-150 MB
 *     is lehet. A kovetes 2-3 masodpercenkent kerdez -- ha a valasz beolvasna a
 *     naplot, az "elo nezet" maga olne meg a szervert. A `meta=1` valaszban
 *     EZERT nincs `entries`.
 *  2. ★ A KAPU-LANC EGY HELYEN VAN. A konnyu es a teljes ut UGYANAZT az okot
 *     kell mondja ugyanarra a naplora. Ket kulon lanc eseten a jelzo "elo"-t
 *     mutatna, mikozben a lista azt irja, "nem latok oda".
 *  3. ★ A NULLA KET DOLGOT JELENTHET -- itt HAROM allapot: "elo" / "elo, de
 *     all" (a feladat kesz -- NEM hiba) / "nem latok oda" (mert `reason`). A
 *     harmadikat SOSEM a sorok szamabol talaljuk ki.
 *
 * A felulet-oldali dontesek TISZTA FUGGVENYEK, ezert DOM nelkul futnak: a
 * `web/app.js`-bol kiemelve, `new Function` alatt. Igy egy fork-nak sem kell
 * bongeszot inditania ahhoz, hogy ezek a szabalyok vedve legyenek.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync, mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { statCodeConversation, readCodeConversation } from '../web/code-conversation.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')

const SESSION = 'aaaaaaaa-0000-4000-8000-0000000000ff'

// IDEIGLENES FAJL: a rendszer temp-mappajaba, SOHA nem a projekt faba -- es a
// vegen torolve. (nyomtalan-munka)
let tmpRoot = ''
let transcript = ''

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-conv-live-'))
  const dir = join(tmpRoot, '.claude', 'projects', 'proj')
  mkdirSync(dir, { recursive: true })
  transcript = join(dir, `${SESSION}.jsonl`)
  writeFileSync(transcript, [
    JSON.stringify({ type: 'user', timestamp: '2026-09-02T10:00:00Z', message: { content: 'szia' } }),
    JSON.stringify({
      type: 'assistant', timestamp: '2026-09-02T10:00:01Z',
      message: { content: [{ type: 'text', text: 'nezem' }] },
    }),
  ].join('\n') + '\n', 'utf8')
})

afterAll(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// SZERVER: a konnyu allapot-lekerdezes
// ---------------------------------------------------------------------------

describe('statCodeConversation: allapot a napló BEOLVASASA nelkul', () => {
  it('olvashato napló -> mert mtime + meret, es NINCS ok', () => {
    const m = statCodeConversation(transcript, SESSION)
    expect(m.reason).toBeNull()
    expect(typeof m.mtime).toBe('number')
    expect(m.mtime! > 0).toBe(true)
    expect(typeof m.size).toBe('number')
    expect(m.size! > 0).toBe(true)
  })

  it('nincs ut (regi worker) -> `no-path`, es nem talalgatunk mtime-ot', () => {
    const m = statCodeConversation(null, SESSION)
    expect(m.reason).toBe('no-path')
    expect(m.mtime).toBeNull()
    expect(m.transcriptPath).toBeNull()
  })

  it('nem Claude Code-alaku ut -> `unsafe-path` (nem nyitjuk meg)', () => {
    const m = statCodeConversation('/etc/passwd', SESSION)
    expect(m.reason).toBe('unsafe-path')
  })

  it('★ hianyzo fajlnal a RENDSZER szo szerinti hibaja megy tovabb, nem tipp', () => {
    const gone = join(tmpRoot, '.claude', 'projects', 'proj', 'bbbbbbbb-0000-4000-8000-0000000000ee.jsonl')
    const m = statCodeConversation(gone, 'bbbbbbbb-0000-4000-8000-0000000000ee')
    // A tenyleges uzenet, nem egy kitalalt magyarazat ("valoszinuleg rossz
    // kulcs" tipusu mondat itt tiltott).
    expect(m.reason).toContain('ENOENT')
    expect(m.mtime).toBeNull()
  })
})

describe('★ a konnyu es a teljes ut UGYANAZT az okot mondja', () => {
  const cases: Array<[string, string | null, string]> = [
    ['nincs ut', null, SESSION],
    ['nem biztonsagos ut', '/etc/passwd', SESSION],
    ['hianyzo fajl', '/tmp/nincs-ilyen/.claude/projects/p/cccccccc-0000-4000-8000-0000000000dd.jsonl',
      'cccccccc-0000-4000-8000-0000000000dd'],
  ]
  for (const [nev, path, sid] of cases) {
    it(`${nev}: statCodeConversation.reason === readCodeConversation.reason`, () => {
      const meta = statCodeConversation(path, sid)
      const full = readCodeConversation(path, sid, { limit: 400, offset: 0 })
      expect(meta.reason).toBe(full.reason)
      expect(meta.mtime).toBe(full.mtime)
    })
  }

  it('olvashato naplonal mindketto hallgat (reason === null), es az mtime egyezik', () => {
    const meta = statCodeConversation(transcript, SESSION)
    const full = readCodeConversation(transcript, SESSION, { limit: 400, offset: 0 })
    expect(meta.reason).toBeNull()
    expect(full.reason).toBeNull()
    expect(meta.mtime).toBe(full.mtime)
    // A teljes ut tenyleg beolvasta; a konnyu ut nem ad `entries`-t.
    expect(full.total).toBe(2)
    expect(meta).not.toHaveProperty('entries')
  })
})

// ---------------------------------------------------------------------------
// FELULET: a kovetes tiszta dontesei (DOM nelkul)
// ---------------------------------------------------------------------------

function extractFn(src: string, name: string): string {
  const start = src.search(new RegExp(`(?:async )?function ${name}\\(`))
  if (start < 0) throw new Error(`${name}() nincs a web/app.js-ben`)
  let depth = 0
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1)
  }
  throw new Error(`${name}() zarojelei nincsenek parban`)
}

const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf-8')

const harness = `
  function t(key, vars) {
    if (!vars) return key
    return key + '|' + Object.keys(vars).map(function (k) { return k + '=' + vars[k] }).join(',')
  }
  function escapeHtml(s) { return String(s) }
  function escapeAttr(s) { return String(s) }
  const CONV_NEAR_BOTTOM_PX = 40
  const CONV_IDLE_MS = 120000
  ${extractFn(app, 'convIsNearBottom')}
  ${extractFn(app, 'convLiveState')}
  ${extractFn(app, 'convFollowPlan')}
  ${extractFn(app, 'convFilterEntries')}
  ${extractFn(app, 'cbTabViewBtn')}
  return {
    convIsNearBottom: convIsNearBottom, convLiveState: convLiveState,
    convFollowPlan: convFollowPlan, convFilterEntries: convFilterEntries,
    cbTabViewBtn: cbTabViewBtn,
  }
`
interface Entry { kind: string; text?: string }
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const api = new Function(harness)() as {
  convIsNearBottom: (top: number, height: number, client: number, px?: number) => boolean
  convLiveState: (
    meta: { mtime?: number | null; reason?: string | null } | null,
    now: number,
    opts?: { paused?: boolean; idleMs?: number },
  ) => string
  convFollowPlan: (
    prevTotal: number | null,
    next: { entries?: Entry[]; total?: number },
  ) => { mode: string; added: Entry[]; total: number }
  convFilterEntries: (e: Entry[], main: string[], showActions: boolean, q: string) => Entry[]
  cbTabViewBtn: (tb: Record<string, unknown> | null, label: string) => string
}

describe('convIsNearBottom: mikor szabad magatol lerantani a listat', () => {
  it('az aljan all -> szabad', () => {
    expect(api.convIsNearBottom(600, 1000, 400)).toBe(true)
  })
  it('a kuszobon BELUL meg szabad (40 px)', () => {
    expect(api.convIsNearBottom(570, 1000, 400)).toBe(true)
  })
  it('★ feljebb gorgetett (OLVAS) -> NEM rantjuk el a szeme elol', () => {
    expect(api.convIsNearBottom(200, 1000, 400)).toBe(false)
  })
  it('a kuszob felulirhato', () => {
    expect(api.convIsNearBottom(500, 1000, 400, 200)).toBe(true)
    expect(api.convIsNearBottom(500, 1000, 400, 50)).toBe(false)
  })
})

describe('★ convLiveState: az "all" es a "nem latok oda" KET KULONBOZO valasz', () => {
  const now = 1_800_000_000_000

  it('meg nem mertunk -> `unknown` (a jelzo elbujik, nem allit semmit)', () => {
    expect(api.convLiveState(null, now)).toBe('unknown')
  })

  it('most irtak bele -> `live`', () => {
    expect(api.convLiveState({ mtime: now - 3000, reason: null }, now)).toBe('live')
  })

  it('★ all a napló (kesz a feladat) -> `idle`, ami NEM hiba es NEM `blind`', () => {
    const s = api.convLiveState({ mtime: now - 600_000, reason: null }, now)
    expect(s).toBe('idle')
    expect(s).not.toBe('blind')
  })

  it('★ a szerver okot adott -> `blind`, akkor is, ha az mtime friss volna', () => {
    expect(api.convLiveState({ mtime: now, reason: 'no-path' }, now)).toBe('blind')
  })

  it('★ a MERT ok erosebb, mint a felulet szunet-allapota', () => {
    // Kulonben egy elerhetetlen naplora azt irnank, "szuneteltetve" -- mintha
    // barmikor folytathato lenne.
    expect(api.convLiveState({ mtime: now, reason: 'ENOENT: ...' }, now, { paused: true })).toBe('blind')
  })

  it('visszalapozas alatt -> `paused` (de csak ha egyebkent latunk oda)', () => {
    expect(api.convLiveState({ mtime: now, reason: null }, now, { paused: true })).toBe('paused')
  })

  it('★ ok nelkul, de mtime nelkul sem allitunk "elo"-t', () => {
    expect(api.convLiveState({ mtime: null, reason: null }, now)).toBe('unknown')
  })

  it('az idle-kuszob athangolhato', () => {
    expect(api.convLiveState({ mtime: now - 5000, reason: null }, now, { idleMs: 1000 })).toBe('idle')
  })
})

describe('convFollowPlan: hany uj sor jott, es hozzafuzheto-e', () => {
  const e = (n: number): Entry[] => Array.from({ length: n }, (_, i) => ({ kind: 'user', text: 's' + i }))

  it('nem valtozott -> `none`, es semmit nem rajzolunk ujra', () => {
    const p = api.convFollowPlan(10, { entries: e(10), total: 10 })
    expect(p.mode).toBe('none')
    expect(p.added).toHaveLength(0)
  })

  it('★ ket uj sor -> `append`, es PONTOSAN az utolso ketto', () => {
    const p = api.convFollowPlan(8, { entries: e(10), total: 10 })
    expect(p.mode).toBe('append')
    expect(p.added).toHaveLength(2)
    expect(p.added[0]!.text).toBe('s8')
    expect(p.added[1]!.text).toBe('s9')
  })

  it('★ tobb uj sor jott, mint az ablak -> `replace` (a hozzafuzes LYUKAS lenne)', () => {
    // 500 uj bejegyzes, de az ablak csak 400-at hoz: a "csak az uj vegét fuzzuk
    // hozza" itt csendben elveszitene 100 sort.
    const p = api.convFollowPlan(100, { entries: e(400), total: 600 })
    expect(p.mode).toBe('replace')
  })

  it('★ visszaeso `total` (mas napló kerult a helyere) -> `replace`', () => {
    const p = api.convFollowPlan(50, { entries: e(3), total: 3 })
    expect(p.mode).toBe('replace')
  })

  it('elso kor (nincs korabbi merce) -> `replace`', () => {
    const p = api.convFollowPlan(null, { entries: e(5), total: 5 })
    expect(p.mode).toBe('replace')
    expect(p.total).toBe(5)
  })

  it('hianyos valasz nem dob kivetelt', () => {
    expect(api.convFollowPlan(0, {}).mode).toBe('none')
  })
})

describe('convFilterEntries: a hozzafuzes UGYANAZT szuri, mint az ujrarajzolas', () => {
  const rows: Entry[] = [
    { kind: 'user', text: 'irtam' },
    { kind: 'assistant', text: 'valasz' },
    { kind: 'action', text: 'Edit: app.js' },
  ]
  const MAIN = ['user', 'assistant']

  it('reszlet-pipa nelkul a muveletek kimaradnak', () => {
    expect(api.convFilterEntries(rows, MAIN, false, '')).toHaveLength(2)
  })
  it('reszlet-pipaval minden benne van', () => {
    expect(api.convFilterEntries(rows, MAIN, true, '')).toHaveLength(3)
  })
  it('a kereses a MEGJELENITETT halmazra szur', () => {
    expect(api.convFilterEntries(rows, MAIN, true, 'app.js')).toHaveLength(1)
  })
  it('ures bemenet nem dob kivetelt', () => {
    expect(api.convFilterEntries([], MAIN, true, '')).toHaveLength(0)
  })
})

// Boss, 2026-09-02: "a kartyan van az a 3 vonal egymas alatt es mellette az elo
// nezet. de mind a ketto ugyanazt teszi ... az a 3 vonal akkor nem kellene." --
// es: "a lenyilo menuben abban a legutobbi chatekben, oda is oda kellene tenni
// ezt az elo nezetet." Azota EGY gomb van soronkent, KET felirattal.
describe('Megnyito gomb: egy alak, ket allapot -- es az "elo" MERES', () => {
  it('futo ful + van napló -> "Elo nezet" + pulzalo pont', () => {
    const html = api.cbTabViewBtn({ sessionId: SESSION, live: true, hasTranscript: true }, 'Kanban #47')
    expect(html).toContain('cb-tab-live-btn')
    expect(html).toContain('cb-tab-live-dot')
    expect(html).toContain('cb.card.tab_live')
    expect(html).toContain(SESSION)
    // A felirat a forditason megy at -- nincs beegetett magyar szoveg.
    expect(html).not.toMatch(/Élő|Live view/)
  })

  it('★ nem fut -> VAN gomb, de "Megnyitas" -- elo nezetet nem igerunk ra', () => {
    const html = api.cbTabViewBtn({ sessionId: SESSION, live: false, hasTranscript: true }, 'x')
    expect(html).toContain('cb-tab-view-btn')
    expect(html).toContain('cb.card.tab_open_short')
    expect(html).not.toContain('cb.card.tab_live')
    // A PULZALO PONT az "elo" jele. Allo beszelgetesen ott nincs mit jelezni.
    expect(html).not.toContain('cb-tab-live-dot')
  })

  it('★ NEM MERTUK, hogy fut-e (`live: null`) -> ugyanaz, mint a nem-futo: nem allitunk elot', () => {
    const html = api.cbTabViewBtn({ sessionId: SESSION, live: null, hasTranscript: true }, 'x')
    expect(html).toContain('cb-tab-view-btn')
    expect(html).not.toContain('cb-tab-live-dot')
  })

  it('nincs napló (regi worker) -> nincs gomb, amit hibauzenet jutalmazna', () => {
    expect(api.cbTabViewBtn({ sessionId: SESSION, live: true, hasTranscript: false }, 'x')).toBe('')
    expect(api.cbTabViewBtn({ sessionId: SESSION, live: false, hasTranscript: false }, 'x')).toBe('')
  })

  it('hianyzo ful nem dob kivetelt', () => {
    expect(api.cbTabViewBtn(null, 'x')).toBe('')
  })

  it('★ a `☰` SEHOL nem marad meg -- a ket gombbol egy lett', () => {
    const live = api.cbTabViewBtn({ sessionId: SESSION, live: true, hasTranscript: true }, 'x')
    const idle = api.cbTabViewBtn({ sessionId: SESSION, live: false, hasTranscript: true }, 'x')
    expect(live).not.toContain('☰')
    expect(idle).not.toContain('☰')
    expect(live).not.toContain('cb-tab-open"')
    expect(idle).not.toContain('cb-tab-open"')
  })
})

// ---------------------------------------------------------------------------
// A KOVETES BEKOTESE -- a forras-szintu garanciak
// ---------------------------------------------------------------------------

describe('★ a kovetes nem futhat tovabb lathatatlanul', () => {
  it('a bezaras MINDEN utja leallitja (a kozos `closeModal`-ban)', () => {
    // Ha csak a bezaro gombra figyelnenk, az Esc / hatterre kattintas utan a
    // lekerdezes a lap eleteig futna tovabb, lathatatlanul.
    expect(app).toMatch(/conversationOverlay'\)\s*convFollowReset\(\)/)
  })

  it('a `convFollowReset` tenyleg torli az idozitot', () => {
    expect(extractFn(app, 'convFollowStop')).toContain('clearInterval')
    expect(extractFn(app, 'convFollowReset')).toContain('convFollowStop()')
  })

  it('★ a kovetes a KONNYU vegpontot kerdezi, nem a teljeset', () => {
    const tick = extractFn(app, 'convFollowTick')
    expect(tick).toContain("'&meta=1'")
    // ... es a tartalom csak akkor jon le, ha az mtime elmozdult.
    expect(tick).toContain('convFollowMtime')
    expect(tick).toContain('convFollowPull()')
  })

  it('rejtett fulnel szunetel', () => {
    expect(extractFn(app, 'convFollowTick')).toContain('document.hidden')
  })

  it('★ csak VS Code beszelgetest kovetunk', () => {
    expect(extractFn(app, 'convFollowStart')).toContain("conversationSource.kind !== 'code'")
  })
})
