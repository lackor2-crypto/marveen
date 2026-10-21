// #659 + #661: the Life-move and orphan-JSON dialogs must fit the screen (title and button row stay put, the list
// scrolls, Escape / backdrop close), and the Life-move list carries a suggested target per file.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const depot = mkdtempSync(join(tmpdir(), 'marveen-lifemove-sug-'))
const store = mkdtempSync(join(tmpdir(), 'marveen-lifemove-sug-store-'))
process.env.MARVEEN_DEPOT = depot

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store }
})

const { explorerRoot } = await import('../life-explorer.js')
const { loadLifeConfig, saveLifeConfig } = await import('../life-tree.js')
const { suggestLifeTargets } = await import('../workbench-life-move.js')

const root = explorerRoot() as string
if (!root || !root.startsWith(depot)) throw new Error('not on the temporary depot')

const wbSrc = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf-8')
function fn(name: string): string {
  const start = wbSrc.indexOf('function ' + name + '(')
  const next = wbSrc.indexOf('\n  function ', start + 10)
  return wbSrc.slice(start, next)
}

describe('#659: the two dialogs fit the screen', () => {
  for (const [name, list] of [['lifeMoveOpen', 'wbLifeMoveList'], ['jsonCleanOpen', 'wbJsonCleanList']] as const) {
    it(name + ': capped height, flex column, fixed title + buttons, scrolling list, Escape + backdrop close', () => {
      const body = fn(name)
      expect(body).toContain('max-height:88vh;display:flex;flex-direction:column')
      expect(body).toMatch(/<h3 style="[^"]*flex:none/)
      expect(body).toMatch(new RegExp('id="' + list + '"[^>]*flex:1 1 auto;min-height:0;overflow-y:auto'))
      expect(body).toMatch(/text-align:right;margin-top:10px;flex:none/)
      expect(body).toContain("e.key === 'Escape'")
      expect(body).toContain('e.target === overlay')
      expect(body).toContain("removeEventListener('keydown'")
    })
  }
})

describe('#661: a suggested target per file', () => {
  beforeEach(() => {
    mkdirSync(join(root, 'Korpás László', 'Hatóságok'), { recursive: true })
    const cfg = loadLifeConfig()
    saveLifeConfig({ ...cfg, persons: [{ id: 'p1', name: 'Korpás László', role: 'owner', countries: [], mediaGroups: [] }] } as any)
  })

  it('fresh install (no persons): no suggestion, no error', async () => {
    saveLifeConfig({ ...loadLifeConfig(), persons: [] } as any)
    const res = await suggestLifeTargets([{ rel: 'x/a.txt', name: 'a.txt', folder: '' }], 'hu')
    expect(res.size).toBe(0)
  })

  it('a file that does not exist: skipped, never throws', async () => {
    const res = await suggestLifeTargets([{ rel: 'nincs/ilyen.pdf', name: 'ilyen.pdf', folder: '' }], 'hu')
    expect(res.size).toBe(0)
  })

  it('a credential-looking file never gets a target', async () => {
    mkdirSync(join(root, 'Munka'), { recursive: true })
    writeFileSync(join(root, 'Munka', 'jelszavak.txt'), 'Korpás László hatóság')
    const res = await suggestLifeTargets([{ rel: 'Munka/jelszavak.txt', name: 'jelszavak.txt', folder: '' }], 'hu')
    expect(res.has('Munka/jelszavak.txt')).toBe(false)
  })

  it('only an EXISTING folder is ever suggested', async () => {
    mkdirSync(join(root, 'Munka'), { recursive: true })
    writeFileSync(join(root, 'Munka', 'level.txt'), 'Hivatalos határozat Korpás László részére')
    const res = await suggestLifeTargets([{ rel: 'Munka/level.txt', name: 'level.txt', folder: '' }], 'hu')
    const s = res.get('Munka/level.txt')
    expect(s?.suggested_target).toBe('Korpás László/Hatóságok')
    expect(s?.suggested_confident).toBe(true)
  })
})

// #659 follow-up: Escape closes only the dialog on top. The folder picker opened from the Life-move dialog sits above
// it; before the fix one Escape closed BOTH, and the folder picked afterwards landed in a dialog that was gone.
describe('#659: Escape closes only the topmost dialog', () => {
  // The real isTopModal() from web/workbench.js, run against a fake document holding the overlays in DOM order.
  const isTopModal = (overlays: object[]) => {
    const src = fn('isTopModal')
    const f = new Function('document', src + '\nreturn isTopModal')
    return f({ querySelectorAll: () => overlays }) as (o: object) => boolean
  }
  const lifeMove = { id: 'wbLifeMove' }
  const picker = { id: 'wbLifeFilePick' }

  it('the dialog underneath ignores Escape while the picker is open; the picker (on top) takes it', () => {
    const check = isTopModal([lifeMove, picker])
    expect(check(lifeMove)).toBe(false)
    expect(check(picker)).toBe(true)
  })

  it('a lone dialog takes Escape; so does one when the page lists no overlay at all', () => {
    expect(isTopModal([lifeMove])(lifeMove)).toBe(true)
    expect(isTopModal([])(lifeMove)).toBe(true)
  })

  it('all four Escape handlers (Life-move, orphan JSON, root guard, folder picker) ask isTopModal first', () => {
    const handlers = wbSrc.match(/var onKey = function \(e\) \{[^\n]*\}/g) || []
    const escapes = handlers.filter((h) => h.includes("'Escape'"))
    expect(escapes.length).toBeGreaterThanOrEqual(4)
    for (const h of escapes) expect(h).toContain('isTopModal(overlay)')
    for (const name of ['lifeMoveOpen', 'jsonCleanOpen', 'rootGuardAsk', 'pickLifeFile']) {
      expect(fn(name)).toContain('isTopModal(overlay)')
    }
  })
})

// #661, route level: the REAL GET /life-move carries the suggestion per file, and nothing moves until the owner POSTs
// the approved list (a suggestion alone never moves a file).
describe('#661: the real life-move route', () => {
  it('GET carries suggested_target per file; a vague file has none; POST moves only the approved row', async () => {
    const { initDatabase } = await import('../db.js')
    const { createProject, updateProject } = await import('../projects.js')
    const { createWorkItem } = await import('../workbench.js')
    const { ensureWorkItemFolder } = await import('../workbench-assets.js')
    const { callWorkbench } = await import('./helpers/workbench-route-call.js')
    initDatabase(':memory:')
    mkdirSync(join(root, 'Korpás László', 'Hatóságok'), { recursive: true })
    saveLifeConfig({ ...loadLifeConfig(), persons: [{ id: 'p1', name: 'Korpás László', role: 'owner', countries: [], mediaGroups: [] }] } as any)
    const p = createProject({ name: 'Iroda' })
    if (!p.ok) throw new Error('projekt')
    mkdirSync(join(root, 'Projektek', 'Iroda'), { recursive: true })
    updateProject(p.project.id, { folder_path: 'Projektek/Iroda' })
    const w = createWorkItem({ project_id: p.project.id, title: 'Valasz', type: 'note' })
    if (!w.ok) throw new Error('munkadarab')
    const fo = ensureWorkItemFolder(w.item)
    if (!fo.ok) throw new Error('mappa')
    const dir = join(root, 'Projektek', 'Iroda', fo.folder)
    writeFileSync(join(dir, 'hatarozat.txt'), 'Hivatalos határozat Korpás László részére')
    writeFileSync(join(dir, 'semmi.txt'), 'xyz')

    const g = await callWorkbench('/api/workbench/items/' + w.item.id + '/life-move', 'GET')
    expect(g.status).toBe(200)
    const byName = Object.fromEntries((g.body.files as any[]).map((f) => [f.name, f]))
    expect(byName['hatarozat.txt'].suggested_target).toBe('Korpás László/Hatóságok')
    expect(byName['hatarozat.txt'].suggested_confident).toBe(true)
    expect(typeof byName['hatarozat.txt'].suggested_display).toBe('string')
    // a suggestion alone moved nothing
    expect(existsSync(join(dir, 'hatarozat.txt'))).toBe(true)
    // a file the sorter cannot place is NOT given a confident pre-filled target
    expect(byName['semmi.txt'].suggested_confident === true).toBe(false)

    // not sent yet: the list says so, and a POST moves nothing
    expect((g.body.gates as any[])[0].sent).toBe(false)
    expect(byName['hatarozat.txt'].action).toBe('blocked')
    const early = await callWorkbench('/api/workbench/items/' + w.item.id + '/life-move', 'POST', { moves: [{ rel: byName['hatarozat.txt'].rel, target: 'Korpás László/Hatóságok' }] })
    expect((early.body.results as any[])[0].ok).toBe(false)
    expect(existsSync(join(dir, 'hatarozat.txt'))).toBe(true)
    // marked as sent by hand (5A): now it may move
    const mark = await callWorkbench('/api/workbench/items/' + w.item.id + '/sent-mark', 'POST', { sent: true })
    expect(mark.status).toBe(200)

    // the owner approves one row with the suggested target: only that one moves
    const post = await callWorkbench('/api/workbench/items/' + w.item.id + '/life-move', 'POST',
      { moves: [{ rel: byName['hatarozat.txt'].rel, target: byName['hatarozat.txt'].suggested_target }] })
    expect(post.status).toBe(200)
    expect(existsSync(join(root, 'Korpás László', 'Hatóságok', 'hatarozat.txt'))).toBe(true)
    expect(existsSync(join(dir, 'hatarozat.txt'))).toBe(false)
    expect(existsSync(join(dir, 'semmi.txt'))).toBe(true)
  })
})
