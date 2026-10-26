// #749: a link left behind by the Life-tree move points at the REAL place of the file (behind a Drive/Photos mount:
// `drive/anna/...`), while a rename or move in the Eletfa reports the TREE path (`Család/Anna/Dokumentumok/...`). The link
// must follow the rename / move all the same, or it leads to nothing.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const store = mkdtempSync(join(tmpdir(), 'marveen-follow-mount-store-'))
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store }
})

const { initDatabase } = await import('../db.js')
const { addMount, listMounts, resolveMount } = await import('../life-mounts.js')
const { renameLife, moveLife, resolveLifePath } = await import('../life-explorer.js')
const { followFolderMove, moveMountPoint } = await import('../life-follow.js')

const LINK = 'Projektek/Iroda/Antrag/antrag.pdf'

describe('#749: links into a mounted folder follow a rename / move in the Eletfa', () => {
  let depot = ''
  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-follow-mount-'))
    process.env['MARVEEN_DEPOT'] = depot
    mkdirSync(join(depot, 'Projektek', 'Iroda', 'Antrag'), { recursive: true })
    mkdirSync(join(depot, 'drive', 'anna', 'Dokumentumok', 'Hivatalos'), { recursive: true })
    mkdirSync(join(depot, 'drive', 'anna', 'Dokumentumok', 'Archiv'), { recursive: true })
    writeFileSync(join(depot, 'drive', 'anna', 'Dokumentumok', 'Hivatalos', 'antrag.pdf'), 'v1')
    const m = addMount({ rel: 'Család/Anna/Dokumentumok', target: 'drive/anna/Dokumentumok', kind: 'drive', label: 'Anna Drive' })
    if (!m.ok) throw new Error('mount ' + m.message)
    const l = addMount({ rel: LINK, target: 'drive/anna/Dokumentumok/Hivatalos/antrag.pdf', kind: 'local', label: 'antrag.pdf', file: true })
    if (!l.ok) throw new Error('link ' + l.message)
  })
  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    rmSync(join(store, 'life-mounts.json'), { force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  it('renaming the folder behind the mount re-points the link to the renamed real place', () => {
    const r = renameLife('Család/Anna/Dokumentumok/Hivatalos', 'Behörden', 'hu')
    expect(r.ok).toBe(true)
    followFolderMove('Család/Anna/Dokumentumok/Hivatalos', r.rel)
    expect(resolveMount(LINK)?.target).toBe('drive/anna/Dokumentumok/Behörden/antrag.pdf')
    expect(readFileSync(resolveLifePath(LINK) as string, 'utf8')).toBe('v1')
  })

  it('moving the file itself within the mount re-points the link', () => {
    const r = moveLife('Család/Anna/Dokumentumok/Hivatalos/antrag.pdf', 'Család/Anna/Dokumentumok/Archiv', 'hu')
    expect(r.ok).toBe(true)
    followFolderMove('Család/Anna/Dokumentumok/Hivatalos/antrag.pdf', r.rel)
    expect(resolveMount(LINK)?.target).toBe('drive/anna/Dokumentumok/Archiv/antrag.pdf')
    expect(readFileSync(resolveLifePath(LINK) as string, 'utf8')).toBe('v1')
  })

  it('moving the file out of the mount into the plain tree re-points the link there', () => {
    mkdirSync(join(depot, 'Iratok'), { recursive: true })
    const r = moveLife('Család/Anna/Dokumentumok/Hivatalos/antrag.pdf', 'Iratok', 'hu')
    expect(r.ok).toBe(true)
    followFolderMove('Család/Anna/Dokumentumok/Hivatalos/antrag.pdf', r.rel)
    expect(resolveMount(LINK)?.target).toBe('Iratok/antrag.pdf')
    expect(readFileSync(resolveLifePath(LINK) as string, 'utf8')).toBe('v1')
  })

  it('moving the mount point itself keeps every target as it was', () => {
    mkdirSync(join(depot, 'Család', 'Anna', 'Dokumentumok'), { recursive: true })
    mkdirSync(join(depot, 'Család', 'Béla'), { recursive: true })
    const r = moveMountPoint('Család/Anna/Dokumentumok', 'Család/Béla')
    expect(r.ok).toBe(true)
    const drive = listMounts().find((m) => m.kind === 'drive')
    expect(drive?.rel).toBe('Család/Béla/Dokumentumok')
    expect(drive?.target).toBe('drive/anna/Dokumentumok')
    expect(resolveMount(LINK)?.target).toBe('drive/anna/Dokumentumok/Hivatalos/antrag.pdf')
  })
})
