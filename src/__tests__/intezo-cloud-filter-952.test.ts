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
  return new Function('localStorage', '_bkNorm', block + '\nreturn { _cfMode, _cfSetMode, _cfState, _cfFilter }')(localStorage, _bkNorm)
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

  it('"down": what has no rule or an explicit "do not back up" stays; deliberately left-out items do not count', () => {
    const list = [dir('Cegek'), dir('Csalad'), dir('Zsolt'), file('x.txt')]
    // Cegek has a do-not-back-up sub-folder -> still has something not up
    expect(names(cf._cfFilter(list, 'down', rules))).toEqual(['Cegek', 'Csalad', 'Zsolt', 'x.txt'])
    expect(names(cf._cfFilter([dir('Cegek/Temp'), dir('Cegek/Szamla')], 'down', rules))).toEqual(['Cegek/Temp'])
  })

  it('a fully covered folder is hidden in "down", and a deliberately left-out folder/type counts as neither up nor still to upload', () => {
    const only = [{ path: 'Cegek', target: drive }]
    expect(names(cf._cfFilter([dir('Cegek'), dir('Cegek/Sub')], 'down', only))).toEqual([])
    expect(names(cf._cfFilter([dir('Cegek'), dir('Cegek/Sub')], 'up', only))).toEqual(['Cegek', 'Cegek/Sub'])
    const r = [{ path: 'Csalad/Anna/Iratok', target: drive, exclude: ['Regi', '*.fxt'] }]
    expect(cf._cfState(file('Csalad/Anna/Iratok/Regi/a.pdf'), r)).toEqual({ up: false, down: false })
    expect(cf._cfState(file('Csalad/Anna/Iratok/t.FXT'), r)).toEqual({ up: false, down: false })
    expect(cf._cfState(file('Csalad/Anna/Iratok/ok.pdf'), r)).toEqual({ up: true, down: false })
    expect(cf._cfState(dir('Csalad/Anna/Iratok/Regi'), r).up).toBe(false)
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
    expect(app).toMatch(/_cfFilter\(ordered\.rows, cfMode, _bkRules\)/)
    expect(app).toContain('cfTreeKeep(_intezoTreeKids.get(rel))')
    for (const lang of ['hu', 'en']) {
      const l = readFileSync(join(root, 'web', 'lang', `${lang}.js`), 'utf8')
      for (const k of ['cloud_filter', 'cloud_all', 'cloud_up', 'cloud_down', 'cloud_empty_up', 'cloud_empty_down', 'cloud_hidden_n', 'cloud_unknown', 'cloud_loading']) {
        expect(l, `${lang} ${k}`).toContain(`'intezo.${k}'`)
      }
    }
  })
  // TG 7156 (Boss's real rules): the person's folder leaves Media/Fotok and Projektek out of ITS rule, but both are
  // covered by their own rules (Photos / MEGA). They are on the cloud -- not "left out".
  it('an excluded sub-folder covered by ANOTHER rule is not "not up" (Media, the person folder)', () => {
    const p = 'Csalad/Laszlo'
    const real = [
      { path: p, target: { kind: 'drive', account: 'lackor2' }, exclude: ['Media/Fotok', 'Projektek'] },
      { path: p + '/Media/Fotok', target: { kind: 'photos', account: 'lackor3' } },
      { path: p + '/Projektek', target: { kind: 'mega', account: 'lackor3' } },
    ]
    expect(cf._cfState(dir(p + '/Media'), real)).toEqual({ up: true, down: false })
    expect(cf._cfState(dir(p), real)).toEqual({ up: true, down: false })
    expect(names(cf._cfFilter([dir(p + '/Media'), dir(p + '/Projektek')], 'down', real))).not.toContain(p + '/Media')
    // TG 7163: a folder whose own rule only leaves sub-folders / types out is on the cloud: it never shows in "down"
    const proj = [{ path: p + '/Projektek', target: { kind: 'mega', account: 'lackor3' }, exclude: ['Tester', 'logs', '*.fxt'] }]
    expect(cf._cfState(dir(p + '/Projektek'), proj)).toEqual({ up: true, down: false })
    expect(names(cf._cfFilter([dir(p + '/Projektek')], 'down', proj))).toEqual([])
    // and what it leaves out is neither up nor still to upload
    expect(cf._cfState(dir(p + '/Projektek/Tester'), proj)).toEqual({ up: false, down: false })
  })
  it('the folder mark does not call an excluded sub-folder "backed up" (same blind spot, TG 7156)', () => {
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
    expect(badge({ rel: 'P/Tester', isDir: true })).toContain('backup.none')
    expect(badge({ rel: 'P/Tester', isDir: true })).toContain('backup.tip_left_out')
    expect(badge({ rel: 'P/Other', isDir: true })).toContain('☁')
    for (const lang of ['hu', 'en']) expect(readFileSync(join(root, 'web', 'lang', lang + '.js'), 'utf8')).toContain("'backup.tip_left_out'")
  })
})
