import { randomUUID } from 'node:crypto'
import { MAIN_AGENT_ID, BOT_NAME } from '../../config.js'
import { listIdeas, createIdea, updateIdea, deleteIdea, listIdeaCategories, createKanbanCard, getDb, getIdeaComments, addIdeaComment, logIdeaStatusChange, getIdeaStatusLog } from '../../db.js'
import { generateBreakdown } from '../llm-breakdown.js'
import { logger } from '../../logger.js'
import { resolveCardLabels, applyCardLabels } from '../kanban-labels.js'
import { readBody, json, reqLang, L } from '../http-helpers.js'
import { checkCardProject, type ProjectCheck } from '../../kanban-create.js'
import { getEffectiveSettingValue } from '../../settings-store.js'
import type { RouteContext } from './types.js'
import { ideaProjectMap, knownProjectId } from '../../project-scope.js'
import { linkObject } from '../../projects.js'

type IdeaRow = import('../../db.js').IdeaBoxRow

function getIdea(id: string): IdeaRow | undefined {
  return getDb().prepare('SELECT * FROM idea_box WHERE id = ?').get(id) as IdeaRow | undefined
}

/**
 * A kanbanra kerulo otlet kartyajanak projektje -- ugyanazon a kapun at, mint
 * minden mas kartya (src/kanban-create.ts checkCardProject, #374). A felulet
 * valasztasa (`project` / `no_project_reason`) dont; ha nem kuldott, az otlet
 * sajat projektje. Kitalalt gyujtohely-nev nincs: projekt nelkul csak
 * kimondott indokkal, kulonben project_required.
 */
function ideaCardProject(ideaId: string, data: { project?: unknown; no_project_reason?: unknown }): ProjectCheck {
  const requested = data.project !== undefined && data.project !== null && String(data.project).trim() !== ''
  const ref = requested ? data.project : (data.no_project_reason ? null : ideaProjectMap().get(ideaId) ?? null)
  return checkCardProject(ref, data.no_project_reason)
}

function projectRequiredReply(lang: 'hu' | 'en', check: Extract<ProjectCheck, { ok: false }>) {
  return {
    error: L(lang,
      'Válassz projektet a kártyának: projekt nélküli kártya nem jöhet létre. A kártya NEM jött létre.',
      'Pick a project for the card: a card without a project cannot be created. The card was NOT created.'),
    code: 'project_required',
    projects: check.projects,
  }
}

const VALID_PRIORITIES = new Set(['low', 'normal', 'high', 'urgent'])

export async function tryHandleIdeas(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  // Configurable stale threshold -- ideas with status 'new' older than this many days
  // are flagged with stale:true in the list response. Read live through the settings
  // layer (config-overrides.json > .env > default) so a Settings-page change applies
  // without a restart.
  const IDEA_STALE_DAYS = Math.max(1, Number(getEffectiveSettingValue('IDEA_STALE_DAYS')) || 7)

  if (path === '/api/ideas' && method === 'GET') {
    const status = url.searchParams.get('status') || undefined
    const category = url.searchParams.get('category') || undefined
    // ?project=<id> -> csak a projekt otletei; ?project=none -> a projekt nelkuliek
    // (Iroda -> Projektek, src/project-scope.ts). Minden otlet megkapja a projektjet.
    const projectFilter = url.searchParams.get('project') || ''
    const byProject = ideaProjectMap()
    const ideas = listIdeas({ status, category })
      .map(i => ({ ...i, project: byProject.get(i.id) ?? null }))
      .filter(i => !projectFilter || (projectFilter === 'none' ? !i.project : i.project === projectFilter))
    const staleCutoff = Math.floor(Date.now() / 1000) - IDEA_STALE_DAYS * 86400
    json(res, ideas.map(i => ({ ...i, stale: i.status === 'new' && i.updated_at < staleCutoff })))
    return true
  }

  if (path === '/api/ideas/categories' && method === 'GET') {
    json(res, listIdeaCategories())
    return true
  }

  if (path === '/api/ideas' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as {
      title: string
      description?: string
      category?: string
      source?: string
      impact?: number | null
      effort?: number | null
      project?: string | null
    }
    if (!data.title) { json(res, { error: 'title required' }, 400); return true }
    // Same 1-5 validation as PUT -- previously POST silently dropped these fields
    let impact: number | null = null
    if (data.impact !== undefined && data.impact !== null) {
      const v = Math.round(Number(data.impact))
      if (!Number.isFinite(v) || v < 1 || v > 5) { json(res, { error: 'impact must be 1-5 or null' }, 400); return true }
      impact = v
    }
    let effort: number | null = null
    if (data.effort !== undefined && data.effort !== null) {
      const v = Math.round(Number(data.effort))
      if (!Number.isFinite(v) || v < 1 || v > 5) { json(res, { error: 'effort must be 1-5 or null' }, 400); return true }
      effort = v
    }
    // A projekt (id / rovid nev / pontos nev) -- egy projektre szurt Otletladabol
    // vagy a projekt oldalarol jon; ismeretlen ertek hibat ad, nem vesz el csendben.
    const project = data.project ? knownProjectId(data.project) : null
    if (data.project && !project) { json(res, { error: 'unknown project' }, 400); return true }
    const id = randomUUID().slice(0, 8)
    getDb().transaction(() => {
      createIdea({
        id,
        title: data.title,
        description: data.description ?? null,
        category: data.category ?? 'Egyéb',
        status: 'new',
        source: data.source ?? 'manual',
        kanban_id: null,
        impact,
        effort,
      })
      if (project) linkObject(project, 'idea', id, 'dashboard')
    })()
    json(res, { ok: true, id, project })
    return true
  }

  const ideaMatch = path.match(/^\/api\/ideas\/([^/]+)$/)

  if (ideaMatch && method === 'PUT') {
    const id = decodeURIComponent(ideaMatch[1])
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as {
      title?: string
      description?: string
      category?: string
      status?: IdeaRow['status']
      kanban_id?: string
      impact?: number | null
      effort?: number | null
    }
    // Coerce impact/effort to int or null -- reject values outside 1-5
    if (data.impact !== undefined && data.impact !== null) {
      const v = Math.round(Number(data.impact))
      if (!Number.isFinite(v) || v < 1 || v > 5) { json(res, { error: 'impact must be 1-5 or null' }, 400); return true }
      data.impact = v
    }
    if (data.effort !== undefined && data.effort !== null) {
      const v = Math.round(Number(data.effort))
      if (!Number.isFinite(v) || v < 1 || v > 5) { json(res, { error: 'effort must be 1-5 or null' }, 400); return true }
      data.effort = v
    }
    const current = getIdea(id)
    if (!current) { json(res, { error: 'Ötlet nem található' }, 404); return true }
    if (updateIdea(id, data)) {
      if (data.status && data.status !== current.status) {
        logIdeaStatusChange(id, current.status, data.status, MAIN_AGENT_ID)
      }
      json(res, { ok: true })
      return true
    }
    json(res, { error: 'Ötlet nem található' }, 404)
    return true
  }

  if (ideaMatch && method === 'DELETE') {
    const id = decodeURIComponent(ideaMatch[1])
    if (deleteIdea(id)) { json(res, { ok: true }); return true }
    json(res, { error: 'Ötlet nem található' }, 404)
    return true
  }

  // Idea comments
  const commentsMatch = path.match(/^\/api\/ideas\/([^/]+)\/comments$/)

  if (commentsMatch && method === 'GET') {
    const ideaId = decodeURIComponent(commentsMatch[1])
    json(res, { comments: getIdeaComments(ideaId) })
    return true
  }

  if (commentsMatch && method === 'POST') {
    const ideaId = decodeURIComponent(commentsMatch[1])
    const body = await readBody(req)
    const { author, content } = JSON.parse(body.toString()) as { author?: string; content?: string }
    if (!content || typeof content !== 'string' || !content.trim()) {
      json(res, { error: 'content required' }, 400); return true
    }
    const comment = addIdeaComment(ideaId, author?.trim() || MAIN_AGENT_ID, content.trim())
    json(res, { ok: true, comment })
    return true
  }

  // Promote idea to kanban card
  const promoteMatch = path.match(/^\/api\/ideas\/([^/]+)\/promote$/)
  if (promoteMatch && method === 'POST') {
    const ideaId = decodeURIComponent(promoteMatch[1])
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as { phase?: 'detail' | 'plan'; labels?: unknown; project?: unknown; no_project_reason?: unknown }
    const phase = data.phase ?? 'detail'

    const idea = (getDb().prepare('SELECT * FROM idea_box WHERE id = ?').get(ideaId) as import('../../db.js').IdeaBoxRow | undefined)
    if (!idea) { json(res, { error: 'Ötlet nem található' }, 404); return true }

    // An idea reaching the board becomes a card like any other, so it needs a
    // label like any other -- see src/web/kanban-labels.ts.
    const labels = resolveCardLabels(data.labels)
    if (!labels.ok) { json(res, { error: labels.error }, 400); return true }
    const projectCheck = ideaCardProject(ideaId, data)
    if (!projectCheck.ok) { json(res, projectRequiredReply(reqLang(req, url), projectCheck), 400); return true }
    const promoteDesc = projectCheck.noProjectReason
      ? `${idea.description ?? ''}${(idea.description ?? '').trim() ? '\n\n' : ''}Projekt nelkul, mert: ${projectCheck.noProjectReason}`
      : idea.description ?? ''

    const cardId = randomUUID().slice(0, 8)
    const status = phase === 'plan' ? 'planned' : 'waiting'
    const title = phase === 'plan' ? idea.title : `[Részlet kidolgozás] ${idea.title}`
    createKanbanCard({
      id: cardId,
      title,
      description: promoteDesc,
      status,
      priority: 'normal',
      assignee: BOT_NAME,
      project: projectCheck.project ?? undefined,
    })
    applyCardLabels(cardId, labels.labelIds)
    logIdeaStatusChange(ideaId, idea.status, 'kanban', MAIN_AGENT_ID, `promote:${phase}`)
    updateIdea(ideaId, { status: 'kanban', kanban_id: cardId })
    json(res, { ok: true, kanban_id: cardId })
    return true
  }

  // AI breakdown: elaborate the idea into 3-5 assignable subtasks (no DB write
  // yet -- the user approves per-subtask in the UI, then calls promote-breakdown).
  const breakdownMatch = path.match(/^\/api\/ideas\/([^/]+)\/breakdown$/)
  if (breakdownMatch && method === 'POST') {
    const ideaId = decodeURIComponent(breakdownMatch[1])
    const idea = getIdea(ideaId)
    if (!idea) { json(res, { error: 'Ötlet nem található' }, 404); return true }
    try {
      const result = await generateBreakdown(idea.title, idea.description)
      json(res, { subtasks: result.subtasks })
    } catch (err) {
      logger.error({ err, ideaId }, 'Idea breakdown generation failed')
      json(res, { error: (err as Error).message }, 500)
    }
    return true
  }

  // Promote an idea via approved breakdown: create a parent card from the idea +
  // one child card per approved subtask (assignee + priority), mark idea 'kanban'.
  const promoteBreakdownMatch = path.match(/^\/api\/ideas\/([^/]+)\/promote-breakdown$/)
  if (promoteBreakdownMatch && method === 'POST') {
    const ideaId = decodeURIComponent(promoteBreakdownMatch[1])
    const idea = getIdea(ideaId)
    if (!idea) { json(res, { error: 'Ötlet nem található' }, 404); return true }
    const body = await readBody(req)
    const breakdownData = JSON.parse(body.toString()) as {
      subtasks: Array<{ title: string; description?: string; assignee?: string | null; priority?: string }>
      success_criteria?: string
      labels?: unknown
      project?: unknown
      no_project_reason?: unknown
    }
    const { subtasks, success_criteria, labels: requestedLabels } = breakdownData
    if (!Array.isArray(subtasks) || subtasks.length === 0) {
      json(res, { error: 'Legalább egy jóváhagyott alfeladat kötelező' }, 400)
      return true
    }
    // Same rule as everywhere else: no card without a label. The children
    // inherit the parent's, so only the parent needs a choice.
    const labels = resolveCardLabels(requestedLabels)
    if (!labels.ok) { json(res, { error: labels.error }, 400); return true }
    const projectCheck = ideaCardProject(ideaId, breakdownData)
    if (!projectCheck.ok) { json(res, projectRequiredReply(reqLang(req, url), projectCheck), 400); return true }
    const baseDesc = idea.description ?? ''
    let parentDesc = success_criteria?.trim()
      ? `${baseDesc}\n\n## Siker-kritérium\n${success_criteria.trim()}`.trimStart()
      : baseDesc
    if (projectCheck.noProjectReason) {
      parentDesc = `${parentDesc}${parentDesc.trim() ? '\n\n' : ''}Projekt nelkul, mert: ${projectCheck.noProjectReason}`
    }
    const parentId = randomUUID().slice(0, 8)
    createKanbanCard({
      id: parentId,
      title: idea.title,
      description: parentDesc,
      status: 'planned',
      priority: 'normal',
      assignee: BOT_NAME,
      project: projectCheck.project ?? undefined,
    })
    applyCardLabels(parentId, labels.labelIds)
    const childIds: string[] = []
    for (const st of subtasks) {
      if (!st.title) continue
      const childId = randomUUID().slice(0, 8)
      createKanbanCard({
        id: childId,
        title: String(st.title).slice(0, 120),
        description: (st.description ?? '').slice(0, 500),
        status: 'planned',
        priority: (st.priority && VALID_PRIORITIES.has(st.priority) ? st.priority : 'normal') as 'low' | 'normal' | 'high' | 'urgent',
        assignee: st.assignee || BOT_NAME,
        project: projectCheck.project ?? undefined,
        parent_id: parentId,
      })
      applyCardLabels(childId, labels.labelIds)
      childIds.push(childId)
    }
    logIdeaStatusChange(ideaId, idea.status, 'kanban', MAIN_AGENT_ID, `promote-breakdown:${childIds.length} subtasks`)
    updateIdea(ideaId, { status: 'kanban', kanban_id: parentId })
    json(res, { ok: true, parent_id: parentId, child_count: childIds.length })
    return true
  }

  // Manual revert: kanban -> reviewed (clears kanban_id)
  const revertMatch = path.match(/^\/api\/ideas\/([^/]+)\/revert$/)
  if (revertMatch && method === 'POST') {
    const id = decodeURIComponent(revertMatch[1])
    const idea = getIdea(id)
    if (!idea) { json(res, { error: 'Ötlet nem található' }, 404); return true }
    if (idea.status !== 'kanban') { json(res, { error: 'Csak kanban státuszú ötlet vonható vissza' }, 400); return true }
    updateIdea(id, { status: 'reviewed', kanban_id: null })
    logIdeaStatusChange(id, 'kanban', 'reviewed', MAIN_AGENT_ID, 'Manuális visszavonás')
    json(res, { ok: true })
    return true
  }

  // Status audit log for an idea
  const statusLogMatch = path.match(/^\/api\/ideas\/([^/]+)\/status-log$/)
  if (statusLogMatch && method === 'GET') {
    const ideaId = decodeURIComponent(statusLogMatch[1])
    json(res, { log: getIdeaStatusLog(ideaId) })
    return true
  }

  return false
}
