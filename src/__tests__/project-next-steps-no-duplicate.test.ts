// A work item shows in ONE place on the project overview: items listed in
// Current work are not repeated in Next steps (Boss, TG 5893, card #900).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const app = readFileSync(join(__dirname, '..', '..', 'web', 'app.js'), 'utf8')
const start = app.indexOf('function _prjNextHtml')
const body = app.slice(start, app.indexOf('function _prjActivityLine', start))

describe('project overview next steps', () => {
  it('filters out the work items that Current work already lists', () => {
    expect(body).toContain('ov.currentWorkItems')
    expect(body).toMatch(/filter\(\(w\) => !currentIds\.has\(w\.id\)\)/)
  })
  it('says so when everything open is in Current work', () => {
    expect(body).toContain("'projects.next.all_current'")
  })
})
