// The debate templates (#597, phase 6): a saved set-up of the debate panel, kept in store/debate-templates.json.
//
//   GET    /api/debate/templates        the templates (with `modeMissing` for one whose mode was deleted since)
//   POST   /api/debate/templates        save a template; the same {id} or the same name replaces it
//   DELETE /api/debate/templates/:id    delete one

import { json, readBody } from '../http-helpers.js'
import type { RouteContext } from './types.js'
import { T } from '../../life-inbox-analyze.js'
import { saveTemplate, deleteTemplate, templatesForPanel, TEMPLATES_MAX, TEMPLATE_NAME_MAX } from '../../debate-template-store.js'

function lang(url: URL): string {
  return url.searchParams.get('lang') === 'en' ? 'en' : 'hu'
}

function fail(res: RouteContext['res'], status: number, error: string, message: string): true {
  json(res, { error, message }, status)
  return true
}

const SAVE_ERRORS: Record<string, [string, string]> = {
  bad_input: ['Hibás kérés.', 'Bad request.'],
  name_missing: ['Adj nevet a sablonnak.', 'Give the template a name.'],
  mode_missing: ['Válassz módot a sablonhoz.', 'Pick a mode for the template.'],
  models_missing: ['Add meg legalább az egyik modellt, különben nincs mit elmenteni.', 'Enter at least one model, otherwise there is nothing to save.'],
  too_many: [`Legfeljebb ${TEMPLATES_MAX} sablon lehet. Törölj egyet.`, `There can be at most ${TEMPLATES_MAX} templates. Delete one.`],
}

export async function tryHandleDebateTemplates(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx
  const l = lang(url)

  if (path === '/api/debate/templates' && method === 'GET') {
    json(res, { templates: templatesForPanel(), limits: { templates: TEMPLATES_MAX, name: TEMPLATE_NAME_MAX } })
    return true
  }

  if (path === '/api/debate/templates' && method === 'POST') {
    let body: unknown
    try { body = JSON.parse((await readBody(req)).toString()) } catch { return fail(res, 400, 'bad_json', T(l, 'Hibás kérés.', 'Bad request.')) }
    const r = saveTemplate(body)
    if (!r.ok) {
      const m = SAVE_ERRORS[r.error] ?? [r.error, r.error]
      return fail(res, 400, r.error, T(l, m[0], m[1]))
    }
    json(res, { template: r.template, templates: templatesForPanel() })
    return true
  }

  const del = path.match(/^\/api\/debate\/templates\/([^/]+)$/)
  if (del && method === 'DELETE') {
    if (!deleteTemplate(decodeURIComponent(del[1]))) return fail(res, 404, 'template_not_found', T(l, 'Ez a sablon nem található.', 'This template was not found.'))
    json(res, { ok: true, templates: templatesForPanel() })
    return true
  }

  return false
}
