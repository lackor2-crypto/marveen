// #873: a linked Life-tree document renamed / moved OUTSIDE Marveen (Windows Explorer) is followed by the guard; a
// deleted one is reported once (channel + desktop), kept as "missing", and recovers by itself when the file is back.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, renameSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const store = mkdtempSync(join(tmpdir(), 'marveen-link-guard-store-'))
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store }
})

// Counts directory reads (passthrough) so a test can tell how many times the whole tree was walked.
const readdirCalls: string[] = []
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return { ...actual, readdir: ((p: unknown, ...a: unknown[]) => { readdirCalls.push(String(p)); return (actual.readdir as (...x: unknown[]) => unknown)(p, ...a) }) as typeof actual.readdir }
})

const { initDatabase } = await import('../db.js')
const { createProject, updateProject } = await import('../projects.js')
const { addProjectDoc, listProjectDocs } = await import('../workbench-doc-links.js')
const { addMount, listMounts } = await import('../life-mounts.js')
const { sweepLinkedDocs, readMissingState, missingNoticeText } = await import('../linked-docs-guard.js')
const { documentIdFor, hashDocument } = await import('../life-doc-ids.js')

const CERT = 'Család/Anna/Hatóságok/igazolas.pdf'

describe('#873 linked document guard', () => {
  let depot = ''
  let projectId = ''
  const abs = (rel: string) => join(depot, ...rel.split('/'))
  const notices: string[][] = []
  const deps = { notify: async (e: Array<{ rel: string; uses: string[] }>) => { notices.push(e.map((x) => x.rel)) } }

  beforeEach(async () => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-link-guard-'))
    process.env['MARVEEN_DEPOT'] = depot
    notices.length = 0
    rmSync(join(store, 'linked-docs-missing.json'), { force: true })
    rmSync(join(store, 'life-mounts.json'), { force: true })
    mkdirSync(join(abs(CERT), '..'), { recursive: true })
    writeFileSync(abs(CERT), 'CERTIFICATE-CONTENT-123')
    const p = createProject({ name: 'Wohngeld' })
    if (!p.ok) throw new Error('project')
    projectId = p.project.id
    updateProject(projectId, { folder_path: 'Projektek/Wohngeld' })
    mkdirSync(abs('Projektek/Wohngeld'), { recursive: true })
    const r = await addProjectDoc(projectId, CERT, { role: 'source' }, 't')
    if (!r.ok) throw new Error('addProjectDoc ' + JSON.stringify(r))
    const id = documentIdFor(CERT)
    if (!id) throw new Error('no id')
    await hashDocument(id)
  })
  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  it('a file renamed outside Marveen: the project document follows, nothing is reported', async () => {
    renameSync(abs(CERT), abs('Család/Anna/Hatóságok/igazolas-ujra.pdf'))
    const r = await sweepLinkedDocs(deps)
    expect(r.followed).toBe(1)
    expect(r.missing).toBe(0)
    expect(notices).toEqual([])
    const d = listProjectDocs(projectId).docs[0]!
    expect([d.exists, d.life_rel]).toEqual([true, 'Család/Anna/Hatóságok/igazolas-ujra.pdf'])
  })

  it('a file moved to another folder: followed by content', async () => {
    mkdirSync(abs('Család/Anna/Archívum'), { recursive: true })
    renameSync(abs(CERT), abs('Család/Anna/Archívum/igazolas.pdf'))
    const r = await sweepLinkedDocs(deps)
    expect(r.followed).toBe(1)
    expect(listProjectDocs(projectId).docs[0]!.life_rel).toBe('Család/Anna/Archívum/igazolas.pdf')
  })

  it('a deleted file is reported ONCE, stays as missing, and recovers when it is back', async () => {
    rmSync(abs(CERT))
    const r1 = await sweepLinkedDocs(deps)
    expect([r1.missing, r1.newlyMissing]).toEqual([1, 1])
    expect(notices).toEqual([[CERT]])
    expect(Object.keys(readMissingState()).length).toBe(1)
    expect(listProjectDocs(projectId).docs[0]!.exists).toBe(false)
    const r2 = await sweepLinkedDocs(deps)
    expect([r2.missing, r2.newlyMissing]).toEqual([1, 0])
    expect(notices.length).toBe(1)
    writeFileSync(abs(CERT), 'CERTIFICATE-CONTENT-123')
    const r3 = await sweepLinkedDocs(deps)
    expect(r3.missing).toBe(0)
    expect(readMissingState()).toEqual({})
  })

  it('an entry the owner set to ignored stays quiet: not counted, not marked, not reported again', async () => {
    rmSync(abs(CERT))
    await sweepLinkedDocs(deps)
    const st = readMissingState()
    for (const e of Object.values(st)) e.ignored = true
    writeFileSync(join(store, 'linked-docs-missing.json'), JSON.stringify(st))
    const r = await sweepLinkedDocs(deps)
    expect([r.missing, r.newlyMissing]).toEqual([0, 0])
    expect(notices.length).toBe(1)
    expect(Object.values(readMissingState())[0]!.ignored).toBe(true)
  })

  it('a file already searched for and not found is not searched again every sweep, only after the retry time', async () => {
    const hold = abs('Család/Anna/hold.bin')
    renameSync(abs(CERT), hold) // not inside the depot walk: dot-less name, so move it out of the depot tree first
    const outside = join(depot, '..', `marveen-hold-${Date.now()}.pdf`)
    renameSync(hold, outside)
    await sweepLinkedDocs(deps)
    expect(Object.keys(readMissingState()).length).toBe(1)
    expect(typeof Object.values(readMissingState())[0]!.searchedAt).toBe('number')
    renameSync(outside, abs('Család/Anna/Archívum-uj.pdf'))
    const r2 = await sweepLinkedDocs(deps)
    expect([r2.followed, r2.missing]).toEqual([0, 1]) // searched a moment ago: not again
    const st = readMissingState()
    for (const e of Object.values(st)) e.searchedAt = 0
    writeFileSync(join(store, 'linked-docs-missing.json'), JSON.stringify(st))
    const r3 = await sweepLinkedDocs(deps)
    expect(r3.followed).toBe(1)
    expect(readMissingState()).toEqual({})
  })

  // #875: several missing documents in one sweep (a deleted folder) must share ONE walk of the whole tree, not walk it once each.
  it('several missing documents in one sweep share one walk of the whole tree', async () => {
    const extra = ['Család/Anna/Hatóságok/masik-1.pdf', 'Család/Anna/Hatóságok/masik-2.pdf', 'Család/Anna/Hatóságok/masik-3.pdf']
    for (const [i, rel] of extra.entries()) {
      writeFileSync(abs(rel), `OTHER-CONTENT-${i}-${'x'.repeat(i * 7)}`)
      const r = await addProjectDoc(projectId, rel, { role: 'source' }, 't')
      if (!r.ok) throw new Error('addProjectDoc ' + JSON.stringify(r))
      await hashDocument(documentIdFor(rel)!)
    }
    for (const rel of [CERT, ...extra]) rmSync(abs(rel))
    const before = readdirCalls.filter((p) => p === depot).length
    const r = await sweepLinkedDocs(deps)
    const walks = readdirCalls.filter((p) => p === depot).length - before
    expect([r.missing, r.newlyMissing]).toEqual([4, 4])
    expect(notices.length).toBe(1) // one notice for the sweep
    expect(notices[0]!.length).toBe(4)
    expect(walks).toBe(1)
  })

  it('a document found through the shared walk still follows its move', async () => {
    mkdirSync(abs('Család/Anna/Archívum'), { recursive: true })
    const other = 'Család/Anna/Hatóságok/masik.pdf'
    writeFileSync(abs(other), 'OTHER-CONTENT-ZZ')
    const r0 = await addProjectDoc(projectId, other, { role: 'source' }, 't')
    if (!r0.ok) throw new Error('addProjectDoc')
    await hashDocument(documentIdFor(other)!)
    renameSync(abs(CERT), abs('Család/Anna/Archívum/igazolas.pdf')) // moved: found by content
    rmSync(abs(other)) // deleted: reported
    const r = await sweepLinkedDocs(deps)
    expect([r.followed, r.newlyMissing]).toEqual([1, 1])
    expect(notices).toEqual([[other]])
  })

  it('a linked FILE (left-behind link) follows an outside rename; its target is repointed', async () => {
    const left = 'Projektek/Wohngeld/Antrag/antrag.pdf'
    mkdirSync(join(abs('Projektek/Wohngeld/Antrag')), { recursive: true })
    const real = 'Család/Anna/Hatóságok/antrag.pdf'
    writeFileSync(abs(real), 'ANTRAG-BYTES-XYZ')
    expect(addMount({ rel: left, target: real, kind: 'local', label: real, file: true }).ok).toBe(true)
    await sweepLinkedDocs(deps) // gives the file an id and hashes it
    renameSync(abs(real), abs('Család/Anna/Hatóságok/antrag-uj.pdf'))
    const r = await sweepLinkedDocs(deps)
    expect(r.followed).toBeGreaterThanOrEqual(1)
    expect(listMounts().find((m) => m.rel === left)!.target).toBe('Család/Anna/Hatóságok/antrag-uj.pdf')
    expect(notices).toEqual([])
  })

  it('a linked file deleted outside: reported with its place; text names where it was used', async () => {
    rmSync(abs(CERT))
    await sweepLinkedDocs(deps)
    const st = Object.values(readMissingState())[0]!
    const txt = missingNoticeText([st])
    expect(txt).toContain(CERT)
    expect(txt).toContain('Wohngeld')
    expect(existsSync(join(store, 'linked-docs-missing.json'))).toBe(true)
    expect(readFileSync(join(store, 'linked-docs-missing.json'), 'utf-8')).toContain(CERT)
  })

  // #874: the notice must not claim "deleted" (it can be a rename the guard could not follow), and the
  // scheduled PowerShell host must not open a visible console window behind the MessageBox.
  it('the missing notice does not claim a deletion as fact', async () => {
    const { missingNoticeText } = await import('../linked-docs-guard.js')
    const txt = missingNoticeText([{ rel: 'a/b.pdf', uses: ['P'], since: '2026-11-08T00:00:00Z' }])
    expect(txt).not.toMatch(/eltűnt az Életfából|is gone from the Life tree/)
    expect(txt).toMatch(/átnevezték|renamed/)
  })
  // #874 point 3: when the missing file's NAME is found in exactly one place of the Life tree, the notice says where.
  it('a missing file whose name exists in exactly one other place: the notice says where (the link is not changed)', async () => {
    mkdirSync(abs('Család/Anna/Archívum'), { recursive: true })
    writeFileSync(abs('Család/Anna/Archívum/igazolas.pdf'), 'A-DIFFERENT-FILE-WITH-THE-SAME-NAME')
    rmSync(abs(CERT))
    const seen: Array<{ rel: string; uses: string[]; foundAt?: string }> = []
    const r = await sweepLinkedDocs({ notify: async (e) => { seen.push(...e) } })
    expect([r.missing, r.newlyMissing, r.followed]).toEqual([1, 1, 0])
    expect(seen[0]!.foundAt).toBe('Család/Anna/Archívum/igazolas.pdf')
    const txt = missingNoticeText(seen as never)
    expect(txt).toContain('Család/Anna/Archívum/igazolas.pdf')
    expect(listProjectDocs(projectId).docs[0]!.life_rel).toBe(CERT) // the link stays: it is changed only when the owner asks
    expect(Object.values(readMissingState())[0]!.foundAt).toBe('Család/Anna/Archívum/igazolas.pdf')
  })
  it('the same name in two places: nothing is guessed, no place is named', async () => {
    mkdirSync(abs('Család/Anna/Archívum'), { recursive: true })
    mkdirSync(abs('Család/Anna/Másik'), { recursive: true })
    writeFileSync(abs('Család/Anna/Archívum/igazolas.pdf'), 'ONE')
    writeFileSync(abs('Család/Anna/Másik/igazolas.pdf'), 'TWO')
    rmSync(abs(CERT))
    const seen: Array<{ rel: string; uses: string[]; foundAt?: string }> = []
    await sweepLinkedDocs({ notify: async (e) => { seen.push(...e) } })
    expect(seen[0]!.foundAt).toBeUndefined()
    expect(missingNoticeText(seen as never)).not.toContain('Archívum/igazolas.pdf')
  })
  it('the name lookup shares the one walk of the tree with the content search', async () => {
    mkdirSync(abs('Család/Anna/Archívum'), { recursive: true })
    writeFileSync(abs('Család/Anna/Archívum/igazolas.pdf'), 'X')
    rmSync(abs(CERT))
    const before = readdirCalls.filter((p) => p === depot).length
    await sweepLinkedDocs(deps)
    expect(readdirCalls.filter((p) => p === depot).length - before).toBe(1)
  })
  it('the scheduled task runs PowerShell with a hidden window', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'windows-settings.ts'), 'utf-8')
    expect(src).toContain('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File')
  })
})
