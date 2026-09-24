/**
 * Kanban #370: az Intezoben a mappa elotti PONT csak akkor jar, ha az agban
 * (barmilyen melyen) van legalabb egy VALODI fajl. Egy csupa ures mappabol
 * allo ag (pl. Ceg / Media > Audio / Fotok / Videok) ures kort kap.
 *
 * A jelzest ugyanaz a fuggveny rajzolja a listaban es a fa-nezetben, ezert a
 * fuggvenyt magat futtatjuk, nem egy sort egyeztetunk.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..', '..')
const app = readFileSync(resolve(root, 'web', 'app.js'), 'utf8')

function extract(name: string): string {
  const start = app.indexOf(`function ${name}(`)
  expect(start, name).toBeGreaterThan(-1)
  const end = app.indexOf('\n}\n', start)
  return app.slice(start, end + 2)
}

const t = (k: string, p?: Record<string, unknown>) => (p ? `${k}:${JSON.stringify(p)}` : k)
const escapeHtml = (s: string) => String(s)
// eslint-disable-next-line no-new-func
const mark = new Function('t', 'escapeHtml',
  `${extract('_intezoCountText')}\n${extract('_intezoContentMark')}\nreturn _intezoContentMark`,
)(t, escapeHtml) as (e: unknown) => string

const dir = (content: Record<string, unknown>) => ({ isDir: true, content })
const sym = (html: string) => (html.match(/>(.)<\/span>$/) || [])[1]

describe('Intezo: pont csak valodi fajlnal', () => {
  it('fajl kozvetlenul benne -> pont', () => {
    expect(sym(mark(dir({ state: 'has', folders: 0, files: 2, deep: 'has', reason: '' })))).toBe('●')
  })

  it('fajl melyen, csak almappaban -> pont', () => {
    expect(sym(mark(dir({ state: 'has', folders: 1, files: 0, deep: 'has', reason: '' })))).toBe('●')
  })

  it('csak ures mappak az agban -> ures kor, a buborek megmondja miert', () => {
    const html = mark(dir({ state: 'has', folders: 4, files: 0, deep: 'empty', reason: '' }))
    expect(sym(html)).toBe('○')
    expect(html).toContain('intezo.content_only_empty_folders')
  })

  it('teljesen ures -> ures kor', () => {
    expect(sym(mark(dir({ state: 'empty', folders: 0, files: 0, deep: 'empty', reason: '' })))).toBe('○')
  })

  it('a melysegi meres nem ert vegig -> kerdojel a valodi okkal, NEM pont es NEM kor', () => {
    const html = mark(dir({ state: 'has', folders: 2, files: 0, deep: 'unknown', reason: 'EACCES' }))
    expect(sym(html)).toBe('?')
    expect(html).toContain('EACCES')
  })

  it('az uj szoveg mindket nyelven megvan', () => {
    for (const f of ['hu.js', 'en.js']) {
      expect(readFileSync(resolve(root, 'web', 'lang', f), 'utf8')).toContain("'intezo.content_only_empty_folders'")
    }
  })
})
