/**
 * #794: the language of the document that is opened, finalized and attached to the mail is the owner's choice.
 * Source contract of the choice dialog (the real behaviour was clicked through in a browser).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')

describe('workbench language choice before review / mail (#794)', () => {
  it('the review link asks which language version, with nothing pre-selected', () => {
    expect(js).toMatch(/function pickFinalLang\(/)
    expect(js).toMatch(/name="wbFinalLang" value="' \+ i \+ '">/)
    expect(js).not.toMatch(/name="wbFinalLang" value=[^>]*checked/)
    expect(js).toMatch(/id="wbFinalLangGo" disabled/)
    expect(js).toMatch(/rvOpts\.length > 1 && ev\)/)
    expect(js).not.toMatch(/finalLangChosen/)
    expect(js).toMatch(/outlineAction\(a, act, e\)/)
  })
  it('the chosen language opens at once and the owner STAYS on his item (no jump, no empty window) -- Boss TG 4105', () => {
    const go = js.slice(js.indexOf("go.addEventListener('click'"), js.indexOf('function watchReview'))
    expect(go).toMatch(/window\.open\('', '_blank'\)/)
    expect(go).toMatch(/openAuthed\(href, /)
    expect(go).not.toMatch(/selectItem\(/)
    expect(go).toMatch(/final_path && !x\.final_stale/)
    expect(js).not.toMatch(/openReviewWhenLoaded/)
    expect(js).toMatch(/source_final/)
    expect(js).toMatch(/\(o\.siblings \|\| \[\]\)\.forEach/)
    const srv = readFileSync(join(__dirname, '..', 'web', 'routes', 'workbench.ts'), 'utf8')
    expect(srv).toMatch(/siblings: variant \? variantsSummary\(variant\.source_item_id\)\.filter\(\(x\) => x\.item_id !== item\.id\)/)
  })
  it('the mail draft names the attachment language and asks before it is made', () => {
    expect(js).toMatch(/workbench\.finalpick\.mail_confirm/)
    expect(js).toMatch(/workbench\.finalpick\.mail_lang/)
  })
  it('every finalpick key exists in both languages', () => {
    for (const f of ['hu', 'en']) {
      const s = readFileSync(join(__dirname, '..', '..', 'web', 'lang', f + '.js'), 'utf8')
      for (const k of ['title', 'purpose_open', 'original', 'here', 'cancel', 'go', 'opened_final', 'opened_stale', 'opened_draft', 'mail_confirm', 'mail_lang']) {
        expect(s).toContain('"workbench.finalpick.' + k + '"')
      }
    }
  })
})
