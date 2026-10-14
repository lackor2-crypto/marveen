// #599 (Boss TG 3283): with the cursor in a chapter title the format buttons used to fall back to the LAST paragraph
// the cursor had been in, so "centre" moved the line BELOW the title. #604 (Boss TG 3357): the title is now the target
// itself (alignment, bold, font ...); anything else that is not a paragraph still never falls back to the last one.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const js = readFileSync(join(process.cwd(), 'web/workbench.js'), 'utf8')
const lang = (l: string): string => readFileSync(join(process.cwd(), `web/lang/${l}.js`), 'utf8')

describe('#599 format target on a chapter title', () => {
  it('dpFmtTarget does not fall back to the last paragraph while the cursor is in another page element', () => {
    const body = js.slice(js.indexOf('function dpFmtTarget()'), js.indexOf('function dpAlignIcon'))
    expect(body).toMatch(/if \(dpTitleTarget\(\)\) return a\s+[\s\S]*if \(a\) return null\s+var last/)
  })

  it('a title says why it has no list / indent / line spacing instead of the generic message', () => {
    expect((js.match(/window\.showToast\(t\('workbench\.dp\.fmt_title'\)\)/g) || []).length).toBe(2)
  })

  it('the message exists in both languages', () => {
    expect(lang('hu')).toContain('"workbench.dp.fmt_title"')
    expect(lang('en')).toContain('"workbench.dp.fmt_title"')
  })
})
