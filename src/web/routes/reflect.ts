import { saveAgentMemory, getAgentMemories, appendDailyLog } from '../../db.js'
import { MAIN_AGENT_ID } from '../../config.js'
import { logger } from '../../logger.js'
import { getSecret } from '../vault.js'
import { sanitizeAgentName } from '../sanitize.js'
import { readBody, json } from '../http-helpers.js'
import { runDeterministicReflection, runModelReflection, type ReflectDeps, type ReflectInput } from '../reflect.js'
import type { RouteContext } from './types.js'

// POST /api/reflect -- called by the PreCompact command hook right after it
// writes its task-state checkpoint. The deterministic half runs inline (it is
// pure SQLite writes) and the answer goes back immediately; the model-backed
// half is fire-and-forget, because the hook is holding up a compaction and must
// never wait on a provider.
export async function tryHandleReflect(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx
  if (path !== '/api/reflect' || method !== 'POST') return false

  let data: ReflectInput
  try {
    data = JSON.parse((await readBody(req)).toString()) as ReflectInput
  } catch {
    json(res, { error: 'Invalid JSON' }, 400)
    return true
  }

  const agent = sanitizeAgentName(String(data.agent || '')) || MAIN_AGENT_ID
  const input: ReflectInput = {
    agent,
    trigger: String(data.trigger || '').slice(0, 40),
    instructions: Array.isArray(data.instructions) ? data.instructions.map(String).slice(0, 20) : [],
    filesChanged: Array.isArray(data.filesChanged) ? data.filesChanged.map(String).slice(0, 50) : [],
    decisions: Array.isArray(data.decisions) ? data.decisions.map(String).slice(0, 20) : [],
    objective: String(data.objective || '').slice(0, 600),
    nextAction: String(data.nextAction || '').slice(0, 600),
  }

  const deps: ReflectDeps = {
    saveMemory: (a, content, category, keywords) => { saveAgentMemory(a, content, category, keywords, true) },
    appendLog: (a, content) => appendDailyLog(a, content),
    recentMemories: (a, limit) => getAgentMemories(a, limit),
    apiKey: getSecret('openrouter-fleet-key') || undefined,
  }

  const result = runDeterministicReflection(input, deps)
  json(res, { ok: true, ...result })

  void runModelReflection(input, deps).catch((err) => {
    logger.warn({ err, agent }, 'reflect: background reflection failed')
  })
  return true
}
