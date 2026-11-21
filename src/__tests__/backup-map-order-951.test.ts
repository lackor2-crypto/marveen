// #951 (Boss TG 7136): the backup map was jumbled -- Mega, Drive, Mega, Drive,
// lackor3, usalackor, lackor3 again. Drive accounts together, MEGA accounts
// together, each account's rules one after the other; the account's used/total
// space sits in a column of the list. Pure logic, run from the real app.js.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const app = readFileSync(join(root, 'web', 'app.js'), 'utf8')
const block = app.slice(app.indexOf('// BK-MAP-ORDER-BEGIN'), app.indexOf('// BK-MAP-ORDER-END'))
// eslint-disable-next-line no-new-func
const m = new Function('_bkGb', block + '\nreturn { _bkMapOrder, _bkUsedText }')((b: number) => (b / 1e9).toFixed(1))

const rule = (path: string, kind?: string, account?: string) => ({ path, target: kind ? { kind, account } : null })

describe('backup map order and used space (#951)', () => {
  it('groups Drive, then Photos, then MEGA, then "do not back up"; accounts stay together', () => {
    const mixed = [
      rule('F', 'mega', 'lackor3'), rule('E', 'drive', 'lackor3'), rule('D', 'mega', 'lackor2'),
      rule('C', 'drive', 'usalackor'), rule('B', 'mega', 'lackor3'), rule('A', 'drive', 'lackor3'),
      rule('N'), rule('P', 'photos', 'canada'), rule('Z', 'drive', 'usalackor'),
    ]
    const out = m._bkMapOrder(mixed).map((r: any) => (r.target ? r.target.kind + ':' + r.target.account : 'none') + '/' + r.path)
    expect(out).toEqual([
      'drive:lackor3/A', 'drive:lackor3/E', 'drive:usalackor/C', 'drive:usalackor/Z',
      'photos:canada/P',
      'mega:lackor2/D', 'mega:lackor3/B', 'mega:lackor3/F',
      'none/N',
    ])
  })

  it('shows used / total, and nothing invented for an unmeasured account', () => {
    expect(m._bkUsedText({ free: 7e9, total: 15e9 })).toBe('8,0 / 15,0 GB')
    expect(m._bkUsedText({ free: null, total: 15e9 })).toBeNull()
    expect(m._bkUsedText({ free: 1, total: null })).toBeNull()
    expect(m._bkUsedText(undefined)).toBeNull()
  })

  it('is wired in: sorted rows, group caption, used column, wider box, HU+EN', () => {
    expect(app).toContain('_bkMapOrder(_bkRules)')
    expect(app).toContain('bk-map-group')
    expect(app).toContain('bk-map-used')
    expect(app).toMatch(/_bkPanel\(t\('backup\.map_title'\), 780\)/)
    for (const lang of ['hu', 'en']) {
      const l = readFileSync(join(root, 'web', 'lang', `${lang}.js`), 'utf8')
      expect(l).toContain("'backup.map_col_used'")
      expect(l).toContain("'backup.map_col_used_tip'")
    }
  })
})
