// AI image edit endpoint (K-2.11, K-2.12, K-1.33, K-X.1): the call goes into the
// "what went out where" log with its cost, a failed call is logged as failed,
// and the work item's AI cost adds up. The Gemini call itself is faked.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const edit = vi.fn()
vi.mock('../workbench-image-ai.js', async (orig) => {
  const real = await orig<typeof import('../workbench-image-ai.js')>()
  return {
    ...real,
    imageAiConfig: () => ({ key: 'k', model: 'gemini-test' }),
    editImageWithAI: (...a: unknown[]) => edit(...a),
  }
})

import { initDatabase } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { commitCanvasChange } from '../workbench-canvas-store.js'
import { emptyCanvas } from '../workbench-graphic.js'
import { itemAiCost, egressLog, setItemSensitive } from '../workbench-privacy.js'
import { callWorkbench } from './helpers/workbench-route-call.js'

let depot = ''
let itemId = ''

beforeEach(() => {
  initDatabase(':memory:')
  depot = mkdtempSync(join(tmpdir(), 'marveen-aiedit-'))
  mkdirSync(join(depot, 'Projektek', 'Iroda'), { recursive: true })
  process.env['MARVEEN_DEPOT'] = depot
  writeFileSync(join(depot, 'Projektek', 'Iroda', 'auto.png'), Buffer.from('89504e470d0a1a0a', 'hex'))
  const p = createProject({ name: 'Iroda' })
  if (!p.ok) throw new Error('project')
  updateProject(p.project.id, { folder_path: 'Projektek/Iroda' })
  const w = createWorkItem({ project_id: p.project.id, title: 'Poszt', type: 'graphic' })
  if (!w.ok) throw new Error('item')
  itemId = w.item.id
  const doc = {
    ...emptyCanvas(1000, 1000),
    objects: [{ id: 'img', type: 'image' as const, x: 0, y: 0, width: 500, height: 500, opacity: 1, src: 'auto.png', fit: 'contain' as const, alt: '' }],
  }
  const c = commitCanvasChange(w.item, doc, { source: 'owner', label: 'replace', actor: null })
  if (!c.ok) throw new Error('canvas ' + c.code)
  edit.mockReset()
})

afterEach(() => {
  rmSync(depot, { recursive: true, force: true })
  delete process.env['MARVEEN_DEPOT']
})

const post = () => callWorkbench(`/api/workbench/items/${itemId}/canvas/ai-edit`, 'POST', { object_id: 'img', instruction: 'legyen piros', confirm_cost: true })

describe('AI image edit endpoint: log and cost', () => {
  it('a successful call is logged with the picture, the model and the cost, and the cost adds up', async () => {
    edit.mockResolvedValue({ ok: true, bytes: Buffer.from('new'), mime: 'image/png', model: 'gemini-test', cost_usd: 0.07, note: null })
    const r = await post()
    expect(r.status).toBe(200)
    expect(itemAiCost(itemId)).toEqual({ usd: 0.07, calls: 1, unknown: 0 })
    const row = egressLog(itemId).find((x) => x.service === 'image_ai')
    expect(row).toMatchObject({ model: 'gemini-test', cost_usd: 0.07, status: 'sent' })
    expect(row!.file).toContain('auto.png')
    const priv = await callWorkbench(`/api/workbench/items/${itemId}/privacy`, 'GET')
    expect(priv.body.ai_cost).toEqual({ usd: 0.07, calls: 1, unknown: 0 })
  })

  it('a failed call is logged as failed and costs nothing', async () => {
    edit.mockResolvedValue({ ok: false, code: 'ai_edit_failed', detail: 'boom' })
    const r = await post()
    expect(r.status).toBe(502)
    expect(itemAiCost(itemId)).toEqual({ usd: 0, calls: 0, unknown: 0 })
    expect(egressLog(itemId).find((x) => x.service === 'image_ai')).toMatchObject({ status: 'failed' })
  })

  it('a sensitive work item never calls the service and logs nothing', async () => {
    setItemSensitive(itemId, true, 'teszt')
    const r = await post()
    expect(r.status).toBe(403)
    expect(edit).not.toHaveBeenCalled()
    expect(egressLog(itemId).filter((x) => x.service === 'image_ai')).toEqual([])
  })
})
