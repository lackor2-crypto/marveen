// #813: the Overview self-check shows the urgent work under the projects, as ONE box
// (the card keeps its four-box law). The row builder is pure, so it is run for real here.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'

const app = readFileSync(join(PROJECT_ROOT, 'web', 'app.js'), 'utf8')
const hu = readFileSync(join(PROJECT_ROOT, 'web', 'lang', 'hu.js'), 'utf8')
const en = readFileSync(join(PROJECT_ROOT, 'web', 'lang', 'en.js'), 'utf8')

const src = /function selfCheckUrgentRow\(projects\)[\s\S]*?\n}\n/.exec(app)?.[0] ?? ''
const boxes = /function selfCheckBoxes\(rows, max\)[\s\S]*?\n}\n/.exec(app)?.[0] ?? ''
const t = (k: string, p: Record<string, unknown> = {}) => `${k}|${Object.entries(p).map(([a, b]) => `${a}=${b}`).join(',')}`
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const build = new Function('t', `${src}\nreturn selfCheckUrgentRow`)(t) as (p: unknown) => { label: string; desc: string; onclick: string } | null
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const cap = new Function(`${boxes}\nreturn selfCheckBoxes`)() as (r: unknown[], m: number) => { shown: unknown[]; extra: unknown[] }

describe('self-check urgent work per project (#813)', () => {
  it('exists in the page and is wired into both the problem and the all-green paint', () => {
    expect(src).not.toBe('')
    const renderer = /async function renderOverviewConnections\(\)[\s\S]*?\n}\n/.exec(app)?.[0] ?? ''
    expect(renderer).toContain("fetch('/api/projects')")
    expect(renderer).toContain('rows.unshift(urgentRow)')
    expect(renderer).toContain('greenRows.unshift(urgentRow)')
  })

  it('has no row when no project has urgent work, and ignores archived ones', () => {
    expect(build([])).toBeNull()
    expect(build(undefined)).toBeNull()
    expect(build([{ id: 'a', name: 'A', urgent_todos: 0 }, { id: 'b', name: 'B', urgent_todos: 3, archived_at: 5 }])).toBeNull()
  })

  it('names every project with its count and nearest deadline, soonest first, totals in the label', () => {
    const r = build([
      { id: 'a', name: 'Later', urgent_todos: 1, urgent_next_due: '2026-12-05' },
      { id: 'b', name: 'Sooner', urgent_todos: 2, urgent_next_due: '2026-11-20' },
    ])!
    expect(r.label).toBe('conn.ov_urgent|n=3,p=2')
    expect(r.desc.indexOf('name=Sooner')).toBeLessThan(r.desc.indexOf('name=Later'))
    expect(r.desc).toContain('n=2,due=2026-11-20')
    expect(r.onclick).toBe("switchPage('projects')")
  })

  it('opens the project itself when only one project is urgent', () => {
    const r = build([{ id: 'p1', name: 'Solo', urgent_todos: 1, urgent_next_due: '2026-11-20' }])!
    expect(r.onclick).toContain("_prjOpenProject(&quot;p1&quot;)")
  })

  it('stays inside the four-box law even with the extra row', () => {
    const rows = [1, 2, 3, 4, 5].map((n) => ({ label: 'r' + n }))
    const { shown, extra } = cap(rows, 4)
    expect(shown.length + (extra.length ? 1 : 0)).toBeLessThanOrEqual(4)
  })

  it('has both language keys', () => {
    for (const k of ['conn.ov_urgent', 'conn.ov_urgent_project']) {
      expect(hu).toContain(`'${k}'`)
      expect(en).toContain(`'${k}'`)
    }
  })
})
