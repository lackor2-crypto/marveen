// #419 -- heartbeat metrics + calendar check, rebuilt from upstream
// 2c9d22ea / ee73d6bf / e02b5977 / 34d5f57b / de60db9e / e45e4d87 onto our
// code: the server-side numbers, the summary endpoint, the pre-rendered block
// the scheduler injects, the route wiring, and the Schedules-page switch.
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  initDatabase, getDb, countPlannedKanbanCards, countNewHotMemories, getDbFileSizeMb,
  classifyTokenPruneLag, getTokenPruneLag,
} from '../db.js'
import { buildHeartbeatSummaryResponse, HEARTBEAT_SUMMARY_WAITING_CAP, HEARTBEAT_SUMMARY_TITLE_MAX } from '../web/routes/kanban.js'
import { renderHeartbeatMetricsBlock, HB_METRICS_BLOCK_MARKER } from '../web/heartbeat-metrics-inject.js'
import { HEARTBEAT_CALENDAR_NOT_CONFIGURED } from '../web/routes/heartbeat.js'

const ROOT = join(__dirname, '..', '..')
const src = (p: string) => readFileSync(join(ROOT, p), 'utf-8')

const card = (o: Record<string, unknown>) => ({ id: 'c', title: 't', status: 'waiting', priority: 'normal', ...o }) as any

describe('server-side numbers (db.ts)', () => {
  beforeEach(() => initDatabase(':memory:'))

  it('planned count and new hot memories are measured, not assumed', () => {
    const db = getDb()
    const now = Math.floor(Date.now() / 1000)
    db.prepare("INSERT INTO kanban_cards (id,title,status,priority,sort_order,created_at,updated_at) VALUES ('a','x','planned','normal',0,?,?)").run(now, now)
    db.prepare("INSERT INTO kanban_cards (id,title,status,priority,sort_order,created_at,updated_at,archived_at) VALUES ('b','x','planned','normal',0,?,?,?)").run(now, now, now)
    expect(countPlannedKanbanCards()).toBe(1)
    const ins = db.prepare("INSERT INTO memories (chat_id,sector,agent_id,content,category,created_at,accessed_at) VALUES ('c','semantic',?,?,?,?,0)")
    ins.run('main', 'fresh', 'hot', now - 60)
    ins.run('main', 'old', 'hot', now - 7200)
    ins.run('main', 'warm', 'warm', now - 60)
    ins.run('other', 'fresh', 'hot', now - 60)
    expect(countNewHotMemories('main')).toBe(1)
  })

  it('DB size is null on :memory: -- never a fake 0', () => {
    expect(getDbFileSizeMb()).toBeNull()
  })

  it('token prune: empty on a fresh table, ok within two sweeps, stale beyond', () => {
    expect(getTokenPruneLag().state).toBe('empty')
    const now = 1_000_000_000
    expect(classifyTokenPruneLag(null, 30, now, 48).state).toBe('empty')
    expect(classifyTokenPruneLag(now - 30 * 86400 - 3600, 30, now, 48)).toMatchObject({ state: 'ok', lag_hours: 1 })
    expect(classifyTokenPruneLag(now - 30 * 86400 - 49 * 3600, 30, now, 48).state).toBe('stale')
    expect(classifyTokenPruneLag(now - 86400, 30, now, 48).state).toBe('ok')
  })
})

describe('GET /api/kanban/heartbeat-summary payload', () => {
  it('counts come first, carry full totals; the waiting list is capped, titles cut', () => {
    const waiting = Array.from({ length: 20 }, (_, i) => card({ id: `w${i}`, updated_at: i }))
    const body = buildHeartbeatSummaryResponse(
      { urgent: [card({ id: 'u', title: 'x'.repeat(500), priority: 'urgent' })], in_progress: [card({})], waiting },
      2, 7, 12.5, { state: 'ok', retention_days: 30, tolerance_hours: 48, lag_hours: 1, oldest_age_days: 30 },
    )
    expect(Object.keys(body)[0]).toBe('counts')
    expect(body.counts).toEqual({ urgent: 1, in_progress: 1, waiting: 20, planned: 7, new_hot_memories_1h: 2, db_size_mb: 12.5 })
    expect(body.waiting).toHaveLength(HEARTBEAT_SUMMARY_WAITING_CAP)
    expect(body.waiting[0].id).toBe('w19')
    expect(body.waiting_shown).toBe(HEARTBEAT_SUMMARY_WAITING_CAP)
    expect(body.urgent[0].title.length).toBe(HEARTBEAT_SUMMARY_TITLE_MAX + 1)
  })
})

describe('the injected block (renderer)', () => {
  const ok = [
    'HB_METRICS_V1 ts=2026-09-27 12:00',
    'COUNTS urgent=1 in_progress=2 waiting=30 planned=4 new_hot_memories_1h=0 db_size_mb=120.5 waiting_shown=8',
    'URGENT abc Fix it',
    'TOKEN_PRUNE state=ok retention_days=30 lag_hours=3 tolerance_hours=48',
    'CALENDAR_EVENTS n=0 window=2h',
    'SCHEDULES enabled=5',
    'TASK_RUNS_1H total=3 ok=3',
  ].join('\n')

  it('renders the measured numbers; n=0 is a measured free calendar', () => {
    const b = renderHeartbeatMetricsBlock(ok)
    expect(b.startsWith(HB_METRICS_BLOCK_MARKER)).toBe(true)
    expect(b).toContain('- urgent: 1 (abc)')
    expect(b).toContain('- waiting: 30')
    expect(b).toContain('- DB size: 120.5 MB')
    expect(b).toContain('- no upcoming events')
    expect(b).toContain('- enabled schedules: 5')
    expect(b).not.toMatch(/^- muszer-hiba:/m)
  })

  it('an unset calendar is a setting, not a failure', () => {
    const raw = ok.replace('CALENDAR_EVENTS n=0 window=2h', `ERROR calendar: ${HEARTBEAT_CALENDAR_NOT_CONFIGURED}`)
    const b = renderHeartbeatMetricsBlock(raw)
    expect(b).toContain('calendar not set up')
    expect(b).not.toContain('calendar fetch failed')
  })

  it('a real calendar failure is relayed verbatim', () => {
    const raw = ok.replace('CALENDAR_EVENTS n=0 window=2h', 'ERROR calendar: Token refresh failed: 400')
    expect(renderHeartbeatMetricsBlock(raw)).toContain('- calendar fetch failed: Token refresh failed: 400')
  })

  it('fail-closed: no sentinel / no run -> muszer-hiba in every section, never a 0', () => {
    for (const b of [renderHeartbeatMetricsBlock('garbage'), renderHeartbeatMetricsBlock(null, 'spawn ENOENT')]) {
      expect(b.match(/^- muszer-hiba:/gm)?.length).toBe(4)
      expect(b).not.toMatch(/urgent: 0|DB size: 0/)
    }
  })

  it('a missing summary section says so instead of printing numbers', () => {
    const raw = ['HB_METRICS_V1 ts=x', "ERROR summary: HTTPError('401')", 'CALENDAR_EVENTS n=0 window=2h'].join('\n')
    const b = renderHeartbeatMetricsBlock(raw)
    expect(b).toContain("muszer-hiba: ERROR summary: HTTPError('401')")
  })
})

describe('wiring', () => {
  it('web.ts serves the calendar route; kanban serves the summary', () => {
    expect(src('src/web.ts')).toMatch(/if \(await tryHandleHeartbeat\(routeCtx\)\) return/)
    expect(src('src/web/routes/kanban.ts')).toMatch(/path === '\/api\/kanban\/heartbeat-summary'/)
  })
  it('the scheduler injects the block only for heartbeat tasks that opted in', () => {
    const r = src('src/web/schedule-runner.ts')
    expect(r).toMatch(/task\.type === 'heartbeat' && task\.injectMetrics\s*\?\s*await collectHeartbeatMetricsBlock\(\)/)
    expect(r).toMatch(/\[Feladat\]\\n\$\{promptWithMetrics\}/)
  })
  it('the instrument talks to this dashboard, no hard-coded owner or port', () => {
    const m = src('src/web/heartbeat-metrics-inject.ts')
    expect(m).toMatch(/http:\/\/localhost:\$\{WEB_PORT\}/)
    expect(m).not.toMatch(/lackor|Szotasz|3420/)
  })
  it('the create route keeps the switch; a non-boolean is refused on update', () => {
    const s = src('src/web/routes/schedules.ts')
    expect(s).toMatch(/injectMetrics: data\.injectMetrics === true/)
    expect(s).toMatch(/injectMetrics must be true or false/)
  })
  it('the Schedules page has the switch, HU+EN, and the templates tick it', () => {
    const html = src('web/index.html')
    expect(html).toContain('id="scheduleInjectMetrics"')
    expect(html).toContain('id="heartbeatMetricsGroup"')
    for (const f of ['web/lang/hu.js', 'web/lang/en.js']) {
      expect(src(f)).toContain("'tasks.modal.inject_metrics'")
      expect(src(f)).toContain("'tasks.modal.inject_metrics_hint'")
    }
    const app = src('web/app.js')
    expect(app).toMatch(/scheduleInjectMetrics'\)\.checked = !!task\.injectMetrics/)
    expect(app).toMatch(/if \(tpl\.metrics\)/)
  })
})
