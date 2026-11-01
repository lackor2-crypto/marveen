// #825: sent mark + deadline levels for the Workbench tree.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { initDatabase, getDb } from '../db.js'
import { createProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { markSentManually } from '../workbench-docsent.js'
import { ensureDocLangTables } from '../workbench-doclang.js'
import { dueLevel, daysUntil, itemMarks } from '../workbench-item-marks.js'

describe('deadline levels (#825)', () => {
  it('past is overdue, today is today, 1-7 days is soon, later is calm', () => {
    expect(dueLevel(-1)).toBe('overdue')
    expect(dueLevel(0)).toBe('today')
    expect(dueLevel(1)).toBe('soon')
    expect(dueLevel(7)).toBe('soon')
    expect(dueLevel(8)).toBe('later')
  })
  it('counts whole local calendar days and rejects a bad date', () => {
    const now = new Date(2026, 10, 1, 23, 59)
    expect(daysUntil('2026-11-01', now)).toBe(0)
    expect(daysUntil('2026-11-04', now)).toBe(3)
    expect(daysUntil('2026-10-30', now)).toBe(-2)
    expect(daysUntil('nope', now)).toBeNull()
  })
})

describe('tree draws the marks (#825, source contract)', () => {
  const js = readFileSync('web/workbench.js', 'utf8')
  it('a work item leaves the tree only when finalized AND sent', () => {
    expect(js).toContain('function itHidden(it) { return hideOn && !!markOf(it.id).finished }')
  })
  it('every row has the circle, the item head has the banner, the trigger row says answered', () => {
    expect(js).toContain('sentMarkHtml(it) + workSeqHtml(it)')
    expect(js).toContain('+ sentBannerHtml(it)')
    expect(js).toContain('workbench.sent.trigger_answered')
  })
  it('both languages carry the keys', () => {
    for (const f of ['web/lang/hu.js', 'web/lang/en.js']) {
      const s = readFileSync(f, 'utf8')
      for (const k of ['sent.yes', 'sent.no', 'sent.banner', 'sent.trigger_answered', 'due.overdue', 'due.today', 'due.in']) expect(s).toContain('"workbench.' + k + '"')
    }
  })
})

describe('one work in several languages counts as one (#794, owner TG 4216/4219)', () => {
  function setup() {
    initDatabase(':memory:')
    const p: any = createProject({ name: 'Lang group' })
    const mk = (title: string, status: string) => {
      const w: any = createWorkItem({ project_id: p.project.id, title, type: 'note', status } as any)
      if (!w.ok) throw new Error(w.code)
      return w.item.id as string
    }
    const hu = mk('Antrag HU', 'done')
    const de = mk('Antrag DE', 'done')
    const other = mk('Other', 'done')
    ensureDocLangTables()
    getDb().prepare('INSERT INTO wb_doc_variants (work_item_id, source_item_id, lang, created_at, created_by) VALUES (?, ?, ?, 0, NULL)').run(de, hu, 'de')
    return { pid: p.project.id as string, hu, de, other }
  }
  it('sending the German version marks the Hungarian original sent and finished too, an unrelated item stays', () => {
    const { pid, hu, de, other } = setup()
    markSentManually(de, null)
    const m = itemMarks(pid)
    expect(m[de].sent).toBe(true)
    expect(m[hu].sent).toBe(true)
    expect(m[hu].finished).toBe(true)
    expect(m[other].sent).toBe(false)
    expect(m[other].finished).toBe(false)
  })
  it('the group is finished when ONE language version is done; the sibling status is not changed', () => {
    const { pid, hu, de } = setup()
    getDb().prepare('UPDATE work_items SET status = ? WHERE id = ?').run('in_progress', hu)
    markSentManually(de, null)
    const m = itemMarks(pid)
    expect(m[hu].finished).toBe(true)
  })
  it('nothing sent: nothing finished', () => {
    const { pid, hu, de } = setup()
    const m = itemMarks(pid)
    expect(m[hu].finished).toBe(false)
    expect(m[de].finished).toBe(false)
  })
})
