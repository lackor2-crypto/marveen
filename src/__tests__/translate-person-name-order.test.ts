// Boss, Workbench chat 2026-11-10: a German language version kept "Bakos Éva" (Hungarian order) in the sender table
// and the signature. The translator prompt now carries a name-order rule for every target language.
import { describe, expect, it } from 'vitest'
import { buildTranslatePrompt } from '../workbench-doclang-translate.js'
import { personNameOrderRule, variantLanguageRule } from '../workbench-agent/doc-language.js'
import { TOOLS } from '../workbench-agent/tools.js'
import { initDatabase } from '../db.js'
import { createProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { createVariant } from '../workbench-doclang.js'
import { addSection } from '../workbench-docmodel.js'
import { buildContext } from '../workbench-agent/context.js'

const blocks = [{ id: 'b1', kind: 'table', text: 'Feladó:\nBakos Éva\nChemnitz', claims: [] }]

describe('person name order in translations', () => {
  it('German and English targets: a Hungarian name is turned round, everywhere it occurs', () => {
    for (const lang of ['de', 'en']) {
      const rule = personNameOrderRule(lang)
      expect(rule).toContain('GIVEN name first')
      expect(rule).toContain('"Bakos Éva" -> "Éva Bakos"')
      expect(rule).toMatch(/sender block.*signature/)
      const p = buildTranslatePrompt({ targetLang: lang, title: 'Levél', blocks, glossary: [] })
      expect(p.system).toContain(rule)
    }
  })

  it('a Hungarian target: family name first', () => {
    const rule = personNameOrderRule('hu')
    expect(rule).toContain('FAMILY name first')
    expect(rule).toContain('"Éva Bakos" -> "Bakos Éva"')
    expect(buildTranslatePrompt({ targetLang: 'hu', title: 'x', blocks, glossary: [] }).system).toContain(rule)
  })

  it('the old "names stay exact" sentence no longer forbids turning a name round', () => {
    const p = buildTranslatePrompt({ targetLang: 'de', title: 'x', blocks, glossary: [] })
    expect(p.system).not.toContain('Names, numbers, dates')
    expect(p.system).toContain('Names keep their spelling')
  })

  it('the agent tool doc.translateSection tells the agent the same rule', () => {
    const t = (TOOLS as Array<{ name: string; description: string }>).find((x) => x.name === 'doc.translateSection')
    expect(t?.description).toContain('GIVEN NAME FIRST')
    expect(t?.description).not.toContain('keep names, case numbers')
  })

  it('the agent context of a language version carries the name-order rule too (sender table, salutation, mail draft)', () => {
    for (const lang of ['de', 'en', 'hu']) {
      expect(variantLanguageRule(lang)).toContain(personNameOrderRule(lang))
    }
  })
  it('what the model really sees in a German language version (buildContext) holds the name-order rule, in the first block', async () => {
    initDatabase(':memory:')
    const p = createProject({ name: 'Nemet hivatalok', description: 'Levelek' })
    if (!p.ok) throw new Error('project')
    const w = createWorkItem({ project_id: p.project.id, title: 'ARD level', type: 'document' })
    if (!w.ok) throw new Error('work item')
    addSection(w.item.id, '1. Tenyallas')
    const v = createVariant(w.item, 'de', 'teszt')
    if (!v.ok) throw new Error(v.detail)
    const ctx = await buildContext(p.project, v.item, 'hu')
    expect(ctx.contextText).toContain(personNameOrderRule('de'))
    expect(ctx.contextText.indexOf(personNameOrderRule('de'))).toBeLessThan(2000)
    // the original (not a version) does not get the rule
    const orig = await buildContext(p.project, w.item, 'hu')
    expect(orig.contextText).not.toContain(personNameOrderRule('de'))
  })
})
