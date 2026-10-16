// #659 + #661: the Life-move and orphan-JSON dialogs must fit the screen (title and button row stay put, the list
// scrolls, Escape / backdrop close), and the Life-move list carries a suggested target per file.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
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
