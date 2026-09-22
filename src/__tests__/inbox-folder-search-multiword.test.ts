/**
 * BEERKEZO MAPPAVALASZTO KERESO -- tobb szavas beiras (kartya 03791582).
 *
 * Boss, 2026-09-19: "Korpás László" minden mappat mutatott, de "Korpás László H"
 * beirasra 0 talalat, pedig 4 Hatosagok mappa van alatta. Ok: a szuro egyetlen
 * osszefuggo substringet keresett, a rel utvonalban viszont '/' all a szintek
 * kozott, a beirt szovegben szokoz. A valodi _inboxFolderListHtml-t futtatjuk.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = readFileSync(join(__dirname, '..', '..', 'web', 'app.js'), 'utf8')

function extractFn(src: string, name: string): string {
  const start = new RegExp(`function ${name}\\s*\\(`).exec(src)
  if (!start) throw new Error(`nincs ilyen fuggveny: ${name}`)
  const i = src.indexOf('{', start.index)
  let depth = 0
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start.index, j + 1) }
  }
  throw new Error(`nem zarodik: ${name}`)
}

const FOLDERS = [
  'Korpás László',
  'Korpás László/Hatóságok',
  'Korpás László/Hatóságok/Magyarország',
  'Korpás László/Hatóságok/Németország',
  'Korpás László/Hatóságok/Ausztria',
  'Korpás László/Bank',
  'Kiss Anna/Hatóságok',
]

function search(filter: string): string[] {
  const make = new Function(
    'folders',
    [
      'var _inboxKnownFolders = folders.map(function (rel) { return { rel: rel } })',
      'var _INBOX_FOLDER_LIST_MAX = 40',
      'function escapeHtml(s) { return String(s) }',
      'function escapeAttr(s) { return String(s) }',
      'function t(k) { return k }',
      'function _inboxCrumb(rel) { return rel }',
      extractFn(app, '_inboxFold'),
      extractFn(app, '_inboxFolderListHtml'),
      'return _inboxFolderListHtml',
    ].join('\n'),
  )
  const fn = make(FOLDERS)
  const html: string = fn({ owner: { options: [], personId: null }, targetRel: '' }, filter)
  return [...html.matchAll(/data-folder-rel="([^"]*)"/g)].map((m) => m[1])
}

describe('Beerkezo mappavalaszto kereso -- tobb szavas beiras', () => {
  it('"Korpás László H" -> a 4 Hatosagok mappa (a regi kod 0-t adott)', () => {
    expect(search('Korpás László H')).toEqual([
      'Korpás László/Hatóságok',
      'Korpás László/Hatóságok/Ausztria',
      'Korpás László/Hatóságok/Magyarország',
      'Korpás László/Hatóságok/Németország',
    ])
  })

  it('ekezet nelkul, sorrendfuggetlenul, tobbszoros szokozzel is illeszkedik', () => {
    expect(search('nemet   korpas')).toEqual(['Korpás László/Hatóságok/Németország'])
  })

  it('minden szonak illeszkednie kell (AND), nem eleg egy', () => {
    expect(search('Korpás Kiss')).toEqual([])
  })

  it('egyszavas es ures szuro valtozatlanul mukodik', () => {
    expect(search('bank')).toEqual(['Korpás László/Bank'])
    expect(search('   ')).toHaveLength(FOLDERS.length)
  })
})
