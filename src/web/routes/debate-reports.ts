// The debate as a report, and what the debates so far have brought (#597, phase 6).
//
//   GET  /api/debate/sessions/:id/export?full=1   the report as Markdown text: {name, title, markdown} (the page saves it as a file)
//   POST /api/debate/sessions/:id/document {full}  the report as a new document work item of the debate's project
//   GET  /api/debate/analysis?project=<id|none>    per mode and model pair: objections raised / accepted, agreement, tokens

import { json, readBody } from '../http-helpers.js'
import type { RouteContext } from './types.js'
import { T } from '../../life-inbox-analyze.js'
import { loadDebateSession, loadAllDebateSessions } from '../../debate-run.js'
import { buildReport, reportMarkdown, reportFileName } from '../../debate-export.js'
import { createReportDocument } from '../../debate-export-doc.js'
import { analyzeDebates, MIN_DEBATES_FOR_COMPARISON } from '../../debate-analysis.js'
import { getProject } from '../../projects.js'

function lang(url: URL): 'hu' | 'en' {
  return url.searchParams.get('lang') === 'en' ? 'en' : 'hu'
}

function fail(res: RouteContext['res'], status: number, error: string, message: string): true {
  json(res, { error, message }, status)
  return true
}

export async function tryHandleDebateReports(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx
  const l = lang(url)

  if (path === '/api/debate/analysis' && method === 'GET') {
    const pf = url.searchParams.get('project') || ''
    json(res, { ...analyzeDebates(loadAllDebateSessions(), pf || null), min_debates: MIN_DEBATES_FOR_COMPARISON })
    return true
  }

  const exp = path.match(/^\/api\/debate\/sessions\/([^/]+)\/export$/)
  if (exp && method === 'GET') {
    const st = loadDebateSession(decodeURIComponent(exp[1]))
    if (!st) return fail(res, 404, 'session_not_found', T(l, 'Ez a vita nem található.', 'This debate was not found.'))
    const report = buildReport(st, l, { full: url.searchParams.get('full') === '1' })
    json(res, { name: reportFileName(st, 'md'), title: report.title, markdown: reportMarkdown(report) })
    return true
  }

  const doc = path.match(/^\/api\/debate\/sessions\/([^/]+)\/document$/)
  if (doc && method === 'POST') {
    let body: { full?: boolean } = {}
    try { const raw = (await readBody(req)).toString(); if (raw.trim()) body = JSON.parse(raw) } catch { return fail(res, 400, 'bad_json', T(l, 'Hibás kérés.', 'Bad request.')) }
    const st = loadDebateSession(decodeURIComponent(doc[1]))
    if (!st) return fail(res, 404, 'session_not_found', T(l, 'Ez a vita nem található.', 'This debate was not found.'))
    if (!st.project || !getProject(st.project)) {
      return fail(res, 409, 'no_project', T(l, 'Ez a vita nem tartozik projekthez, ezért nem menthető munkadarabként. Töltsd le fájlként.', 'This debate belongs to no project, so it cannot be saved as a work item. Download it as a file instead.'))
    }
    const a = ctx.auth
    const by = a ? (a.kind === 'session' && a.user ? a.user : a.kind) : null
    const r = createReportDocument(st.project, buildReport(st, l, { full: body.full === true }), by)
    if (!r.ok) {
      const msg: Record<string, [string, string]> = {
        project_not_found: ['A projekt nem található.', 'The project was not found.'],
        project_archived: ['A projekt archivált, ezért csak olvasható. Állítsd vissza a Projektek oldalon.', 'The project is archived, so it is read-only. Restore it on the Projects page.'],
      }
      const m = msg[r.code] ?? ['A jelentést nem sikerült munkadarabként elmenteni.', 'The report could not be saved as a work item.']
      return fail(res, r.code === 'project_archived' ? 409 : r.code === 'project_not_found' ? 404 : 500, r.code, T(l, m[0], m[1]))
    }
    json(res, { item: { id: r.item.id, title: r.item.title, project_id: r.item.project_id } }, 201)
    return true
  }

  return false
}
