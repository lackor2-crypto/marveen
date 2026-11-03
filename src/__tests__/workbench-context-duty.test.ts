// Boss (2026-11-03): what the owner says in the chat and what the assistant looks up MUST go into the item's context file, before the
// answer. The duty is in the assistant's own context every turn, in the skill, the template and the rules.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONTEXT_DUTY_RULE } from '../workbench-agent/context.js'

const read = (p: string) => readFileSync(join(__dirname, '..', '..', p), 'utf8')

describe('the context-file duty is mandatory and burned in', () => {
  it('the assistant prompt carries it', () => {
    expect(CONTEXT_DUTY_RULE).toContain('MANDATORY')
    expect(CONTEXT_DUTY_RULE).toContain('context.append')
    expect(CONTEXT_DUTY_RULE).toContain('e-mail addresses')
    expect(read('src/workbench-agent/context.ts')).toContain('      CONTEXT_DUTY_RULE,')
  })
  it('the skill, the template and the rule book name it', () => {
    expect(read('seed-skills/workitem-context-file/SKILL.md')).toContain('KÖTELEZŐ, minden fordulóban')
    expect(read('templates/CLAUDE.md.template')).toContain('A KONTEXTUSBA BE KELL ÍRNI')
    expect(read('seed-skills/marveen-learned-rules/SKILL.md')).toContain('### R33')
  })
})
