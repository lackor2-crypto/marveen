// #599 (Boss TG 3283): with the cursor in a chapter title the format buttons used to fall back to the LAST paragraph
// the cursor had been in, so "centre" moved the line BELOW the title. The target must be null there, with its own message.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const js = readFileSync(join(process.cwd(), 'web/workbench.js'), 'utf8')
const lang = (l: string): string => readFileSync(join(process.cwd(), `web/lang/${l}.js`), 'utf8')

describe('#599 format target on a chapter title', () => {
  it('dpFmtTarget does not fall back to the last paragraph while the cursor is in another page element', () => {
    const body = js.slice(js.indexOf('function dpFmtTarget()'), js.indexOf('function dpAlignIcon'))
    expect(body).toMatch(/if \(a\) return null\s+var last/)
  })

  it('both toolbar paths say why instead of the generic "click into the text" on a title', () => {
    expect((js.match(/dpOnTitle\(\) \? 'workbench\.dp\.fmt_title'/g) || []).length).toBe(2)
  })

  it('the message exists in both languages', () => {
    expect(lang('hu')).toContain('"workbench.dp.fmt_title"')
    expect(lang('en')).toContain('"workbench.dp.fmt_title"')
  })
})
