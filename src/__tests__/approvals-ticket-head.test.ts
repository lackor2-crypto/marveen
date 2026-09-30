// #446 (Boss TG 1976, 1980): an approval that is not a card close-out starts
// with "Jóváhagyási jegy megerősítésre" and its own short id, so the owner can
// tell what it is and which one; a kanban_done row keeps its "Kártya #N" start.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const js = readFileSync(join(process.cwd(), 'web', 'app.js'), 'utf8')
const hu = readFileSync(join(process.cwd(), 'web', 'lang', 'hu.js'), 'utf8')
const en = readFileSync(join(process.cwd(), 'web', 'lang', 'en.js'), 'utf8')

function load(lang: string): (a: unknown) => string {
  const start = js.indexOf('function _approvalTicketHeadHtml(')
  expect(start).toBeGreaterThan(-1)
  const end = js.indexOf('\n}\n', start)
  const body = js.slice(start, end + 2)
  const dict: Record<string, string> = {}
  for (const m of lang.matchAll(/'(approvals\.ticket\.[a-z_]+)':\s*'([^']*)'/g)) dict[m[1]] = m[2]
  const t = (key: string, params: Record<string, string> = {}) =>
    (dict[key] ?? key).replace(/\{(\w+)\}/g, (_: string, k: string) => params[k] ?? '')
  const escapeHtml = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  // eslint-disable-next-line no-new-func
  return new Function('t', 'escapeHtml', `${body}; return _approvalTicketHeadHtml`)(t, escapeHtml)
}

describe('approvals: ticket head for non-card approvals', () => {
  it('a pending non-card approval opens with the ticket label and its short id', () => {
    const head = load(hu)({ id: 'dfeed0d1-d118-4af0-9505-1f084fa6931f', status: 'pending', category: 'package_install' })
    expect(head).toContain('Jóváhagyási jegy megerősítésre')
    expect(head).toContain('azonosító: dfeed0d1')
    expect(head).not.toContain('d118')
  })

  it('a settled ticket says only what it is, not "for confirmation"', () => {
    const head = load(hu)({ id: 'dfeed0d1-d118', status: 'approved', category: 'package_install' })
    expect(head).toContain('Jóváhagyási jegy')
    expect(head).not.toContain('megerősítésre')
  })

  it('a card close-out approval gets no ticket label (it starts with "Kártya #N")', () => {
    expect(load(hu)({ id: 'fa6cd5fc-0a08', status: 'pending', category: 'kanban_done' })).toBe('')
  })

  it('English has the same label', () => {
    const head = load(en)({ id: 'dfeed0d1-d118', status: 'pending', category: 'package_install' })
    expect(head).toContain('Approval ticket for confirmation')
    expect(head).toContain('ID: dfeed0d1')
  })

  it('the table puts the head in front of the description, folded and unfolded', () => {
    expect(js).toMatch(/const ticketHead = _approvalTicketHeadHtml\(a\)/)
    expect(js).toMatch(/\? `\$\{ticketHead\}<div style="white-space:pre-wrap;word-break:break-word">\$\{fullDesc\}<\/div>/)
    expect(js).toMatch(/: ticketHead \+ shortDesc/)
  })
})
