import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createCardWithRules, kanbanFieldRefusal } from '../kanban-create.js'

describe('#958 an unknown kanban priority/status is a clear 400, not a bare "Szerver hiba"', () => {
  it('names the accepted priorities in Hungarian and English', () => {
    const m = kanbanFieldRefusal({ priority: 'medium' }) as string
    expect(m).toContain('Ismeretlen prioritás: medium')
    expect(m).toContain('low, normal, high, urgent')
    expect(m).toContain('Unknown priority')
  })
  it('names the accepted statuses', () => {
    expect(kanbanFieldRefusal({ status: 'blocked' })).toContain('planned, in_progress, testing, waiting, done')
  })
  it('accepts every valid value and an absent field', () => {
    for (const p of ['low', 'normal', 'high', 'urgent']) expect(kanbanFieldRefusal({ priority: p })).toBeNull()
    expect(kanbanFieldRefusal({})).toBeNull()
    expect(kanbanFieldRefusal({ status: 'waiting' })).toBeNull()
  })
  it('the shared create gate (also used by the Workbench agent) refuses before touching the DB', () => {
    const out = createCardWithRules({ title: 'x', priority: 'medium' } as never)
    expect(out.ok).toBe(false)
    if (!out.ok) { expect(out.code).toBe('invalid_field'); expect(out.error).toContain('medium') }
  })
  it('PUT /api/kanban/:id runs the same check', () => {
    const src = readFileSync(join(__dirname, '..', 'web', 'routes', 'kanban.ts'), 'utf8')
    expect(src).toMatch(/kanbanFieldRefusal\(data\)/)
  })
})
