// Kanban #821 (owner, TG 3885): the assistant conversation belongs to the CASE (the folder), not to one work item.
// Reported: the Hungarian letter had a chat with history; clicking another work item of the same folder showed an
// empty chat. These tests fail without the case key / the union read.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { getDb, initDatabase } from '../db.js'
import { createProject } from '../projects.js'
import { createWorkItem, listWorkItems } from '../workbench.js'
import { PROJECT_ROOT_PLACE } from '../workbench-assets.js'
import { variantOf } from '../workbench-doclang.js'
import { CHAT_CASE_PROJECT_ROOT, chatCaseFamilies, chatCaseKey, chatCaseKeys } from '../workbench-chat-case.js'
import { addAgentMessage, listAgentMessages, listCaseMessages, openSessionForWorkItem } from '../workbench-agent/sessions.js'
import { resetRunningForTest, runTurn, turnKey } from '../workbench-agent/orchestrator.js'
import { liveItemSwitched } from '../web/routes/workbench-agent.js'
import { resetUsageManagerForTest, setUsageSnapshotReader } from '../workbench-agent/usage-manager.js'
import { setAuditWriterForTest } from '../workbench-agent/audit.js'
import type { AICallRequest, AIChunk, AIProvider } from '../workbench-agent/provider.js'

const JS = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')

describe('chat case keys, pure (#821)', () => {
  const row = (id: string, place: string | null, created: number, own: string | null = null) =>
    ({ id, project_id: 'p', folder: own, container_folder: place, created_at: created, deleted_at: null as number | null })
  it('the items of one folder share the key of the oldest one; other folders and the project root do not', () => {
    const keys = chatCaseKeys([
      row('b', 'Work/Case', 20), row('a', 'Work/Case', 10), row('own', null, 5, 'Work/Case'),
      row('sub', 'Work/Case/Inner', 1), row('root1', PROJECT_ROOT_PLACE, 1), row('root2', null, 2),
    ], new Map())
    expect(keys.get('a')).toBe('own')
    expect(keys.get('b')).toBe('own')
    expect(keys.get('own')).toBe('own')
    expect(keys.get('sub')).toBe('sub')
    expect(keys.get('root1')).toBe('root1')
    expect(keys.get('root2')).toBe('root2')
  })
  it('a language version follows its original, and never names the case itself', () => {
    const keys = chatCaseKeys([row('de', 'Work/Case', 1), row('hu', 'Work/Case', 50), row('other', 'Work/Case', 60)], new Map([['de', 'hu']]))
    expect(keys.get('de')).toBe('hu')
    expect(keys.get('other')).toBe('hu')
    // a version whose original sits in no folder stays with the original
    expect(chatCaseKeys([row('v', 'Work/X', 1), row('o', null, 2)], new Map([['v', 'o']])).get('v')).toBe('o')
  })
  it('a trashed item is not part of the case', () => {
    const keys = chatCaseKeys([{ ...row('old', 'F', 1), deleted_at: 5 }, row('a', 'F', 10), row('b', 'F', 20)], new Map())
    expect(keys.has('old')).toBe(false)
    expect(keys.get('b')).toBe('a')
  })
  it('uses the same project-root marker as the folder code', () => {
    expect(CHAT_CASE_PROJECT_ROOT).toBe(PROJECT_ROOT_PLACE)
  })
})

describe('one assistant chat per case, on the database (#821)', () => {
  let projectId = ''
  const mk = (title: string, container?: string): string => {
    const w = createWorkItem({ project_id: projectId, title, type: 'document', ...(container ? { container_folder: container } : {}) })
    if (!w.ok) throw new Error('work item: ' + title)
    return w.item.id
  }
  beforeEach(() => {
    initDatabase(':memory:')
    resetRunningForTest()
    resetUsageManagerForTest()
    setUsageSnapshotReader(() => ({ fiveHour: { usedPct: 10, resetsAt: null }, measuredAt: Date.now(), updatedAt: Date.now() }))
    setAuditWriterForTest(() => {})
    const p = createProject({ name: 'Case chat' })
    if (!p.ok) throw new Error('project')
    projectId = p.project.id
  })

  it('two work items of one folder show the same history, in time order; another folder does not', () => {
    const a = mk('Letter', 'Munkadarabok/Case')
    const b = mk('Annex', 'Munkadarabok/Case')
    const c = mk('Elsewhere', 'Munkadarabok/Other')
    const sa = openSessionForWorkItem(projectId, a, 'hu')
    const sb = openSessionForWorkItem(projectId, b, 'hu')
    const sc = openSessionForWorkItem(projectId, c, 'hu')
    const db = getDb()
    const say = (sid: string, text: string, at: number) => {
      const m = addAgentMessage(sid, 'user', text)
      db.prepare('UPDATE workbench_agent_messages SET created_at = ? WHERE id = ?').run(at, m.id)
    }
    say(sa.id, 'first, at the letter', 100)
    say(sb.id, 'second, at the annex', 200)
    say(sa.id, 'third, at the letter again', 300)
    say(sc.id, 'in another case', 150)
    const expected = ['first, at the letter', 'second, at the annex', 'third, at the letter again']
    expect(listCaseMessages(sa.id).map((m) => m.content)).toEqual(expected)
    expect(listCaseMessages(sb.id).map((m) => m.content)).toEqual(expected)
    expect(listCaseMessages(sc.id).map((m) => m.content)).toEqual(['in another case'])
    // the newest `limit` of the whole case, not of one session
    expect(listCaseMessages(sb.id, 2).map((m) => m.content)).toEqual(expected.slice(1))
    // nothing was moved: each session still holds its own rows (the mail draft reads these)
    expect(listAgentMessages(sb.id).map((m) => m.content)).toEqual(['second, at the annex'])
    expect(chatCaseKey(a)).toBe(chatCaseKey(b))
    expect(chatCaseKey(c)).not.toBe(chatCaseKey(a))
    expect(turnKey(projectId, a)).toBe(turnKey(projectId, b))
    expect(turnKey(projectId, c)).not.toBe(turnKey(projectId, a))
    expect(new Set(chatCaseFamilies(b))).toEqual(new Set([a, b]))
  })

  it('a language version in the folder joins the same case', () => {
    const hu = mk('Level', 'Munkadarabok/Ugy')
    const de = mk('DE Level', 'Munkadarabok/Ugy')
    const other = mk('Masik level', 'Munkadarabok/Ugy')
    variantOf(de) // makes the table
    getDb().prepare('INSERT INTO wb_doc_variants (work_item_id, source_item_id, lang, created_at, created_by) VALUES (?, ?, ?, ?, NULL)').run(de, hu, 'de', 1)
    expect(chatCaseKey(de)).toBe(chatCaseKey(other))
    expect(turnKey(projectId, de)).toBe(turnKey(projectId, other))
    expect(new Set(chatCaseFamilies(de))).toEqual(new Set([hu, other]))
  })

  it('the listed items carry chat_key, the same for one folder', () => {
    const a = mk('A', 'Munkadarabok/Case')
    const b = mk('B', 'Munkadarabok/Case')
    const rows = listWorkItems(projectId)
    const ka = rows.find((r) => r.id === a)?.chat_key
    expect(ka).toBeTruthy()
    expect(rows.find((r) => r.id === b)?.chat_key).toBe(ka)
    expect(ka).toBe(chatCaseKey(a))
  })

  it('the model answering at one work item is given what was said at the other', async () => {
    const a = mk('Letter', 'Munkadarabok/Case')
    const b = mk('Annex', 'Munkadarabok/Case')
    addAgentMessage(openSessionForWorkItem(projectId, a, 'hu').id, 'user', 'A cimzett a Sozialamt Chemnitz.')
    const seen: AICallRequest[] = []
    const provider: AIProvider = {
      id: 't', model: () => 'm', availability: () => ({ available: true }),
      async *stream(req: AICallRequest): AsyncIterable<AIChunk> { seen.push(req); yield { kind: 'text', text: 'Rendben.' }; yield { kind: 'done', model: 'm' } },
    }
    for await (const _ of runTurn({ projectId, workItemId: b, message: 'Kinek megy a level?', lang: 'hu', actor: 't' }, provider)) { /* drain */ }
    expect(seen.length).toBeGreaterThan(0)
    expect(JSON.stringify(seen[0])).toContain('Sozialamt Chemnitz')
  })
})

describe('the shared live session is told when the owner moves to another work item (#821)', () => {
  it('true on the first turn and on a switch, false while the item stays', () => {
    const key = 'item:case-' + Math.random()
    expect(liveItemSwitched(key, 'a')).toBe(true)
    expect(liveItemSwitched(key, 'a')).toBe(false)
    expect(liveItemSwitched(key, 'b')).toBe(true)
    expect(liveItemSwitched(key, 'b')).toBe(false)
    expect(liveItemSwitched(key, null)).toBe(true)
  })
  it('the route asks it on every turn, also when the session is fresh', () => {
    const src = readFileSync(join(__dirname, '..', 'web', 'routes', 'workbench-agent.ts'), 'utf8')
    expect(src).toContain('[fresh, liveItemSwitched(key, item ? item.id : null)].some(Boolean)')
  })
})

describe('the page keys the chat by the case (#821)', () => {
  it('chatKey() prefers the chat_key of the listed item', () => {
    const i = JS.indexOf('function chatKey()')
    expect(JS.slice(i, i + 400)).toContain('chatKeyOfItem(WB.selectedId)')
    expect(JS).toContain("WB.items[i].chat_key || ''")
  })
})
