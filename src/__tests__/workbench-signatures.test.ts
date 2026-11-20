import { spawnSync } from 'node:child_process'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const depot = mkdtempSync(join(tmpdir(), 'marveen-sign-'))
const store = mkdtempSync(join(tmpdir(), 'marveen-sign-store-'))
process.env.MARVEEN_DEPOT = depot

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store }
})

// The disk lists a folder in whatever order it likes; the walk's fairness is about ORDER, so make it one fixed order
// (alphabetical: "Archívum" before "Család", the bad case).
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return {
    ...actual,
    readdir: (async (...a: Parameters<typeof actual.readdir>) => {
      const list = await (actual.readdir as (...x: unknown[]) => Promise<Array<{ name: string }>>)(...a)
      return [...list].sort((x, y) => String(x.name).localeCompare(String(y.name)))
    }) as typeof actual.readdir,
  }
})

const { explorerRoot } = await import('../life-explorer.js')
const { listSignatures, forgetSignatures, forgetInMemoryOnly } = await import('../workbench-signatures.js')

const root = explorerRoot() as string
if (!root || !root.startsWith(depot)) throw new Error('not on the temp depot')

beforeEach(() => {
  forgetSignatures()
  rmSync(root, { recursive: true, force: true })
  mkdirSync(join(root, 'Emberek', 'Nagymama'), { recursive: true })
  mkdirSync(join(root, 'Emberek', 'Laszlo', 'identitas'), { recursive: true })
})

describe('listSignatures', () => {
  it('collects signature pictures from the whole tree and ignores other files', async () => {
    writeFileSync(join(root, 'Emberek', 'Nagymama', 'alairas.png'), 'x')
    writeFileSync(join(root, 'Emberek', 'Laszlo', 'identitas', 'Aláírás Laszlo.PNG'), 'x')
    writeFileSync(join(root, 'Emberek', 'Laszlo', 'identitas', 'signature.txt'), 'x')
    writeFileSync(join(root, 'Emberek', 'Laszlo', 'utlevel.png'), 'x')
    const r = await listSignatures('hu')
    expect(r.signatures.map((s) => s.name).sort()).toEqual(['Aláírás Laszlo.PNG', 'alairas.png'])
    expect(r.signatures.every((s) => s.rel.endsWith(s.name) && s.folder.startsWith('Emberek'))).toBe(true)
  })

  it('lists a .webp signature too (#719: "anyu alairasa.webp" was skipped)', async () => {
    writeFileSync(join(root, 'Emberek', 'Nagymama', 'anyu alairasa.webp'), 'x')
    const r = await listSignatures('hu')
    expect(r.signatures.map((s) => s.name)).toEqual(['anyu alairasa.webp'])
  })

  it('returns an empty list when there is none', async () => {
    expect((await listSignatures('hu')).signatures).toEqual([])
  })
})

describe('the walk never blocks and is not repeated (2026-10-10 freeze)', () => {
  it('the trash and dot folders are skipped; one answer is reused, a "fresh" call looks again', async () => {
    mkdirSync(join(root, 'Kuka'), { recursive: true })
    mkdirSync(join(root, 'Emberek', '.rejtett'), { recursive: true })
    writeFileSync(join(root, 'Emberek', '.rejtett', 'alairas.png'), 'x')
    writeFileSync(join(root, 'Emberek', 'Nagymama', 'alairas.png'), 'x')
    const a = await listSignatures('hu')
    expect(a.signatures.map((s) => s.rel)).toEqual(['Emberek/Nagymama/alairas.png'])
    writeFileSync(join(root, 'Emberek', 'Nagymama', 'signature2.jpg'), 'x')
    expect(await listSignatures('hu')).toBe(a) // remembered: no second walk
    expect((await listSignatures('hu', { fresh: true })).signatures).toHaveLength(2)
  })

  it('two callers at the same time share one walk', async () => {
    writeFileSync(join(root, 'Emberek', 'Nagymama', 'alairas.png'), 'x')
    const [x, y] = await Promise.all([listSignatures('hu'), listSignatures('hu')])
    expect(x).toBe(y)
  })

  it('out of time: says so, returns what it has; the half answer is reused briefly, "fresh" looks again', async () => {
    writeFileSync(join(root, 'Emberek', 'Nagymama', 'alairas.png'), 'x')
    const half = await listSignatures('hu', { budgetMs: -1 })
    expect(half).toEqual({ signatures: [], truncated: true }) // "did not get to the end", not "there is none"
    expect(await listSignatures('hu')).toBe(half)
    const full = await listSignatures('hu', { fresh: true })
    expect(full.truncated).toBe(false)
    expect(full.signatures).toHaveLength(1)
  })

  it('a wide archive listed first does not starve the identity folder when the folder budget runs out', async () => {
    rmSync(join(root, 'Emberek'), { recursive: true, force: true }) // the shared fixture's folders would use up the budget
    // Archívum: 3 folders with 5 sub-folders each (15 folders on the level where the identity folder also is).
    for (const a of ['a1', 'a2', 'a3']) for (let i = 0; i < 5; i++) mkdirSync(join(root, 'Archívum', a, 'm' + i), { recursive: true })
    mkdirSync(join(root, 'Család', 'Laszlo', 'Identitás'), { recursive: true })
    writeFileSync(join(root, 'Család', 'Laszlo', 'Identitás', 'laszlo alairas.png'), 'x')
    writeFileSync(join(root, 'Archívum', 'a1', 'm0', 'regi alairas.png'), 'x')
    // 8 folders: root, Archívum, Család, a1, a2, a3, Laszlo -- then the 8th must be Identitás, not one of the 15.
    const r = await listSignatures('hu', { fresh: true, maxFolders: 8 })
    expect(r.signatures.map((s) => s.rel)).toEqual(['Család/Laszlo/Identitás/laszlo alairas.png'])
    expect(r.truncated).toBe(true) // and it still says the tree was not seen to the end
  })

  it('the module reads folders asynchronously and never calls the synchronous tree search', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(join(__dirname, '..', 'workbench-signatures.ts'), 'utf8')
    expect(src).toContain("from 'node:fs/promises'")
    expect(src).not.toMatch(/readdirSync|statSync|searchLife\(/)
    const route = readFileSync(join(__dirname, '..', 'web', 'routes', 'workbench.ts'), 'utf8')
    expect(route).toContain('await listSignatures(lang')
  })
})

describe('a WebP picture on the page (#719)', () => {
  const WEBP = Buffer.from('UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoEAAIAAgA0JaQAA3AA/vv9UAA=', 'base64')
  it('is accepted as an image block path', async () => {
    const { imageBlockPathOk } = await import('../workbench-docmodel.js')
    expect(imageBlockPathOk('Család/Éva/Identitás/anyu alairasa.webp')).toBe(true)
  })
  it.skipIf(spawnSync('ffmpeg', ['-version']).status !== 0)('is turned into a PNG for the document renderer', async () => {
    const { isWebp, webpToPng } = await import('../workbench-docfinal.js')
    expect(isWebp(WEBP)).toBe(true)
    const png = webpToPng(WEBP)
    expect(png && png.readUInt32BE(0)).toBe(0x89504e47)
  })
})

describe('#719 Word item e-mail (its own finalize panel is gone, #803)', () => {
  it('a Word item has no own finalize any more; a finalized one still mails with the court document\'s box', () => {
    const src = readFileSync(join(__dirname, '..', 'workbench-docxfinal.ts'), 'utf8')
    expect(src).not.toContain('export async function finalizeDocxItem')
    const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
    expect(js).not.toContain('function isDocxFinalItem(it)')
    // #723: its e-mail draft is the court document's own box and route (one code path, with the sender)
    expect(js).not.toContain("'/docx-mail'")
    expect(js).toMatch(/function docxMailPanelHtml\(it\) \{[\s\S]{0,600}mailBoxHtml\(/)
  })
})

// Owner TG 6300: the picker must not search every time. Found once -> the path is remembered (on disk), the next call
// answers at once from it and walks in the background; a moved file is followed, a trashed one is found in the trash,
// one gone from the trash too is forgotten.
describe('#sigmem remembered signature paths', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  async function remember(): Promise<void> {
    mkdirSync(join(root, 'Család', 'Korpás László', 'Identitás'), { recursive: true })
    writeFileSync(join(root, 'Család', 'Korpás László', 'Identitás', 'alairas laszlo.png'), 'x')
    const first = await listSignatures('hu')
    expect(first.signatures).toHaveLength(1)
    expect(first.refreshing).toBeUndefined()
  }

  it('the second call (after the in-memory answer expired / a restart) answers at once from the remembered path', async () => {
    await remember()
    // simulate a restart: only the file on disk is left
    const { forgetInMemoryOnly } = await import('../workbench-signatures.js') as unknown as { forgetInMemoryOnly?: () => void }
    expect(forgetInMemoryOnly).toBeTypeOf('function')
    forgetInMemoryOnly!()
    const r = await listSignatures('hu')
    expect(r.refreshing).toBe(true)
    expect(r.signatures.map((s) => s.rel)).toEqual(['Család/Korpás László/Identitás/alairas laszlo.png'])
  })

  it('a MOVED file is followed: the walk behind finds it, the next answer has the new path only', async () => {
    await remember()
    const { forgetInMemoryOnly } = await import('../workbench-signatures.js') as unknown as { forgetInMemoryOnly: () => void }
    mkdirSync(join(root, 'Család', 'Korpás László', 'Új hely'), { recursive: true })
    const { renameSync } = await import('node:fs')
    renameSync(join(root, 'Család', 'Korpás László', 'Identitás', 'alairas laszlo.png'), join(root, 'Család', 'Korpás László', 'Új hely', 'alairas laszlo.png'))
    forgetInMemoryOnly()
    await listSignatures('hu') // gone from the remembered place and not in the trash -> falls back to a walk and finds it
    forgetInMemoryOnly()
    await sleep(20)
    const r = await listSignatures('hu')
    expect(r.signatures.map((s) => s.rel)).toEqual(['Család/Korpás László/Új hely/alairas laszlo.png'])
  })

  it('a TRASHED file is still handed over from the trash; once it is gone from there too, it is forgotten', async () => {
    await remember()
    const { forgetInMemoryOnly } = await import('../workbench-signatures.js') as unknown as { forgetInMemoryOnly: () => void }
    mkdirSync(join(root, 'Kuka', 'ma'), { recursive: true })
    const { renameSync } = await import('node:fs')
    renameSync(join(root, 'Család', 'Korpás László', 'Identitás', 'alairas laszlo.png'), join(root, 'Kuka', 'ma', 'alairas laszlo.png'))
    forgetInMemoryOnly()
    const r = await listSignatures('hu')
    expect(r.signatures.map((s) => s.rel)).toEqual(['Kuka/ma/alairas laszlo.png'])
    await sleep(50)
    rmSync(join(root, 'Kuka', 'ma', 'alairas laszlo.png'))
    forgetInMemoryOnly()
    const gone = await listSignatures('hu')
    expect(gone.signatures).toEqual([])
  })

  // The owner's real order (browser-measured, #919): open the picker, move the picture in the Life tree, open the picker
  // AGAIN within the 10 minutes the finished answer is reused. No restart in between, so the in-memory answer is still there:
  // it must not hand over the place the picture was at last time.
  it('a file moved or trashed while the finished answer is still reused is not handed over from its old place', async () => {
    await remember()
    mkdirSync(join(root, 'Család', 'Korpás László', 'Új hely'), { recursive: true })
    const { renameSync } = await import('node:fs')
    renameSync(join(root, 'Család', 'Korpás László', 'Identitás', 'alairas laszlo.png'), join(root, 'Család', 'Korpás László', 'Új hely', 'alairas laszlo.png'))
    const moved = await listSignatures('hu')
    expect(moved.signatures.map((s) => s.rel)).toEqual(['Család/Korpás László/Új hely/alairas laszlo.png'])
    mkdirSync(join(root, 'Kuka', 'ma'), { recursive: true })
    renameSync(join(root, 'Család', 'Korpás László', 'Új hely', 'alairas laszlo.png'), join(root, 'Kuka', 'ma', 'alairas laszlo.png'))
    const trashed = await listSignatures('hu')
    expect(trashed.signatures.map((s) => s.rel)).toEqual(['Kuka/ma/alairas laszlo.png'])
    rmSync(join(root, 'Kuka', 'ma', 'alairas laszlo.png'))
    const gone = await listSignatures('hu')
    expect(gone.signatures).toEqual([])
  })

  it('the remembered paths are kept in store/signature-memory.json', async () => {
    await remember()
    expect(JSON.parse(readFileSync(join(store, 'signature-memory.json'), 'utf8')).entries[0].name).toBe('alairas laszlo.png')
  })
})

// A walk that is still running when the picker forgets everything ("search again", a test's reset) must not write its
// stale answer back afterwards: it would hide a signature that appeared since (and made #sigmem tests flaky: the walk
// left behind by one test overwrote the next test's answer).
describe('a forgotten walk does not write back', () => {
  it('a walk started before forgetSignatures() leaves neither the memory file nor the in-memory answer behind', async () => {
    const stale = listSignatures('hu') // starts the walk; nothing found yet
    forgetSignatures()
    await stale
    expect(existsSync(join(store, 'signature-memory.json'))).toBe(false)
    writeFileSync(join(root, 'Emberek', 'Nagymama', 'alairas.png'), 'x')
    const r = await listSignatures('hu')
    expect(r.signatures.map((s) => s.name)).toEqual(['alairas.png'])
  })

  it('the same for forgetInMemoryOnly() (a restart)', async () => {
    const stale = listSignatures('hu')
    forgetInMemoryOnly()
    await stale
    writeFileSync(join(root, 'Emberek', 'Nagymama', 'alairas.png'), 'x')
    const r = await listSignatures('hu')
    expect(r.signatures.map((s) => s.name)).toEqual(['alairas.png'])
  })
})
