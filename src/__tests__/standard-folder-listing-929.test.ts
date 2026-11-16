// #929: the startup pass probed ~20 standard subfolder names per work item, each probe resolving the path again and
// paying several calls to the Windows drive (measured live: 144 realpathSync = 3.4 s and 603 existsSync = 3.0 s on the
// main thread under /mnt/f). One directory listing per item answers which names exist; only those are probed.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const depot = mkdtempSync(join(tmpdir(), 'marveen-sfl-'))
const store = mkdtempSync(join(tmpdir(), 'marveen-sfl-store-'))
process.env.MARVEEN_DEPOT = depot
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store, APP_LANG: 'hu' }
})

const { initDatabase } = await import('../db.js')
const { createProject } = await import('../projects.js')
const { noteOneStandardFolder, standardFolderListing, itemStandardFolderNames, folderWasMade } = await import('../project-files.js')
const { startSlowFsWatch, slowFsReport, _resetSlowFsWatch } = await import('../web/slow-fs-watch.js')

function setup() {
  mkdirSync(join(depot, 'Projektek', 'P', 'Munka', 'Mellékletek'), { recursive: true })
  mkdirSync(join(depot, 'Projektek', 'P', 'Munka', 'versions'), { recursive: true }) // another case than "Versions"
  writeFileSync(join(depot, 'Projektek', 'P', 'Munka', 'Attachments'), 'a plain FILE, not a folder')
  const r = createProject({ name: 'P', folder_path: 'Projektek/P' })
  if (!r.ok) throw new Error(r.code)
  return r.project
}

describe('#929 standard folders of an item are found with ONE listing, not ~20 probes', () => {
  beforeEach(() => { initDatabase(':memory:') })
  afterEach(() => { _resetSlowFsWatch(); for (const d of [depot, store]) rmSync(d, { recursive: true, force: true }) })

  it('notes the same folders as probing every name, including a differently cased one, and not a plain file', () => {
    const p = setup()
    const listing = standardFolderListing(p, 'Munka')
    expect(listing).not.toBeNull()
    for (const n of itemStandardFolderNames()) noteOneStandardFolder(p, 'Munka', n, listing)
    expect(folderWasMade(p, 'Munka/Mellékletek')).toBe(true)
    // The listing keys are lower-cased (the Windows drive is case-insensitive); a case-sensitive test disk has no "Versions".
    expect(listing!.has('versions')).toBe(true)
    expect(folderWasMade(p, 'Munka/versions')).toBe(false) // not a standard name, never probed
    expect(folderWasMade(p, 'Munka/Attachments')).toBe(false) // a file is no folder
    expect(folderWasMade(p, 'Munka/Uploads')).toBe(false) // not there at all
  })

  it('without a listing (unreadable folder) every name is still probed, as before', () => {
    const p = setup()
    for (const n of itemStandardFolderNames()) noteOneStandardFolder(p, 'Munka', n, null)
    expect(folderWasMade(p, 'Munka/Mellékletek')).toBe(true)
  })

  it('pays far fewer file-system calls than probing every name (the measured freeze cost)', () => {
    const p = setup()
    startSlowFsWatch({ prefixes: [depot] })
    const calls = (): number => slowFsReport().worst.reduce((a, b) => a + b.calls, 0)
    const c0 = calls()
    for (const n of itemStandardFolderNames()) noteOneStandardFolder(p, 'Munka', n, null)
    const probing = calls() - c0
    const c1 = calls()
    const listing = standardFolderListing(p, 'Munka')
    for (const n of itemStandardFolderNames()) noteOneStandardFolder(p, 'Munka', n, listing)
    const listed = calls() - c1
    expect(probing).toBeGreaterThan(40)
    expect(listed).toBeLessThan(probing / 3)
  })
})
