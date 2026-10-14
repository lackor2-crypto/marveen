// Sharing debate modes between installs (#597, phase 7): the pure file format and the import plan.
import { describe, it, expect } from 'vitest'
import { buildShareFile, parseShareFile, planImport, freeName, shareFileName, SHARE_FORMAT, SHARE_VERSION, SHARE_MAX_BYTES } from '../debate-mode-share.js'
import { MODES_MAX, MODE_NAME_MAX, type StoredMode } from '../debate-modes.js'

let n = 0
const newId = () => `m-${String(++n).padStart(8, '0')}`

function mode(over: Partial<StoredMode> = {}): StoredMode {
  return { id: 'm-aaaaaaaa', name: 'Szigoru', description: 'leiras', base: 'critic', instructions: { critic: 'C szoveg', defender: 'D szoveg' }, conclusionNote: 'jegyzet', strength: 'hard', swapRoles: true, maxRounds: 3, ...over }
}

describe('buildShareFile', () => {
  it('formatum, verzio, idobelyeg; az azonosito nem kerul a fajlba, minden mas igen', () => {
    const f = buildShareFile([mode()], new Date('2026-10-14T10:00:00Z'))
    expect(f).toMatchObject({ format: SHARE_FORMAT, version: SHARE_VERSION, exported_at: '2026-10-14T10:00:00.000Z' })
    expect(f.modes[0]).not.toHaveProperty('id')
    expect(f.modes[0]).toEqual({ name: 'Szigoru', description: 'leiras', base: 'critic', instructions: { critic: 'C szoveg', defender: 'D szoveg' }, conclusionNote: 'jegyzet', strength: 'hard', swapRoles: true, maxRounds: 3 })
  })

  it('nincs benne gepspecifikus adat: se utvonal, se felhasznalonev, se azonosito (a kulcsok zartak)', () => {
    const json = JSON.stringify(buildShareFile([mode(), mode({ base: 'peer', instructions: { peer: 'x' } })]))
    expect(json).not.toMatch(/\/home\/|\/mnt\/|C:\\|"id"|project|token/i)
    expect(Object.keys(buildShareFile([mode()]).modes[0]).sort()).toEqual(['base', 'conclusionNote', 'description', 'instructions', 'maxRounds', 'name', 'strength', 'swapRoles'])
  })

  it('fajlnev: datummal; egynel tobb modnal a darabszammal', () => {
    const d = new Date('2026-10-14T10:00:00Z')
    expect(shareFileName(1, d)).toBe('marveen-vita-modok-2026-10-14.json')
    expect(shareFileName(3, d)).toBe('marveen-vita-modok-2026-10-14-3.json')
  })
})

describe('parseShareFile', () => {
  const good = () => buildShareFile([mode()])

  it('szoveget es mar beolvasott JSON-t is elfogad', () => {
    expect(parseShareFile(JSON.stringify(good()))).toMatchObject({ ok: true })
    const r = parseShareFile(good())
    expect(r.ok && r.modes).toHaveLength(1)
  })

  it('hibak: nem JSON, nem mod-fajl (tomb, mas formatum, hianyzo lista), ujabb verzio, ures, tul nagy', () => {
    expect(parseShareFile('{ nem json')).toEqual({ ok: false, error: 'bad_json' })
    expect(parseShareFile('[]')).toEqual({ ok: false, error: 'not_a_mode_file' })
    expect(parseShareFile(null)).toEqual({ ok: false, error: 'not_a_mode_file' })
    expect(parseShareFile({ format: 'valami-mas', modes: [{}] })).toEqual({ ok: false, error: 'not_a_mode_file' })
    expect(parseShareFile({ format: SHARE_FORMAT, modes: 'nem lista' })).toEqual({ ok: false, error: 'not_a_mode_file' })
    expect(parseShareFile({ ...good(), version: SHARE_VERSION + 1 })).toEqual({ ok: false, error: 'newer_version' })
    expect(parseShareFile({ ...good(), modes: [] })).toEqual({ ok: false, error: 'empty' })
    expect(parseShareFile('x'.repeat(SHARE_MAX_BYTES + 1))).toEqual({ ok: false, error: 'too_big' })
  })
})

describe('freeName', () => {
  it('szabad nev valtozatlan; foglalt nev sorszamot kap (kis-nagybetutol fuggetlenul)', () => {
    expect(freeName('Uj', new Set())).toBe('Uj')
    expect(freeName('Uj', new Set(['uj']))).toBe('Uj (2)')
    expect(freeName('Uj', new Set(['uj', 'uj (2)']))).toBe('Uj (3)')
  })
  it('hosszu nevnel a sorszam egeszben megmarad, a nev rovidul', () => {
    const long = 'n'.repeat(MODE_NAME_MAX)
    const r = freeName(long, new Set([long]))
    expect(r.length).toBeLessThanOrEqual(MODE_NAME_MAX)
    expect(r.endsWith(' (2)')).toBe(true)
  })
})

describe('planImport', () => {
  const entry = (name: string, extra: Record<string, unknown> = {}) => ({ name, description: 'd', base: 'critic', strength: 'medium', ...extra })

  it('minden beolvasott mod UJ azonositot kap; a fajl sajat azonositoja (akar egy meglevove) figyelmen kivul marad', () => {
    const existing = [mode({ id: 'm-existing1', name: 'Mas' })]
    const plan = planImport([entry('Uj', { id: 'm-existing1' })], existing, newId)
    expect(plan.toSave).toHaveLength(1)
    expect(plan.toSave[0].id).not.toBe('m-existing1')
    expect(plan.toSave[0].id).toMatch(/^m-/)
  })

  it('foglalt nev atnevezodik (a fajlon belul is), jelzi, mi mire', () => {
    const plan = planImport([entry('Szigoru'), entry('Uj'), entry('uj')], [mode()], newId)
    expect(plan.toSave.map(m => m.name)).toEqual(['Szigoru (2)', 'Uj', 'uj (2)'])
    expect(plan.renamed).toEqual([{ from: 'Szigoru', to: 'Szigoru (2)' }, { from: 'uj', to: 'uj (2)' }])
  })

  it('egy hibas bejegyzes nem allitja meg a jokat: kimarad az okkal, a tobbi bekerul', () => {
    const plan = planImport([entry('Jo'), { name: '', base: 'critic' }, entry('Rossz tipus', { base: 'valami' }), entry('Rossz kor', { maxRounds: 99 }), 7, null, entry('Masik jo')], [], newId)
    expect(plan.toSave.map(m => m.name)).toEqual(['Jo', 'Masik jo'])
    expect(plan.skipped.map(s => s.reason)).toEqual(['name_missing', 'base_unknown', 'max_rounds_bad', 'bad_input', 'bad_input'])
    expect(plan.skipped[1].name).toBe('Rossz tipus')
  })

  it('csak annyi fer be, amennyi hely van; a tobbi "too_many"', () => {
    const existing = Array.from({ length: MODES_MAX - 1 }, (_, i) => mode({ id: `m-e${String(i).padStart(7, '0')}`, name: `E${i}` }))
    const plan = planImport([entry('A'), entry('B')], existing, newId)
    expect(plan.toSave.map(m => m.name)).toEqual(['A'])
    expect(plan.skipped).toEqual([{ name: 'B', reason: 'too_many' }])
  })

  it('a beolvasott mod ugyanazt tudja, mint a szerkesztoben irt: tulhosszu szoveg levagva, ismeretlen erosseg alapertek', () => {
    const plan = planImport([entry('X', { strength: 'extreme', instructions: { critic: 'c'.repeat(9000) } })], [], newId)
    expect(plan.toSave[0].strength).toBe('medium')
    expect(plan.toSave[0].instructions.critic).toHaveLength(6000)
  })

  it('export -> import koreset: ugyanaz a mod jon vissza (uj azonositoval)', () => {
    const parsed = parseShareFile(JSON.stringify(buildShareFile([mode()])))
    if (!parsed.ok) throw new Error('parse')
    const plan = planImport(parsed.modes, [], newId)
    const { id: _a, ...a } = plan.toSave[0]
    const { id: _b, ...b } = mode()
    expect(a).toEqual(b)
  })
})
