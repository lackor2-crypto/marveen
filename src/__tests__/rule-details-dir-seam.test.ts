// #868 follow-up regression: the suite must never touch the operator's real
// ~/.claude/rule-details. Red before the seam (ruleDetailsDir() resolved the real
// HOME and the 8 rule-section tests read the operator's own rule files), green after.
import { existsSync, readdirSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ruleDetailsDir, ruleBody } from '../web/rule-digests.js'
import { withDetails } from './helpers/rule-details.js'

describe('rule-details directory under the test suite', () => {
  const real = join(userInfo().homedir, '.claude', 'rule-details')

  it('is a scratch directory, not the real ~/.claude/rule-details', () => {
    expect(ruleDetailsDir()).not.toBe(real)
    expect(ruleDetailsDir().startsWith(tmpdir())).toBe(true)
  })

  it('writing a rule leaves the real directory alone and withDetails reads only the scratch one', () => {
    const before = existsSync(real) ? readdirSync(real).sort() : null
    ruleBody('ask-back', '## Cim\n\nSCRATCH-ONLY-MARKER ' + 'x '.repeat(100))
    expect(existsSync(join(ruleDetailsDir(), 'ask-back.md'))).toBe(true)
    expect(withDetails('')).toContain('SCRATCH-ONLY-MARKER')
    const after = existsSync(real) ? readdirSync(real).sort() : null
    expect(after).toEqual(before)
  })
})
