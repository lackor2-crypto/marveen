// THE PERSONS' COMMON FOLDER ("Család").
//
// What must hold:
//   - no group = the old layout, byte for byte (a saved config without the
//     field keeps its tree),
//   - with a group, every person path goes through it -- tree plan, archive,
//     inbox known folders, explorer owner,
//   - moving existing folders is all-or-nothing, never overwrites, and the
//     stores keyed by path (mounts, labels, ledger) follow the folders.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const depot = mkdtempSync(join(tmpdir(), 'marveen-pgroup-'))
const store = mkdtempSync(join(tmpdir(), 'marveen-pgstore-'))
process.env.MARVEEN_DEPOT = depot

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store }
})

const { planLifeTree, ensureLifeTree, personRel, normalizeLifeConfig } = await import('../life-tree.js')
const { planPersonsGroupMove, applyPersonsGroupMove } = await import('../life-persons-group.js')
const { buildKnownFolders } = await import('../life-inbox-analyze.js')
const { addMount, listMounts } = await import('../life-mounts.js')
const { setDisplayLabel, displayLabelFor } = await import('../life-labels.js')
const { DEPOT_PHOTOS } = await import('../depot.js')

const person = (id: string, name: string, role: 'owner' | 'person' = 'person') =>
  ({ id, name, role, countries: [], mediaGroups: ['Család'] })
const flat = { persons: [person('a', 'Teszt Elek', 'owner'), person('b', 'Teszt Anna')], companies: [] }
const grouped = { ...flat, personsGroup: 'Család' }

function wipe(): void {
  for (const n of readdirSync(depot)) rmSync(join(depot, n), { recursive: true, force: true })
  for (const n of readdirSync(store)) rmSync(join(store, n), { recursive: true, force: true })
}

beforeEach(wipe)

describe('personRel / planLifeTree', () => {
  it('no group: the persons stay at the root (old layout unchanged)', () => {
    expect(personRel(flat, 'Teszt Elek')).toBe('Teszt Elek')
    const rels = planLifeTree(flat, 'hu').map((n) => n.rel)
    expect(rels).toContain('Teszt Elek')
    expect(rels).toContain('Archív/Teszt Anna')
    expect(rels.some((r) => r.startsWith('Család'))).toBe(false)
    expect(normalizeLifeConfig({ persons: flat.persons }).personsGroup).toBe('')
  })

  it('with a group: persons and their archive go under it', () => {
    const rels = planLifeTree(grouped, 'hu').map((n) => n.rel)
    expect(rels).toContain('Család')
    expect(rels).toContain('Család/Teszt Elek')
    expect(rels).toContain('Család/Teszt Anna/Média')
    expect(rels).toContain('Archív/Család/Teszt Anna')
    expect(rels).not.toContain('Teszt Elek')
    expect(rels).not.toContain('Archív/Teszt Anna')
  })

  it('inbox known folders are found under the group', () => {
    ensureLifeTree(grouped, 'hu')
    const known = buildKnownFolders(grouped, 'hu')
    expect(known.length).toBeGreaterThan(0)
    expect(known.every((f) => f.rel.startsWith('Család/'))).toBe(true)
  })
})

describe('moving existing folders into the group', () => {
  it('preview lists person + archive folders, apply moves them and the stores follow', () => {
    ensureLifeTree(flat, 'hu')
    writeFileSync(join(depot, 'Teszt Anna', 'irat.pdf'), 'x', 'utf8')
    mkdirSync(join(depot, ...DEPOT_PHOTOS.split('/'), 'fiok'), { recursive: true })
    expect(addMount({ rel: 'Teszt Elek/Média/Fotók', target: `${DEPOT_PHOTOS}/fiok`, kind: 'photos', label: 'x' }).ok).toBe(true)
    setDisplayLabel('Teszt Elek/Projektek', 'Saját')

    const plan = planPersonsGroupMove(normalizeLifeConfig(flat), normalizeLifeConfig(grouped), 'hu')
    expect(plan.moves.map((m) => `${m.from}>${m.to}`).sort()).toEqual([
      'Archív/Teszt Anna>Archív/Család/Teszt Anna',
      'Archív/Teszt Elek>Archív/Család/Teszt Elek',
      'Teszt Anna>Család/Teszt Anna',
      'Teszt Elek>Család/Teszt Elek',
    ])
    expect(plan.moves.some((m) => m.conflict)).toBe(false)

    const r = applyPersonsGroupMove(plan)
    expect(r.ok).toBe(true)
    expect(existsSync(join(depot, 'Család', 'Teszt Anna', 'irat.pdf'))).toBe(true)
    expect(existsSync(join(depot, 'Teszt Anna'))).toBe(false)
    expect(listMounts()[0].rel).toBe('Család/Teszt Elek/Média/Fotók')
    expect(displayLabelFor('Család/Teszt Elek/Projektek')).toBe('Saját')
    const ledger = JSON.parse(readFileSync(join(store, 'life-tree-created.json'), 'utf8'))
    expect(ledger.created).toContain('Család/Teszt Anna/Média')
    expect(ledger.created.some((x: string) => x.startsWith('Teszt Anna'))).toBe(false)

    // After the move a build creates nothing new at the root.
    ensureLifeTree(grouped, 'hu')
    expect(existsSync(join(depot, 'Teszt Anna'))).toBe(false)
  })

  it('a folder the user deleted earlier is NOT brought back after the move', () => {
    ensureLifeTree(flat, 'hu')
    rmSync(join(depot, 'Teszt Anna', 'Munka'), { recursive: true, force: true })
    ensureLifeTree(flat, 'hu') // records the deletion as the user's decision
    const r = applyPersonsGroupMove(planPersonsGroupMove(normalizeLifeConfig(flat), normalizeLifeConfig(grouped), 'hu'))
    expect(r.ok).toBe(true)
    ensureLifeTree(grouped, 'hu')
    expect(existsSync(join(depot, 'Család', 'Teszt Anna', 'Munka'))).toBe(false)
  })

  it('refuses a target that exists and never overwrites; a failure rolls everything back', () => {
    ensureLifeTree(flat, 'hu')
    mkdirSync(join(depot, 'Család', 'Teszt Anna'), { recursive: true })
    writeFileSync(join(depot, 'Család', 'Teszt Anna', 'mas.txt'), 'y', 'utf8')
    const plan = planPersonsGroupMove(normalizeLifeConfig(flat), normalizeLifeConfig(grouped), 'hu')
    expect(plan.moves.find((m) => m.from === 'Teszt Anna')?.conflict).toBe(true)
    const r = applyPersonsGroupMove(plan)
    expect(r.ok).toBe(false)
    expect(existsSync(join(depot, 'Teszt Elek'))).toBe(true)
    expect(existsSync(join(depot, 'Teszt Anna'))).toBe(true)
    expect(readFileSync(join(depot, 'Család', 'Teszt Anna', 'mas.txt'), 'utf8')).toBe('y')
  })

  it('a failed move leaves no empty group folder behind, but keeps one with content', () => {
    ensureLifeTree(flat, 'hu')
    mkdirSync(join(depot, 'Archív', 'Család', 'Teszt Anna'), { recursive: true })
    writeFileSync(join(depot, 'Archív', 'Család', 'Teszt Anna', 'mas.txt'), 'y', 'utf8')
    const r = applyPersonsGroupMove(planPersonsGroupMove(normalizeLifeConfig(flat), normalizeLifeConfig(grouped), 'hu'))
    expect(r.ok).toBe(false)
    expect(r.rolledBack).toBe(true)
    expect(existsSync(join(depot, 'Család'))).toBe(false)
    expect(existsSync(join(depot, 'Teszt Elek'))).toBe(true)
    expect(readFileSync(join(depot, 'Archív', 'Család', 'Teszt Anna', 'mas.txt'), 'utf8')).toBe('y')
  })

  it('lock errors are recognised (the message tells the user to close the program)', async () => {
    const { isLockError } = await import('../life-persons-group.js')
    expect(isLockError('EACCES')).toBe(true)
    expect(isLockError('EBUSY')).toBe(true)
    expect(isLockError('ENOENT')).toBe(false)
  })

  it('same group: nothing to move', () => {
    ensureLifeTree(grouped, 'hu')
    expect(planPersonsGroupMove(normalizeLifeConfig(grouped), normalizeLifeConfig(grouped), 'hu').moves).toEqual([])
  })
})

describe('explorer with a group', () => {
  it('the group sits at the top with its hint, persons inside it get the person hint and owner', async () => {
    const { listLife, lifeInfo } = await import('../life-explorer.js')
    const { saveLifeConfig } = await import('../life-tree.js')
    saveLifeConfig(normalizeLifeConfig(grouped))
    ensureLifeTree(grouped, 'hu')
    const top = listLife('', { deep: false, lang: 'hu' })
    const inboxIdx = top.folders.findIndex((f) => f.name === 'Beérkező')
    const grpIdx = top.folders.findIndex((f) => f.name === 'Család')
    expect(grpIdx).toBe(inboxIdx + 1)
    expect(top.folders[grpIdx].hint).toBeTruthy()
    const inside = listLife('Család', { deep: false, lang: 'hu' })
    expect(inside.folders.map((f) => f.name)).toEqual(['Teszt Elek', 'Teszt Anna'])
    expect(inside.folders[0].hint).toBeTruthy()
    expect(lifeInfo('Család/Teszt Anna/Jogi', 'hu')?.owner).toBe('Teszt Anna')
    expect(lifeInfo('Archív/Család/Teszt Anna', 'hu')?.owner).toBe('Teszt Anna')
  })
})

describe('empty group is really empty', () => {
  it('"" and spaces mean no group (not a folder called "_")', () => {
    expect(normalizeLifeConfig({ persons: flat.persons, personsGroup: '' }).personsGroup).toBe('')
    expect(normalizeLifeConfig({ persons: flat.persons, personsGroup: '   ' }).personsGroup).toBe('')
    expect(personRel({ personsGroup: '  ' }, 'Teszt Elek')).toBe('Teszt Elek')
  })
})
