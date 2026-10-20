import { spawnSync } from 'node:child_process'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
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
const { listSignatures, forgetSignatures } = await import('../workbench-signatures.js')

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

describe('#719 the Word editor moves a picture with its own mouse drag', () => {
  it('switches the native image drag off and wires docImgDragInit into the editor', () => {
    const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
    expect(js).toContain('function docImgDragInit(st, page)')
    expect(js).toContain('docImgDragInit(st, page)')
    expect(js).toMatch(/addEventListener\('dragstart'[\s\S]{0,120}tagName === 'IMG'\) e\.preventDefault\(\)/)
  })
  it('offers text-wrap placement (float left/right) and a context menu, with HU + EN labels', () => {
    const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
    expect(js).toContain("'float:' + mode")
    expect(js).toContain("addEventListener('contextmenu'")
    for (const f of ['hu', 'en']) {
      const lang = readFileSync(join(__dirname, '..', '..', 'web', 'lang', f + '.js'), 'utf8')
      for (const k of ['img_wrap_left', 'img_wrap_right', 'img_line_left', 'img_line_center', 'img_line_right']) expect(lang).toContain('"workbench.docedit.' + k + '"')
    }
  })
  it('moves a picture freely (position:absolute in cm, 1 mm arrow nudges) like the court document editor', () => {
    const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
    expect(js).toContain("img.style.position = 'absolute'")
    expect(js).toContain('function nudge(img, dxMm, dyMm)')
    expect(js).toContain("ArrowLeft: [-step, 0]")
  })
  it('the selected picture gets the court editor buttons (line l/c/r, wrap left/right, free) on its frame', () => {
    const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
    expect(js).toContain("tools.setAttribute('data-de-img-tools', '1')")
    expect(js).toContain('function applyMode(img, mode)')
    expect(js).toMatch(/var IMG_MODES = \[[\s\S]{0,400}'over', 'workbench\.dp\.img_mode_over'/)
  })
})

describe('#719 Word item finalize panel', () => {
  it('only a .docx item gets the panel; the PDF goes to Finished materials, not next to the file', () => {
    const src = readFileSync(join(__dirname, '..', 'workbench-docxfinal.ts'), 'utf8')
    expect(src).toContain("into: 'finished'")
    const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
    expect(js).toContain('function isDocxFinalItem(it)')
    // #723: its e-mail draft is the court document's own box and route (one code path, with the sender)
    expect(js).not.toContain("'/docx-mail'")
    expect(js).toMatch(/function docxMailPanelHtml\(it\) \{[\s\S]{0,600}mailBoxHtml\(/)
  })
})
