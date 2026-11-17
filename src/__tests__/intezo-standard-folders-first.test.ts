// #847 (Boss TG 4569/4571), second occurrence: the Workbench tree already keeps a work item's standard folders together
// in one block (Agent, Finished materials, Uploads, Trigger document, Attachments, Debate ...), the moved folder after
// them. The Explorer (web/app.js) lists the SAME folder -- both its file list and its left tree -- and still sorted
// alphabetically, so "Kérés a ..." fell between "Feltöltések" and "Kiváltó irat" there. Measured in a real browser on an
// isolated instance before the fix.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const app = readFileSync(join(__dirname, '..', '..', 'web', 'app.js'), 'utf8')
const wb = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')

type Entry = { name: string; isDir?: boolean; archived?: boolean }

function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from)
  const b = src.indexOf(to, a)
  if (a < 0 || b < 0) throw new Error(`cannot cut ${from} .. ${to}`)
  return src.slice(a, b)
}

/** The REAL _intezoOrder / _intezoCompare / std-first helper from app.js, with the sort state stubbed. */
function order(st: { key: string; dir: string }, folderNames: Array<string | Entry>, files: Entry[] = []): string[] {
  const folders: Entry[] = folderNames.map((x) => (typeof x === 'string' ? { name: x } : x))
  const stdBlock = slice(app, '/** Stable: the standard folders first', 'function _intezoCompare(')
  const stdMap = new Function(`${/var STD_FOLDERS = \{[\s\S]*?\}\n/.exec(wb)![0]}\nreturn STD_FOLDERS`)()
  const body = slice(app, 'function _intezoCompare(', 'function _intezoSortTh(')
  // eslint-disable-next-line no-new-func
  const f = new Function('window', '_intezoSortState', '_intezoTypeText', '_intezoKnownDirBytes', `${stdBlock}\n${body}\nreturn _intezoOrder`)({ MarvinWorkbench: { stdFolders: stdMap } }, () => st, () => 'Fájlmappa', () => 0)
  const L = { folders: folders.map((x) => ({ isDir: true, ...x })), files: files.map((x) => ({ isDir: false, ...x })) }
  return f(L).rows.map((e: Entry) => e.name)
}

const ITEM_FOLDERS = ['Agent', 'Elkészített anyagok', 'Feladási bizonylatok', 'Feltöltések', 'Kérés a Teszt', 'Kiváltó irat', 'Mellékletek', 'Vitáztatás']
const STD_ONLY = ITEM_FOLDERS.filter((n) => n !== 'Kérés a Teszt')

describe('Explorer file list: standard folders of a work item stay in one block', () => {
  it('name ascending (the default): the moved folder comes after ALL standard folders', () => {
    expect(order({ key: 'name', dir: 'asc' }, ITEM_FOLDERS, [{ name: 'Kontextus - X.md' }]))
      .toEqual([...STD_ONLY, 'Kérés a Teszt', 'Kontextus - X.md'])
  })
  it('name descending: the standard block still stays together, before the moved folder', () => {
    const r = order({ key: 'name', dir: 'desc' }, ITEM_FOLDERS)
    expect(r.slice(0, STD_ONLY.length).sort()).toEqual([...STD_ONLY].sort())
    expect(r[STD_ONLY.length]).toBe('Kérés a Teszt')
  })
  it('English names too', () => {
    expect(order({ key: 'name', dir: 'asc' }, ['Agent', 'Attachments', 'Debate', 'Finished materials', 'Letter 2', 'Trigger document', 'Uploads']))
      .toEqual(['Agent', 'Attachments', 'Debate', 'Finished materials', 'Trigger document', 'Uploads', 'Letter 2'])
  })
  it('a folder without standard names keeps its plain alphabetical order', () => {
    expect(order({ key: 'name', dir: 'asc' }, [{ name: 'Alma' }, { name: 'Béla' }, { name: 'Cili' }])).toEqual(['Alma', 'Béla', 'Cili'])
  })
  it('sorting by another column is the owner\'s choice and is not overridden', () => {
    const r = order({ key: 'type', dir: 'asc' }, [{ name: 'Kérés a Teszt' }, { name: 'Agent' }])
    expect(r.sort()).toEqual(['Agent', 'Kérés a Teszt'])
  })
})

describe('Explorer left tree: children go through the same std-first helper', () => {
  it('the tree branch is built from _intezoStdFirst', () => {
    expect(app).toMatch(/_intezoStdFirst\(kids\.filter\(/)
  })
  it('the list order uses it on both paths (default name-asc shortcut and the sorter)', () => {
    const body = slice(app, 'function _intezoOrder(', 'function _intezoSortTh(')
    expect((body.match(/_intezoStdFirst\(/g) || []).length).toBeGreaterThanOrEqual(2)
  })
})

describe('the Explorer list and the Workbench tree share ONE list of standard folder names', () => {
  it('workbench.js exports its list and app.js reads that one (no second copy to drift)', () => {
    expect(wb).toMatch(/window\.MarvinWorkbench = \{[\s\S]{0,400}stdFolders: STD_FOLDERS/)
    expect(app).toContain('window.MarvinWorkbench.stdFolders')
    expect(app).not.toContain('_INTEZO_STD_FOLDERS')
  })
})
