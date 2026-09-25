// #385: the header count boxes double as list filters (Approvals, Ideas,
// Skills, Memory, MCP). The helpers are exercised for real (extracted from
// web/app.js and evaluated with stub t/escape functions); the per-page wiring
// is guarded with short string contracts, the house idiom for app.js.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')
const CSS = readFileSync(join(__dirname, '../../web/style.css'), 'utf-8')
const HU = readFileSync(join(__dirname, '../../web/lang/hu.js'), 'utf-8')
const EN = readFileSync(join(__dirname, '../../web/lang/en.js'), 'utf-8')

function extractFn(name: string): string {
  const start = APP.indexOf(`function ${name}(`)
  expect(start, `function ${name} missing`).toBeGreaterThan(-1)
  const end = APP.indexOf('\n}\n', start)
  return APP.slice(start, end + 2)
}

const t = (k: string, p?: Record<string, string>) => (p ? `${k}:${JSON.stringify(p)}` : k)
const escapeAttr = (s: unknown) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

// eslint-disable-next-line @typescript-eslint/no-implied-eval
const statFilterCard = new Function('t', 'escapeAttr', `${extractFn('statFilterCard')}; return statFilterCard`)(t, escapeAttr)
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const ideaStatusMatches = new Function(`${extractFn('_ideaStatusMatches')}; return _ideaStatusMatches`)()

describe('statFilterCard', () => {
  it('renders a real button carrying the filter key and aria-pressed', () => {
    const html = statFilterCard({ value: 3, label: 'Pending', filter: 'pending', active: false })
    expect(html).toMatch(/^<button type="button" class="stat-card stat-card--filter"/)
    expect(html).toContain('data-stat-filter="pending"')
    expect(html).toContain('aria-pressed="false"')
    expect(html).toContain('statFilter.title_on')
  })

  it('marks the active box and offers to clear it', () => {
    const html = statFilterCard({ value: 3, label: 'Pending', filter: 'pending', active: true })
    expect(html).toContain('is-active')
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('statFilter.title_off')
  })

  it('a box with a custom active title uses it (e.g. Total = nothing to clear)', () => {
    const html = statFilterCard({ value: 9, label: 'Total', filter: 'all', active: true, activeTitle: 'CURRENT' })
    expect(html).toContain('title="CURRENT"')
  })

  it('strips markup from the label before it goes into attributes', () => {
    const html = statFilterCard({ value: 1, label: '<b>x</b>', filter: 'k', active: false })
    expect(html).toContain('data-stat-label="x"')
  })
})

describe('ideas status matching (counts no longer depend on the filter)', () => {
  it('"" = everything, "active" = new + reviewed, else exact', () => {
    expect(ideaStatusMatches('', 'rejected')).toBe(true)
    expect(ideaStatusMatches('active', 'new')).toBe(true)
    expect(ideaStatusMatches('active', 'reviewed')).toBe(true)
    expect(ideaStatusMatches('active', 'kanban')).toBe(false)
    expect(ideaStatusMatches('kanban', 'kanban')).toBe(true)
    expect(ideaStatusMatches('kanban', 'new')).toBe(false)
  })

  it('the status is no longer sent to the server, so every count is known', () => {
    const load = extractFn('loadIdeasPage')
    expect(load).not.toContain("params.set('status'")
    expect(extractFn('renderIdeasStats')).toContain('_ideasAllStatuses')
  })
})

describe('per-page wiring', () => {
  it('approvals: box and dropdown go through one setter', () => {
    expect(APP).toContain('function _setApprovalsStatusFilter(')
    expect(APP).toMatch(/wireStatFilterCards\(document\.getElementById\('approvalsStats'\)/)
  })
  it('skills: box clicks the matching source filter button', () => {
    expect(APP).toContain('#skillsFilterBtns .skills-filter-btn[data-filter=')
  })
  it('memory: tier box opens the tier tab', () => {
    expect(APP).toMatch(/wireStatFilterCards\(memStats,/)
  })
  it('MCP: status filter narrows the grouped list', () => {
    expect(APP).toContain('for (const c of statusFiltered)')
  })
  it('style: pointer, hover, keyboard focus and active state', () => {
    expect(CSS).toContain('button.stat-card--filter')
    expect(CSS).toContain('button.stat-card--filter:focus-visible')
    expect(CSS).toContain('button.stat-card--filter.is-active')
  })
  it('every new text exists in both languages', () => {
    for (const k of ['title_on', 'title_off', 'title_current', 'none']) {
      expect(HU).toContain(`'statFilter.${k}'`)
      expect(EN).toContain(`'statFilter.${k}'`)
    }
  })
})
