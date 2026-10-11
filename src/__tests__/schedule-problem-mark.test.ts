// Card #546: the faulty-schedule mark and the Overview self-check come from ONE source.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { scheduleProblems } from '../web/command-task-problems.js'
import { commandTaskRows } from '../web/system-health.js'

const HEALTH = {
  'backup-nightly': { lastStatus: 'fail', fails: 3, lastRun: 1760000000000 },
  'ping': { lastStatus: 'ok', fails: 0, lastRun: 1760000100000 },
  'sync-b': { lastStatus: 'fail' },
  'never': { lastStatus: 'unknown' },
}

describe('schedule problems (#546)', () => {
  it('only a last run that failed is a problem; fails/lastRun are carried, missing numbers get safe values', () => {
    const m = scheduleProblems(HEALTH)
    expect([...m.keys()].sort()).toEqual(['backup-nightly', 'sync-b'])
    expect(m.get('backup-nightly')).toEqual({ code: 'command_fail', fails: 3, lastRun: 1760000000000 })
    expect(m.get('sync-b')).toEqual({ code: 'command_fail', fails: 1, lastRun: 0 })
  })

  it('an unreadable health file means nothing is known: no problems, no crash', () => {
    expect(scheduleProblems(null).size).toBe(0)
  })

  it('the self-check row counts exactly the schedules that are marked, and names the first one raw for the jump', () => {
    const rows = commandTaskRows(HEALTH)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe('command_task_fail')
    expect(rows[0]!.params).toMatchObject({ n: scheduleProblems(HEALTH).size, first: 'backup-nightly' })
    expect(commandTaskRows({ a: { lastStatus: 'ok' } })).toEqual([])
  })
})

describe('schedule problem UI wiring (#546)', () => {
  const app = readFileSync(join(__dirname, '..', '..', 'web', 'app.js'), 'utf8')
  const hu = readFileSync(join(__dirname, '..', '..', 'web', 'lang', 'hu.js'), 'utf8')
  const en = readFileSync(join(__dirname, '..', '..', 'web', 'lang', 'en.js'), 'utf8')
  const route = readFileSync(join(__dirname, '..', 'web', 'routes', 'schedules.ts'), 'utf8')

  it('the list API attaches the problem from the shared source', () => {
    expect(route).toContain('scheduleProblems()')
    expect(route).toMatch(/problem: problems\.get\(t\.name\)/)
  })

  it('the Overview row jumps straight to the faulty schedule; the list marks rows, counts and filters', () => {
    expect(app).toContain("h.id === 'command_task_fail' && h.params && h.params.first")
    expect(app).toContain('jumpToSchedule(')
    expect(app).toContain('scheduleProblemHtml(task)')
    expect(app).toContain("t('tasks.problem.bar'")
    expect(app).toContain("t('tasks.problem.only_bad')")
  })

  it('every sentence exists in Hungarian and English', () => {
    for (const k of ['command_fail', 'command_fail_nowhen', 'bar', 'only_bad', 'jump_not_found']) {
      expect(hu).toContain(`'tasks.problem.${k}'`)
      expect(en).toContain(`'tasks.problem.${k}'`)
    }
  })
})
