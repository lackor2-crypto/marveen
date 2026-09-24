/**
 * Kanban #371: az Intezo listajanak fejlece es oszlopai -- Nev, Modositas
 * datuma, Tipus, Meret (mint a Windows Intezoben), mindket nyelven.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..', '..')
const app = readFileSync(resolve(root, 'web', 'app.js'), 'utf8')

function extract(name: string): string {
  const start = app.indexOf(`function ${name}(`)
  expect(start, name).toBeGreaterThan(-1)
  return app.slice(start, app.indexOf('\n}\n', start) + 2)
}

const t = (k: string, p?: Record<string, unknown>) => (p ? `${k}:${JSON.stringify(p)}` : k)
// eslint-disable-next-line no-new-func
const typeText = new Function('t', `${extract('_intezoTypeText')}\nreturn _intezoTypeText`)(t) as (e: unknown) => string
// eslint-disable-next-line no-new-func
const dateText = new Function('window', `${extract('_intezoDateText')}\nreturn _intezoDateText`)({ _lang: 'hu' }) as (e: unknown) => string

describe('Intezo oszlopok', () => {
  it('a tabla fejlecet kap a negy oszlopnevvel', () => {
    for (const k of ['intezo.col_name', 'intezo.col_modified', 'intezo.col_type', 'intezo.col_size']) {
      expect(app).toContain(`t('${k}')`)
    }
    expect(app).toContain('<thead><tr class="intezo-head">')
    // Az adatlap sora a teljes szelesseget atfogja (6 oszlop).
    expect(app).toContain('td.colSpan = 6')
  })

  it('a tipus: mappa, kiterjesztes, kiterjesztes nelkul', () => {
    expect(typeText({ isDir: true, name: 'Media' })).toBe('intezo.type_folder')
    expect(typeText({ isDir: false, name: 'szamla.pdf' })).toBe('intezo.type_file_ext:{"ext":"PDF"}')
    expect(typeText({ isDir: false, name: 'README' })).toBe('intezo.type_file')
    expect(typeText({ isDir: false, name: '.env' })).toBe('intezo.type_file')
  })

  it('a datum: van -> kiirva, nincs vagy hibas -> ures (nem talalt ki)', () => {
    expect(dateText({ mtime: '2026-09-24T10:05:00.000Z' })).toMatch(/2026/)
    expect(dateText({ mtime: '' })).toBe('')
    expect(dateText({ mtime: 'nem-datum' })).toBe('')
  })

  it('minden uj kulcs megvan mindket nyelven', () => {
    const keys = ['intezo.col_name', 'intezo.col_modified', 'intezo.col_type', 'intezo.col_size',
      'intezo.type_folder', 'intezo.type_file', 'intezo.type_file_ext']
    for (const f of ['hu.js', 'en.js']) {
      const src = readFileSync(resolve(root, 'web', 'lang', f), 'utf8')
      for (const k of keys) expect(src, `${f}: ${k}`).toContain(`'${k}'`)
    }
  })

  it('telefon-szelessegen a datum es a tipus oszlop elrejtodik', () => {
    const css = readFileSync(resolve(root, 'web', 'style.css'), 'utf8')
    expect(css).toMatch(/@media \(max-width: 640px\)[\s\S]*?intezo-col-date[\s\S]*?display: none/)
  })
})
