import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SES = readFileSync(join(__dirname, '..', 'workbench-agent', 'sessions.ts'), 'utf8')
const ORC = readFileSync(join(__dirname, '..', 'workbench-agent', 'orchestrator.ts'), 'utf8')
const JS = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')

describe('one assistant chat per document family (TG 3945)', () => {
  it('the session and the turn lock use the original of a language version', () => {
    expect(SES).toContain('export function chatFamilyKey')
    expect(SES).toContain('variantOf(workItemId)?.source_item_id')
    expect(SES).toMatch(/const workItemId = chatFamilyKey\(rawWorkItemId\)/)
    expect(ORC).toContain('`item:${chatFamilyKey(workItemId)}`')
  })
  it('the page keeps the chat of the family, not of the opened version', () => {
    const i = JS.indexOf('function chatKey()')
    expect(JS.slice(i, i + 500)).toContain('o.variant.source_item_id')
  })
})
