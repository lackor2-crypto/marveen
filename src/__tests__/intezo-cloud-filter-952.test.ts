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

  it('"down": what has no rule, an explicit "do not back up", or something left out stays', () => {
    const list = [dir('Cegek'), dir('Csalad'), dir('Zsolt'), file('x.txt')]
    // Cegek has a do-not-back-up sub-folder -> still has something not up
    expect(names(cf._cfFilter(list, 'down', rules))).toEqual(['Cegek', 'Csalad', 'Zsolt', 'x.txt'])
    expect(names(cf._cfFilter([dir('Cegek/Temp'), dir('Cegek/Szamla')], 'down', rules))).toEqual(['Cegek/Temp'])
  })

  it('a fully covered folder is hidden in "down", and a left-out folder/type counts as not up', () => {
    const only = [{ path: 'Cegek', target: drive }]
    expect(names(cf._cfFilter([dir('Cegek'), dir('Cegek/Sub')], 'down', only))).toEqual([])
    expect(names(cf._cfFilter([dir('Cegek'), dir('Cegek/Sub')], 'up', only))).toEqual(['Cegek', 'Cegek/Sub'])
    const r = [{ path: 'Csalad/Anna/Iratok', target: drive, exclude: ['Regi', '*.fxt'] }]
    expect(cf._cfState(file('Csalad/Anna/Iratok/Regi/a.pdf'), r)).toEqual({ up: false, down: true })
    expect(cf._cfState(file('Csalad/Anna/Iratok/t.FXT'), r)).toEqual({ up: false, down: true })
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
    expect(app).toContain('cfTreeKeep(kids.filter')
    for (const lang of ['hu', 'en']) {
      const l = readFileSync(join(root, 'web', 'lang', `${lang}.js`), 'utf8')
      for (const k of ['cloud_filter', 'cloud_all', 'cloud_up', 'cloud_down', 'cloud_empty_up', 'cloud_empty_down', 'cloud_hidden_n', 'cloud_unknown', 'cloud_loading']) {
        expect(l, `${lang} ${k}`).toContain(`'intezo.${k}'`)
      }
    }
  })
})
