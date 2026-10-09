// #510: a folder renamed OUTSIDE Marveen (Windows Explorer) is found again by
// its hidden id, and the registries that know it by path follow it.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, renameSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const depot = mkdtempSync(join(tmpdir(), 'marveen-fid-'))
const store = mkdtempSync(join(tmpdir(), 'marveen-fidstore-'))
process.env.MARVEEN_DEPOT = depot

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, STORE_DIR: store }
})

const { reconcileLifeFolderIds, listLifeFolderIds, anchoredFolders, LIFE_FOLDER_MARKER } = await import('../life-folder-ids.js')
const { setBackupRule, loadBackupRules } = await import('../backup-rules.js')
const { addMount, listMounts } = await import('../life-mounts.js')

const marker = (rel: string): string | null => {
  try { return readFileSync(join(depot, rel, LIFE_FOLDER_MARKER), 'utf8').trim() } catch { return null }
}

describe('life folder ids (#510)', () => {
  beforeEach(() => {
    for (const f of ['backup-rules.json', 'life-mounts.json', 'life-folder-ids.json']) rmSync(join(store, f), { force: true })
    rmSync(depot, { recursive: true, force: true })
    mkdirSync(depot, { recursive: true })
  })

  it('only folders a registry refers to get a marker', async () => {
    mkdirSync(join(depot, 'Cegek', 'Alfa', 'Iratok'), { recursive: true })
    mkdirSync(join(depot, 'Cegek', 'Beta'), { recursive: true })
    setBackupRule({ path: 'Cegek/Alfa', action: 'target', target: { kind: 'drive', account: 't' } })
    const r = await reconcileLifeFolderIds()
    expect(r.stamped).toBe(1)
    expect(marker('Cegek/Alfa')).toMatch(/^[0-9a-f-]{36}$/)
    expect(marker('Cegek/Beta')).toBeNull()
    expect(marker('Cegek/Alfa/Iratok')).toBeNull()
    expect(marker('Cegek')).toBeNull()
    expect(listLifeFolderIds().map((x) => x.rel)).toEqual(['Cegek/Alfa'])
    // a second pass changes nothing
    expect((await reconcileLifeFolderIds()).stamped).toBe(0)
  })

  it('a folder renamed outside Marveen is found, and the backup rule and the link follow it', async () => {
    mkdirSync(join(depot, 'Tarolo', 'belso'), { recursive: true })
    mkdirSync(join(depot, 'Cegek', 'Alfa', 'Fejlesztes'), { recursive: true })
    writeFileSync(join(depot, 'Cegek', 'Alfa', 'szamla.pdf'), 'x')
    setBackupRule({ path: 'Cegek/Alfa', action: 'target', target: { kind: 'drive', account: 't' } })
    expect(addMount({ rel: 'Cegek/Alfa/Fejlesztes/Kotes', target: 'Tarolo' }).ok).toBe(true)
    await reconcileLifeFolderIds()
    const id = marker('Cegek/Alfa')

    renameSync(join(depot, 'Cegek', 'Alfa'), join(depot, 'Cegek', 'Alfa Uj Neve')) // the Windows Explorer did this
    const r = await reconcileLifeFolderIds()
    expect(r.moved).toEqual([{ from: 'Cegek/Alfa', to: 'Cegek/Alfa Uj Neve' }])
    expect(r.lost).toEqual([])
    expect(loadBackupRules().rules.map((x) => x.path)).toEqual(['Cegek/Alfa Uj Neve'])
    expect(listMounts().map((m) => m.rel)).toEqual(['Cegek/Alfa Uj Neve/Fejlesztes/Kotes'])
    expect(listLifeFolderIds().find((x) => x.id === id)?.rel).toBe('Cegek/Alfa Uj Neve')
    expect(existsSync(join(depot, 'Cegek', 'Alfa Uj Neve', 'szamla.pdf'))).toBe(true)
  })

  it('a folder MOVED elsewhere in the tree is found too, and a link target that moved keeps its links', async () => {
    mkdirSync(join(depot, 'Rendszer', 'Tarolok', 'Drive1', 'docs'), { recursive: true })
    mkdirSync(join(depot, 'Csalad', 'Anna'), { recursive: true })
    mkdirSync(join(depot, 'Archiv'), { recursive: true })
    expect(addMount({ rel: 'Csalad/Anna/Drive', target: 'Rendszer/Tarolok/Drive1' }).ok).toBe(true)
    await reconcileLifeFolderIds()
    expect(marker('Rendszer/Tarolok/Drive1')).not.toBeNull()

    renameSync(join(depot, 'Rendszer', 'Tarolok', 'Drive1'), join(depot, 'Archiv', 'Regi Drive'))
    const r = await reconcileLifeFolderIds()
    expect(r.moved).toEqual([{ from: 'Rendszer/Tarolok/Drive1', to: 'Archiv/Regi Drive' }])
    expect(listMounts().map((m) => [m.rel, m.target])).toEqual([['Csalad/Anna/Drive', 'Archiv/Regi Drive']])
  })

  it('a folder that is nowhere is reported lost and KEPT; nothing is rewritten', async () => {
    mkdirSync(join(depot, 'Cegek', 'Alfa'), { recursive: true })
    setBackupRule({ path: 'Cegek/Alfa', action: 'none' })
    await reconcileLifeFolderIds()
    rmSync(join(depot, 'Cegek', 'Alfa'), { recursive: true, force: true })
    const r = await reconcileLifeFolderIds()
    expect(r.lost).toEqual(['Cegek/Alfa'])
    expect(r.moved).toEqual([])
    expect(loadBackupRules().rules.map((x) => x.path)).toEqual(['Cegek/Alfa'])
    expect(listLifeFolderIds().map((x) => x.rel)).toEqual(['Cegek/Alfa'])
  })

  it('a COPY of the folder (same id twice) is not followed -- it is ambiguous', async () => {
    mkdirSync(join(depot, 'Cegek', 'Alfa'), { recursive: true })
    setBackupRule({ path: 'Cegek/Alfa', action: 'none' })
    await reconcileLifeFolderIds()
    cpSync(join(depot, 'Cegek', 'Alfa'), join(depot, 'Cegek', 'Masolat1'), { recursive: true })
    renameSync(join(depot, 'Cegek', 'Alfa'), join(depot, 'Cegek', 'Masolat2'))
    const r = await reconcileLifeFolderIds()
    expect(r.ambiguous).toEqual(['Cegek/Alfa'])
    expect(loadBackupRules().rules.map((x) => x.path)).toEqual(['Cegek/Alfa'])
  })

  it('an unreachable depot is not a rename: nothing happens, and it says why', async () => {
    mkdirSync(join(depot, 'Cegek', 'Alfa'), { recursive: true })
    setBackupRule({ path: 'Cegek/Alfa', action: 'none' })
    await reconcileLifeFolderIds()
    rmSync(depot, { recursive: true, force: true }) // the disk is not mounted
    const r = await reconcileLifeFolderIds()
    expect(r.skipped).toBe('unreachable')
    expect(listLifeFolderIds().map((x) => x.rel)).toEqual(['Cegek/Alfa'])
  })

  it('when nothing refers to a folder any more, our own marker is removed -- a marker we did not write is left', async () => {
    mkdirSync(join(depot, 'Cegek', 'Alfa'), { recursive: true })
    mkdirSync(join(depot, 'Cegek', 'Beta'), { recursive: true })
    const foreign = '11111111-2222-3333-4444-555555555555'
    writeFileSync(join(depot, 'Cegek', 'Beta', LIFE_FOLDER_MARKER), foreign + '\n')
    setBackupRule({ path: 'Cegek/Alfa', action: 'none' })
    setBackupRule({ path: 'Cegek/Beta', action: 'none' })
    await reconcileLifeFolderIds()
    expect(marker('Cegek/Beta')).toBe(foreign) // adopted, not overwritten
    setBackupRule({ path: 'Cegek/Alfa', action: 'inherit' })
    setBackupRule({ path: 'Cegek/Beta', action: 'inherit' })
    expect(await anchoredFolders()).toEqual([])
    await reconcileLifeFolderIds()
    expect(marker('Cegek/Alfa')).toBeNull()
    expect(marker('Cegek/Beta')).toBe(foreign)
    expect(listLifeFolderIds()).toEqual([])
  })

  it('nothing is written into a git repository or through a link', async () => {
    mkdirSync(join(depot, 'Repo', '.git'), { recursive: true })
    mkdirSync(join(depot, 'Fa'), { recursive: true })
    expect(addMount({ rel: 'Fa/Kotes', target: 'Repo', kind: 'local' }).ok).toBe(true)
    setBackupRule({ path: 'Fa/Kotes', action: 'none' })
    await reconcileLifeFolderIds()
    expect(marker('Repo')).toBeNull()
    expect(existsSync(join(depot, 'Fa', 'Kotes', LIFE_FOLDER_MARKER))).toBe(false)
  })
})
