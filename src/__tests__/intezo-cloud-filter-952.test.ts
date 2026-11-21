// #952 (Boss TG 7123): the Intezo gets a cloud filter -- everything / only what
// is on the cloud / only what is not. A folder stays when anything under it
// matches; a file by its own state. Pure logic, run from the real app.js source.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const app = readFileSync(join(root, 'web', 'app.js'), 'utf8')
const html = readFileSync(join(root, 'web', 'index.html'), 'utf8')
const block = app.slice(app.indexOf('// CLOUD-FILTER-BEGIN'), app.indexOf('// CLOUD-FILTER-END'))

function load() {
  const store: Record<string, string> = {}
  const localStorage = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v } }
  const _bkNorm = (p: string) => String(p || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  // eslint-disable-next-line no-new-func
  return new Function('localStorage', '_bkNorm', block + '\nreturn { _cfMode, _cfSetMode, _cfState, _cfFilter, _cfTreeKeep, _cfProvenNoFiles, _cfDownHasFiles, _cfNeedKids }')(localStorage, _bkNorm)
}
const drive = { kind: 'drive', account: 'a' }
const dir = (rel: string) => ({ rel, isDir: true })
const file = (rel: string) => ({ rel, isDir: false })

describe('Intezo cloud filter (#952)', () => {
  const cf = load()
  const rules = [
    { path: 'Cegek', target: drive },
    { path: 'Cegek/Temp', target: null },
    { path: 'Csalad/Anna/Iratok', target: drive, exclude: ['Regi', '*.fxt'] },
  ]
  const names = (list: any[]) => list.map((e) => e.rel)

  it('all (default) and unknown rules never filter', () => {
    const all = [dir('Cegek'), dir('Zsolt'), file('x.txt')]
    expect(cf._cfMode()).toBe('all')
    expect(cf._cfFilter(all, 'all', rules)).toBe(all)
    expect(cf._cfFilter(all, 'up', null)).toBe(all)
  })

  it('"up": a folder stays for one covered file or rule below it, a file by its own cover', () => {
    const list = [dir('Cegek'), dir('Csalad'), dir('Zsolt'), file('x.txt')]
    expect(names(cf._cfFilter(list, 'up', rules))).toEqual(['Cegek', 'Csalad'])
    expect(names(cf._cfFilter([file('Cegek/a.pdf'), file('Cegek/Temp/b.pdf'), file('Zsolt/c.pdf')], 'up', rules))).toEqual(['Cegek/a.pdf'])
  })

  it('"down": what has no cloud assigned stays (no rule, or an explicit "do not back up")', () => {
    const list = [dir('Cegek'), dir('Csalad'), dir('Zsolt'), file('x.txt')]
    // Cegek has a do-not-back-up sub-folder -> still has something not up
    expect(names(cf._cfFilter(list, 'down', rules))).toEqual(['Cegek', 'Csalad', 'Zsolt', 'x.txt'])
    expect(names(cf._cfFilter([dir('Cegek/Temp'), dir('Cegek/Szamla')], 'down', rules))).toEqual(['Cegek/Temp'])
  })

  it('a fully covered folder is hidden in "down", and the exclude list of a rule changes nothing: only the assignment counts', () => {
    const only = [{ path: 'Cegek', target: drive }]
    expect(names(cf._cfFilter([dir('Cegek'), dir('Cegek/Sub')], 'down', only))).toEqual([])
    expect(names(cf._cfFilter([dir('Cegek'), dir('Cegek/Sub')], 'up', only))).toEqual(['Cegek', 'Cegek/Sub'])
    // TG 7166: the exclude list of a rule is ignored -- assigned to a cloud = up, not assigned = not up
    const r = [{ path: 'Csalad/Anna/Iratok', target: drive, exclude: ['Regi', '*.fxt'] }]
    expect(cf._cfState(file('Csalad/Anna/Iratok/Regi/a.pdf'), r)).toMatchObject({ up: true, down: false })
    expect(cf._cfState(file('Csalad/Anna/Iratok/t.FXT'), r)).toMatchObject({ up: true, down: false })
    expect(cf._cfState(dir('Csalad/Anna/Iratok/Regi'), r)).toMatchObject({ up: true, down: false })
    expect(cf._cfState(file('Csalad/Anna/Egyeb/x.pdf'), r)).toMatchObject({ up: false, down: true })
  })

  it('no rules at all: nothing is up, everything is not', () => {
    expect(cf._cfFilter([dir('A'), file('b')], 'up', [])).toEqual([])
    expect(names(cf._cfFilter([dir('A'), file('b')], 'down', []))).toEqual(['A', 'b'])
  })

  it('remembers the choice and ignores junk', () => {
    cf._cfSetMode('up'); expect(cf._cfMode()).toBe('up')
    cf._cfSetMode('bogus'); expect(cf._cfMode()).toBe('all')
  })

  it('is wired in: the select, the list, the tree, HU+EN texts', () => {
    expect(html).toContain('id="intezoCloudFilter"')
    expect(html).toContain('id="intezoCloudNote"')
    expect(app).toMatch(/_cfFilter\(ordered\.rows, cfMode, _bkRules, \(r\) => _intezoTreeKids\.get\(r\)\)/)
    expect(app).toContain('cfTreeKeep(_intezoTreeKids.get(rel))')
    for (const lang of ['hu', 'en']) {
      const l = readFileSync(join(root, 'web', 'lang', `${lang}.js`), 'utf8')
      for (const k of ['cloud_filter', 'cloud_all', 'cloud_up', 'cloud_down', 'cloud_empty_up', 'cloud_empty_down', 'cloud_hidden_n', 'cloud_unknown', 'cloud_loading']) {
        expect(l, `${lang} ${k}`).toContain(`'intezo.${k}'`)
      }
    }
  })
  // TG 7156 / 7163 / 7166 (Boss's real rules): Projektek is assigned to MEGA lackor3, Media/Fotok to Photos, the person
  // folder to Drive -- all are on the cloud whatever any exclude list says.
  it('assigned folders are up and never listed under "not up", exclude lists ignored (TG 7166)', () => {
    const p = 'Csalad/Laszlo'
    const real = [
      { path: p, target: { kind: 'drive', account: 'lackor2' }, exclude: ['Media/Fotok', 'Projektek'] },
      { path: p + '/Media/Fotok', target: { kind: 'photos', account: 'lackor3' } },
      { path: p + '/Projektek', target: { kind: 'mega', account: 'lackor3' }, exclude: ['Tester', 'logs', '*.fxt'] },
    ]
    for (const rel of [p, p + '/Media', p + '/Media/Fotok', p + '/Projektek', p + '/Projektek/Tester']) {
      expect(cf._cfState(dir(rel), real), rel).toMatchObject({ up: true, down: false })
    }
    expect(names(cf._cfFilter([dir(p), dir(p + '/Media'), dir(p + '/Projektek')], 'down', real))).toEqual([])
    expect(names(cf._cfFilter([dir(p), dir(p + '/Projektek')], 'up', real))).toEqual([p, p + '/Projektek'])
  })
  it('the folder mark shows the assignment only (excluded sub-folder of an assigned folder is marked backed up)', () => {
    const fnSrc = (name: string) => {
      const a = app.indexOf('function ' + name + '(')
      const b = app.indexOf('\n}\n', a)
      return app.slice(a, b + 3)
    }
    const _bkNorm = (p: string) => String(p || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    const rules = [{ path: 'P', target: { kind: 'mega', account: 'm' }, exclude: ['Tester', '*.hst'] }]
    const t = (k: string) => k
    const src = block + '\n' + fnSrc('_bkEffective') + '\n' + fnSrc('_bkTargetText') + '\n' + fnSrc('_bkKindName') + '\n' + fnSrc('_bkFromText')
      + '\n' + fnSrc('_bkBadge') + '\nreturn _bkBadge'
    // eslint-disable-next-line no-new-func
    const badge = new Function('localStorage', '_bkNorm', '_bkRules', 't', 'escapeHtml', src)({ getItem: () => null, setItem: () => {} }, _bkNorm, rules, t, (x: string) => x)
    expect(badge({ rel: 'P/Tester', isDir: true })).toContain('☁')
    expect(badge({ rel: 'P/Other', isDir: true })).toContain('☁')
  })
  // TG 7170: filter on -> the whole tree is open; plain view -> closed.
  it('the tree opens every folder while the cloud filter is on, and stays closed in the plain view', () => {
    const fnSrc = (name: string) => {
      const a = app.indexOf('function ' + name + '(')
      const b = app.indexOf('\n}\n', a)
      return app.slice(a, b + 3)
    }
    const mk = (mode: string) => {
      const src = 'const _INTEZO_TREE_AUTO_DEPTH = 3\n' + fnSrc('_intezoTreeDepth') + '\n' + fnSrc('_intezoTreeAllOpen') + '\n' + fnSrc('_intezoTreeIsOpen') + '\nreturn _intezoTreeIsOpen'
      // eslint-disable-next-line no-new-func
      return new Function('_cfMode', '_bkRules', '_bkError', '_intezoTreeIsLeaf', '_intezoTreeCollapsed', '_intezoTreeOpenRels', src)(
        () => mode, [], false, () => false, new Set(['Zárt']), () => new Set())
    }
    const on = mk('down'), up = mk('up'), off = mk('all')
    expect(on('A/B/C', {}, new Set([''])), 'level 3 folder is shown but not opened by itself (TG 7191)').toBe(false)
    expect(on('A/B', {}, new Set([''])), 'level 2 folder is opened').toBe(true)
    expect(on('Család/X', {}, new Set([''])), 'down: open').toBe(true)
    expect(up('Család/X', {}, new Set([''])), 'up: open').toBe(true)
    expect(off('Család/X', {}, new Set([''])), 'all: closed').toBe(false)
    expect(on('Zárt', {}, new Set([''])), 'a folder the user closed stays closed').toBe(false)
    expect(app).toContain("if (cfSel.value === 'all') { _intezoTreeOpenSet = new Set(); _intezoTreeSaveOpen() }")
  })
  // TG 7181: "not up" shows no folder without any file under it.
  it('"not up" hides provably file-less folders, keeps unknown / measuring ones; "up" and "all" are untouched', () => {
    const withC = (rel: string, content: any) => ({ rel, isDir: true, content })
    const none = withC('Csalad/Ures', { state: 'empty', folders: 0, files: 0, deep: 'empty' })
    const onlyEmptyDirs = withC('Csalad/Megosztott', { state: 'has', folders: 3, files: 0, deep: 'empty' })
    const hasFile = withC('Csalad/Iratok', { state: 'has', folders: 1, files: 0, deep: 'has' })
    const unknown = withC('Csalad/Ismeretlen', { state: 'has', folders: 1, files: 0, deep: 'unknown' })
    const pending = withC('Csalad/Mer', { state: 'unknown', folders: null, files: null, deep: 'unknown', pending: true })
    const noInfo = dir('Csalad/Nincsadat')
    const none2 = [{ path: 'Cegek', target: drive }]
    const list = [none, onlyEmptyDirs, hasFile, unknown, pending, noInfo, file('Csalad/x.txt')]
    expect(names(cf._cfFilter(list, 'down', none2))).toEqual(['Csalad/Iratok', 'Csalad/Ismeretlen', 'Csalad/Mer', 'Csalad/Nincsadat', 'Csalad/x.txt'])
    expect(names(cf._cfFilter(list, 'up', [{ path: 'Csalad', target: drive }]))).toHaveLength(7)
    expect(cf._cfFilter(list, 'all', none2)).toBe(list)
    expect(cf._cfProvenNoFiles(file('a'))).toBe(false)
  })
  // TG 7189: a thick line between the cloud kinds in the backup map.
  it('the backup map marks the break between Drive / Photos / MEGA blocks with a thick line', () => {
    expect(app).toContain("const kindChanged = i > 0 && (r.target ? r.target.kind : '') !== (rules[i - 1].target ? rules[i - 1].target.kind : '')")
    expect(app).toContain('border-top:5px solid')
    expect(app).toContain('bk-map-kind-break')
  })
  // TG 7197: Digitalis has files, but only under Szoftverek, which is assigned to MEGA -> nothing there is "not up".
  it('"not up" hides a folder whose files all sit under assigned sub-folders (Boss: Digitalis)', () => {
    const mega = { kind: 'mega', account: 'lackor3' }
    const r = [{ path: 'Digitalis/Szoftverek', target: mega }]
    const m = (rel: string, state: string, files: number, deep: string) => ({ rel, isDir: true, content: { state, files, folders: 0, deep } })
    const digi = m('Digitalis', 'has', 0, 'has')
    const kids: Record<string, any[]> = {
      Digitalis: [m('Digitalis/Domainek', 'empty', 0, 'empty'), m('Digitalis/Eszkozok', 'empty', 0, 'empty'), m('Digitalis/Szoftverek', 'has', 0, 'has')],
    }
    const kidsOf = (rel: string) => kids[rel]
    expect(cf._cfFilter([digi], 'down', r, kidsOf), 'every file is under the assigned Szoftverek').toEqual([])
    expect(cf._cfFilter([digi], 'down', r), 'children not loaded: unknown stays listed').toEqual([digi])
    kids.Digitalis.push(m('Digitalis/Jegyzetek', 'has', 3, 'has'))
    expect(cf._cfFilter([digi], 'down', r, kidsOf), 'an unassigned sub-folder with files keeps it').toEqual([digi])
    const own = m('Digitalis', 'has', 2, 'has')
    kids.Digitalis.pop()
    expect(cf._cfFilter([own], 'down', r, kidsOf), 'a file directly in the unassigned folder keeps it').toEqual([own])
  })
  it('"not up" asks for the children of a folder it must look inside, and only those', () => {
    const mega = { kind: 'mega', account: 'lackor3' }
    const r = [{ path: 'Digitalis/Szoftverek', target: mega }]
    const m = (rel: string, state: string, files: number, deep: string) => ({ rel, isDir: true, content: { state, files, folders: 0, deep } })
    const kids: Record<string, any[]> = {}
    const kidsOf = (rel: string) => kids[rel]
    const rows = [m('Digitalis', 'has', 0, 'has'), m('Gyors', 'has', 4, 'has'), m('Ures', 'empty', 0, 'empty')]
    expect(cf._cfNeedKids(rows, r, kidsOf, new Set())).toEqual(['Digitalis'])
    expect(cf._cfNeedKids(rows, r, kidsOf, new Set(['Digitalis'])), 'a failed load is not asked again').toEqual([])
    kids.Digitalis = [m('Digitalis/X', 'has', 0, 'has')]
    expect(cf._cfNeedKids(rows, r, kidsOf, new Set())).toEqual(['Digitalis/X'])
  })
  it('the list loads the children it needs and is wired in', () => {
    expect(app).toContain("if (cfOn && cfMode === 'down') void _cfLoadKids(rows)")
    expect(app).toContain('async function _cfLoadKids(rows)')
  })
})

// #964 (Boss TG 7334): with "only what is up" the tree still showed Rendszer/Tarolok/Drive, the folder Boss stood in,
// although nothing under it is on a cloud. The open folder must get no exception.
describe('cloud filter tree (#964)', () => {
  const cf = load() as any
  const rules = [{ path: 'Család/Korpás László', target: drive }]
  const kids = [dir('Család'), dir('Rendszer'), file('OLVASS_EL.md')]
  it('"up" drops a folder with nothing on a cloud, even when it is the open one', () => {
    const kept = cf._cfTreeKeep(kids, 'up', rules, () => undefined).map((e: any) => e.rel)
    expect(kept).toContain('Család')
    expect(kept).not.toContain('Rendszer')
  })
  it('the app no longer keeps the open path in the filtered tree', () => {
    expect(app).not.toMatch(/k\.rel === _intezoPath \|\| String\(_intezoPath\)\.startsWith\(k\.rel \+ '\/'\) \|\| _cfFilter/)
    expect(app).toContain('_cfTreeKeep(kids, cfMode, _bkRules')
  })
})
