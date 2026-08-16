// The "jóváhagyásra küldés" button must ASK, not answer on the owner's behalf.
//
// Boss, 2026-08-16: "mellesleg a kanban ban levo varakozo kartyakba bele mentem
// es egyiket sem lehetett jovahagyasra kuldeni. hibat jelzett. mind." The button
// was hitting the server-side similar-card gate and showing him a raw failure.
//
// The first fix sent `similar_reviewed: []` with every request. That silenced
// the error, but an empty array IS an answer -- it tells the server "I have seen
// the list of related cards and none of them matter". Hardcoding it makes the
// button claim, in the owner's name, that he reviewed a list he was never
// shown, and the gate (src/kanban-related.ts, similarCardsBeforeClose) becomes a
// check that exists on paper while nobody is ever asked. Worse than the 400 it
// replaced, because it fails silently.
//
// So the flow is two steps: ask without the field, and only if the server
// objects, show him the actual cards and let him answer.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WEB = join(__dirname, '..', '..', 'web')
const app = readFileSync(join(WEB, 'app.js'), 'utf8')
const hu = readFileSync(join(WEB, 'lang', 'hu.js'), 'utf8')
const en = readFileSync(join(WEB, 'lang', 'en.js'), 'utf8')

/** The button handler, brace-matched out of the classic (non-module) script. */
function approvalHandler(): string {
  const start = app.indexOf('requestApprovalBtn.onclick')
  expect(start, 'requestApprovalBtn.onclick not found in web/app.js').toBeGreaterThan(-1)
  let depth = 0
  for (let i = app.indexOf('{', start); i < app.length; i++) {
    if (app[i] === '{') depth++
    else if (app[i] === '}' && --depth === 0) return app.slice(start, i + 1)
  }
  throw new Error('unbalanced braces after requestApprovalBtn.onclick')
}

describe('kanban: sending a card for approval', () => {
  const handler = approvalHandler()

  it('never answers the similar-card question on the owner behalf', () => {
    // A literal empty array as the field value is the exact regression.
    expect(handler).not.toMatch(/similar_reviewed\s*:\s*\[\s*\]/)
  })

  it('sends the first request WITHOUT the field, so the server can object', () => {
    expect(handler).toMatch(/similar_reviewed/)
    // conditional spread: the field only appears when there is a real answer
    expect(handler).toMatch(/\?\s*\{\s*similar_reviewed/)
  })

  it('reads the candidate list out of the server response', () => {
    expect(handler).toMatch(/errBody\.similar|\.similar\b/)
    expect(handler).toMatch(/Array\.isArray/)
  })

  it('shows the owner the cards before it re-sends anything', () => {
    const confirmAt = handler.indexOf('confirm(')
    const resendAt = handler.lastIndexOf('post(')
    expect(confirmAt).toBeGreaterThan(-1)
    expect(resendAt).toBeGreaterThan(confirmAt)
  })

  it('sends the cards he was actually shown, not a blanket answer', () => {
    expect(handler).toMatch(/post\(\s*similar\.map/)
  })

  it('a refusal cancels instead of submitting anyway', () => {
    expect(handler).toMatch(/if\s*\(!confirm/)
    expect(handler).toMatch(/approval_cancelled/)
  })

  it('surfaces the server message instead of a bare "hiba"', () => {
    expect(handler).toMatch(/errBody\.error/)
  })

  // The owner is a bricklayer, not a programmer (CLAUDE.md): no field names, no
  // status codes, and every string of this dialog translated in both languages.
  it('speaks through i18n keys, never a hardcoded sentence', () => {
    for (const key of ['kanban.approval.similar_intro', 'kanban.approval.similar_ask']) {
      expect(handler, `${key} must be used by the dialog`).toContain(key)
    }
  })

  it('has all three new strings in Hungarian and in English', () => {
    for (const key of [
      'kanban.toast.approval_cancelled',
      'kanban.approval.similar_intro',
      'kanban.approval.similar_ask',
    ]) {
      expect(hu, `${key} missing from web/lang/hu.js`).toContain(key)
      expect(en, `${key} missing from web/lang/en.js`).toContain(key)
    }
  })

  it('never puts the field name or a status code in front of the owner', () => {
    const shown = handler.match(/t\('[^']+'\)/g) ?? []
    expect(shown.length).toBeGreaterThan(0)
    expect(handler).not.toMatch(/confirm\(`[^`]*similar_reviewed/)
    expect(handler).not.toMatch(/showToast\([^)]*400/)
  })
})
