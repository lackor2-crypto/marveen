// The debate mode editor (#597, phase 3): the owner's own modes, kept in store/debate-modes.json.
//
//   GET    /api/debate/modes        the built-in modes (read-only, as a model to copy) and the owner's modes with all their texts
//   POST   /api/debate/modes        create a mode, or replace the one whose {id} is given
//   DELETE /api/debate/modes/:id    delete an owner-made mode (debates already started with it keep their copy)

import { json, readBody } from '../http-helpers.js'
import type { RouteContext } from './types.js'
import { T } from '../../life-inbox-analyze.js'
import { BUILTIN_MODES, DEFAULT_TEXTS, DEFAULT_STRENGTH, STRENGTHS, MODE_NAME_MAX, MODE_TEXT_MAX, MODES_MAX, MAX_ROUNDS_LIMIT } from '../../debate-modes.js'
import { loadStoredModes, saveStoredMode, deleteStoredMode } from '../../debate-mode-store.js'

function lang(url: URL): string {
  return url.searchParams.get('lang') === 'en' ? 'en' : 'hu'
}

function fail(res: RouteContext['res'], status: number, error: string, message: string): true {
  json(res, { error, message }, status)
  return true
}

const SAVE_ERRORS: Record<string, [string, string]> = {
  bad_input: ['Hibás kérés.', 'Bad request.'],
  name_missing: ['Adj nevet a módnak.', 'Give the mode a name.'],
  base_unknown: ['Válaszd ki, milyen típusú a mód (egyenrangú vagy kötekedő–védő).', 'Choose the kind of the mode (equal peers or critic–defender).'],
  max_rounds_bad: [`A körök legnagyobb száma 1 és ${MAX_ROUNDS_LIMIT} közötti egész szám legyen, vagy hagyd üresen.`, `The most rounds must be a whole number from 1 to ${MAX_ROUNDS_LIMIT}, or left empty.`],
  too_many: [`Legfeljebb ${MODES_MAX} saját mód lehet. Törölj egyet.`, `There can be at most ${MODES_MAX} modes of your own. Delete one.`],
}

export async function tryHandleDebateModes(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx
  const l = lang(url)

  if (path === '/api/debate/modes' && method === 'GET') {
    json(res, {
      builtin: Object.values(BUILTIN_MODES).map(m => ({
        id: m.id, base: m.roles[0] === 'peer' ? 'peer' : 'critic', instructions: m.instructions, conclusionNote: m.conclusionNote ?? '',
        strength: m.strength ?? DEFAULT_STRENGTH, swapRoles: m.swapRoles === true, maxRounds: m.maxRounds ?? null,
      })),
      custom: loadStoredModes(),
      defaults: DEFAULT_TEXTS,
      strengths: STRENGTHS,
      limits: { name: MODE_NAME_MAX, text: MODE_TEXT_MAX, modes: MODES_MAX, max_rounds: MAX_ROUNDS_LIMIT },
    })
    return true
  }

  if (path === '/api/debate/modes' && method === 'POST') {
    let body: unknown
    try { body = JSON.parse((await readBody(req)).toString()) } catch { return fail(res, 400, 'bad_json', T(l, 'Hibás kérés.', 'Bad request.')) }
    const r = saveStoredMode(body)
    if (!r.ok) {
      const m = SAVE_ERRORS[r.error] ?? [r.error, r.error]
      return fail(res, 400, r.error, T(l, m[0], m[1]))
    }
    json(res, { mode: r.mode })
    return true
  }

  const del = path.match(/^\/api\/debate\/modes\/([^/]+)$/)
  if (del && method === 'DELETE') {
    if (!deleteStoredMode(decodeURIComponent(del[1]))) return fail(res, 404, 'mode_not_found', T(l, 'Ez a mód nem található.', 'This mode was not found.'))
    json(res, { ok: true })
    return true
  }

  return false
}
