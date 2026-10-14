// The owner-made debate modes on disk (#597, phase 3): store/debate-modes.json. The file is a real one in a temp folder.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'

const h = vi.hoisted(() => ({ dir: '' }))
vi.mock('../config.js', async (orig) => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  h.dir = mkdtempSync(join(tmpdir(), 'debate-modes-test-'))
  return { ...(await orig<typeof import('../config.js')>()), STORE_DIR: h.dir }
})

const { DEBATE_MODES_PATH, loadStoredModes, loadCustomModes, lookupMode, saveStoredMode, deleteStoredMode } = await import('../debate-mode-store.js')
const { MODES_MAX } = await import('../debate-modes.js')

const MODE = { name: 'Szigoru atnezes', base: 'critic', strength: 'hard', maxRounds: 3 }

beforeEach(() => { rmSync(DEBATE_MODES_PATH, { force: true }) })
afterAll(() => { rmSync(h.dir, { recursive: true, force: true }) })

describe('sajat modok tarolasa', () => {
  it('ures telepitesen nincs fajl, nincs sajat mod, a beepitettek elnek', () => {
    expect(existsSync(DEBATE_MODES_PATH)).toBe(false)
    expect(loadStoredModes()).toEqual([])
    expect(lookupMode('critic')!.builtin).toBe(true)
    expect(lookupMode('nincs')).toBeNull()
    expect(lookupMode(undefined)!.id).toBe('peer')
  })

  it('mentes: uj azonositot kap; a keresheto, futtathato mod lesz; a fajl olvashato JSON, nem marad .tmp', () => {
    const r = saveStoredMode(MODE)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.mode.id).toMatch(/^m-[0-9a-f]{8}$/)
    expect(JSON.parse(readFileSync(DEBATE_MODES_PATH, 'utf-8'))).toMatchObject({ version: 1, modes: [{ name: 'Szigoru atnezes' }] })
    expect(readdirSync(h.dir).filter(f => f.endsWith('.tmp'))).toEqual([])
    expect(lookupMode(r.mode.id)).toMatchObject({ name: 'Szigoru atnezes', strength: 'hard', maxRounds: 3, builtin: false })
    expect(loadCustomModes()).toHaveLength(1)
  })

  it('azonos azonositoval mentve felulirja (szerkesztes), nem duplazza', () => {
    const a = saveStoredMode(MODE)
    if (!a.ok) throw new Error('save')
    const b = saveStoredMode({ ...MODE, id: a.mode.id, name: 'Atnevezve' })
    expect(b).toMatchObject({ ok: true, mode: { id: a.mode.id, name: 'Atnevezve' } })
    expect(loadStoredModes()).toHaveLength(1)
    expect(loadStoredModes()[0].name).toBe('Atnevezve')
  })

  it('hibas mentes nem ir semmit; a hibakod a szerkeszto uzenete', () => {
    expect(saveStoredMode({ ...MODE, name: '' })).toEqual({ ok: false, error: 'name_missing' })
    expect(existsSync(DEBATE_MODES_PATH)).toBe(false)
  })

  it('legfeljebb annyi sajat mod, amennyit a hatar enged', () => {
    for (let i = 0; i < MODES_MAX; i++) expect(saveStoredMode({ ...MODE, name: `M${i}` }).ok).toBe(true)
    expect(saveStoredMode({ ...MODE, name: 'tul sok' })).toEqual({ ok: false, error: 'too_many' })
    // egy meglevo szerkesztese meg megy
    const id = loadStoredModes()[0].id
    expect(saveStoredMode({ ...MODE, id, name: 'szerkesztve' }).ok).toBe(true)
  })

  it('torles: a mod eltunik, a masik marad; ismeretlen azonosito -> false', () => {
    const a = saveStoredMode(MODE); const b = saveStoredMode({ ...MODE, name: 'Masik' })
    if (!a.ok || !b.ok) throw new Error('save')
    expect(deleteStoredMode(a.mode.id)).toBe(true)
    expect(lookupMode(a.mode.id)).toBeNull()
    expect(lookupMode(b.mode.id)).not.toBeNull()
    expect(deleteStoredMode(a.mode.id)).toBe(false)
  })

  it('kezzel elrontott fajl nem viszi el a vitat: serult JSON = nincs sajat mod; serult bejegyzes kimarad, a tobbi marad', () => {
    writeFileSync(DEBATE_MODES_PATH, '{ nem json')
    expect(loadStoredModes()).toEqual([])
    expect(lookupMode('critic')).not.toBeNull()
    writeFileSync(DEBATE_MODES_PATH, JSON.stringify({ version: 1, modes: [
      { id: 'm-aaaaaaaa', name: 'Jo', base: 'peer' },
      { id: 'm-bbbbbbbb', name: '', base: 'peer' },
      { name: 'azonosito nelkul', base: 'peer' },
      { id: 'm-aaaaaaaa', name: 'dupla', base: 'peer' },
      'szemet',
    ] }))
    expect(loadStoredModes().map(m => m.name)).toEqual(['Jo'])
    writeFileSync(DEBATE_MODES_PATH, JSON.stringify({ modes: 'nem lista' }))
    expect(loadStoredModes()).toEqual([])
  })
})
