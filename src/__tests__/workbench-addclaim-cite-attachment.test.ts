// #794 (Boss, TG 3382): a fact that stands in an attachment must be cited from it verbatim, never as an "owner said" source.
import { describe, it, expect } from 'vitest'
import { getTool } from '../workbench-agent/tools.js'

describe('doc.addClaim tells the agent to cite attachments', () => {
  it('the tool description carries the verbatim-quote rule', () => {
    const d = getTool('doc.addClaim')?.description || ''
    expect(d).toMatch(/VERBATIM quote/)
    expect(d).toMatch(/never register such a fact as an owner source/)
  })
})
