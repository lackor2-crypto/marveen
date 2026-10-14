// The debate's left / right / judge model fields are dropdowns of the model catalog (like the agent card's model
// picker), not text boxes with a type-ahead list (Boss, TG 3379).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
describe('debate model fields', () => {
  it('are selects fed from the catalog; the judge may stay empty; no type-ahead datalist is left', () => {
    const fn = js.slice(js.indexOf('function dbModelInput('), js.indexOf('function dbSetupHtml('))
    expect(fn).toContain('<select class="wb-input" id="')
    expect(fn).not.toContain('<input')
    expect(fn).toContain('workbench.db.judge_none')
    expect(js).not.toContain('wbDbModelList')
    expect(js).toContain("dbModelInput('wbDbJudge', t('workbench.db.judge_label'), s.judge, true)")
  })
})
