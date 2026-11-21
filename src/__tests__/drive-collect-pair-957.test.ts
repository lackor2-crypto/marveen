// #957: the collect pair is download-only: never overwrites, skips Marvin's own backup folder and
// what the Life tree already holds, and the page shows/starts it.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { collectSkip, restoreWalk, type RestoreEntry } from '../web/routes/drive-sync.js'

const FOLDER = 'application/vnd.google-apps.folder'
const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')

function fakeDrive(tree: Record<string, RestoreEntry[]>) {
  const downloaded: string[] = []
  return {
    downloaded,
    list: async (id: string) => tree[id] || [],
    download: async (f: RestoreEntry, dest: string) => { downloaded.push(f.name); writeFileSync(dest, 'x'); return 1 },
  }
}

describe('collectSkip + restoreWalk (#957)', () => {
  const tree = {
    root: [
      { id: 'b', name: 'Marveen mentések', mimeType: FOLDER },
      { id: 'm', name: 'Marveen mentés', mimeType: FOLDER },
      { id: 'mk', name: 'Egyeb', mimeType: FOLDER, appProperties: { marveenPath: 'Család' } },
      { id: 'c', name: 'calls.xml', size: '10', md5Checksum: 'aa' },
      { id: 'n', name: 'new.xml', size: '10', md5Checksum: 'bb' },
      { id: 'sub', name: 'Telefon', mimeType: FOLDER },
    ],
    sub: [{ id: 'd', name: 'deep.xml', size: '5', md5Checksum: 'cc' }, { id: 'bb2', name: 'Marveen mentések', mimeType: FOLDER }],
    b: [{ id: 'z', name: 'backup.mbk', size: '1', md5Checksum: 'dd' }],
  } as Record<string, RestoreEntry[]>
  const run = async (dryRun: boolean, inLife: string[]) => {
    const base = mkdtempSync(join(tmpdir(), 'collect957-'))
    const d = fakeDrive(tree)
    const r = await restoreWalk({
      rootId: 'root', base, dryRun, list: d.list, download: d.download,
      skip: collectSkip('Rendszer/Tárolók/Drive/lackor2', (f) => inLife.includes(String(f.md5Checksum)) ? { state: 'present', where: ['Család/Digitális/' + f.name] } : undefined),
    })
    return { base, d, r }
  }
  it('skips Marvin\'s own backup folders (top level only), files already in the Life tree; downloads the rest', async () => {
    const { base, d, r } = await run(false, ['aa'])
    expect(d.downloaded.sort()).toEqual(['deep.xml', 'new.xml'])
    expect(r.present).toBe(1)
    expect(r.skipped.filter((s) => /saját mentése/.test(s.reason)).length).toBe(3)
    expect(existsSync(join(base, 'Marveen mentések'))).toBe(false)
    rmSync(base, { recursive: true, force: true })
  })
  it('never overwrites a file that is already there', async () => {
    const base = mkdtempSync(join(tmpdir(), 'collect957-'))
    mkdirSync(base, { recursive: true }); writeFileSync(join(base, 'new.xml'), 'MINE')
    const d = fakeDrive(tree)
    await restoreWalk({ rootId: 'root', base, dryRun: false, list: d.list, download: d.download, skip: collectSkip('x', () => undefined) })
    expect(readFileSync(join(base, 'new.xml'), 'utf8')).toBe('MINE')
    rmSync(base, { recursive: true, force: true })
  })
  it('a preview writes nothing', async () => {
    const { base, d, r } = await run(true, [])
    expect(d.downloaded).toEqual([])
    expect(r.downloaded).toBe(3)
    rmSync(base, { recursive: true, force: true })
  })
})

describe('collect wiring (#957)', () => {
  const route = src('../web/routes/drive-sync.ts')
  it('the route creates a collect pair, the nightly /run includes it, and it is never "retired"', () => {
    expect(route).toMatch(/'\/api\/drive\/sync\/collect'/)
    expect(route).toMatch(/filter\(\(p\) => p\.backup \|\| p\.collect\)/)
    expect(route).toMatch(/retired: !p\.backup && !p\.collect/)
    expect(route).toMatch(/if \(pair\.collect\) \{\s*try \{ await runCollect\(pair, false\)/)
  })
  it('the page has the box, the buttons, both languages', () => {
    const html = src('../../web/index.html'), app = src('../../web/app.js')
    for (const id of ['depoCollectAccount', 'depoCollectPreviewBtn', 'depoCollectRunBtn', 'depoCollectStatus']) expect(html).toContain(id)
    expect(app).toMatch(/\/api\/drive\/sync\/collect/)
    for (const f of ['hu', 'en']) {
      const l = src(`../../web/lang/${f}.js`)
      for (const k of ['title', 'what_html', 'step1', 'run_btn', 'run_confirm', 'previewing', 'running', 'stopped', 'preview_done', 'done']) expect(l).toContain(`'dcollect.${k}'`)
    }
  })
})
