// The debate mode editor (#597, phase 3): the owner's own modes, kept in store/debate-modes.json.
//
//   GET    /api/debate/modes        the built-in modes (read-only, as a model to copy) and the owner's modes with all their texts
//   POST   /api/debate/modes        create a mode, or replace the one whose {id} is given
//   DELETE /api/debate/modes/:id    delete an owner-made mode (debates already started with it keep their copy)
//   GET    /api/debate/modes/export?ids=a,b   the owner's modes (all, or the listed ones) as a share file: {name, count, file}
//   POST   /api/debate/modes/import   {content, dry_run?}  a share file -> new modes; dry_run only says what would happen

import { json, readBody } from '../http-helpers.js'
import type { RouteContext } from './types.js'
import { T } from '../../life-inbox-analyze.js'
import { BUILTIN_MODES, DEFAULT_TEXTS, DEFAULT_STRENGTH, STRENGTHS, MODE_NAME_MAX, MODE_TEXT_MAX, MODES_MAX, MAX_ROUNDS_LIMIT } from '../../debate-modes.js'
import { loadStoredModes, saveStoredMode, deleteStoredMode, appendStoredModes, newModeId } from '../../debate-mode-store.js'
import { buildShareFile, shareFileName, parseShareFile, planImport, SHARE_MAX_BYTES } from '../../debate-mode-share.js'
import { RequestBodyTooLargeError } from '../http-helpers.js'

function lang(url: URL): string {
  return url.searchParams.get('lang') === 'en' ? 'en' : 'hu'
}

function fail(res: RouteContext['res'], status: number, error: string, message: string): true {
  json(res, { error, message }, status)
  return true
}

const SHARE_ERRORS: Record<string, [string, string]> = {
  bad_json: ['Ez a fájl nem olvasható: nem érvényes JSON.', 'This file cannot be read: it is not valid JSON.'],
  not_a_mode_file: ['Ez nem vita-mód fájl. Olyan fájlt válassz, amit a „Saját módok exportálása” gomb készített.', 'This is not a debate mode file. Pick a file made by the “Export my modes” button.'],
  newer_version: ['Ezt a fájlt a Marveen újabb változata készítette, ez a változat még nem tudja beolvasni. Frissítsd a Marveent.', 'This file was made by a newer version of Marveen that this version cannot read yet. Update Marveen.'],
  too_big: ['A fájl túl nagy ahhoz, hogy módokat tartalmazzon.', 'The file is too big to hold modes.'],
  empty: ['A fájlban nincs egyetlen mód sem.', 'The file holds no modes.'],
  no_modes: ['Nincs saját mód, amit exportálni lehetne. Előbb készíts egyet a „Módok szerkesztése” oldalon.', 'There is no mode of your own to export. Make one on the “Edit modes” page first.'],
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
      // The three-sided mode is not offered as a sample: the editor makes two-model modes only.
      builtin: Object.values(BUILTIN_MODES).filter(m => !m.triad).map(m => ({
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

  if (path === '/api/debate/modes/export' && method === 'GET') {
    const ids = (url.searchParams.get('ids') || '').split(',').map(x => x.trim()).filter(Boolean)
    const all = loadStoredModes()
    const chosen = ids.length ? all.filter(m => ids.includes(m.id)) : all
    if (!chosen.length) return fail(res, 404, 'no_modes', T(l, SHARE_ERRORS.no_modes[0], SHARE_ERRORS.no_modes[1]))
    const now = new Date()
    json(res, { name: shareFileName(chosen.length, now), count: chosen.length, file: buildShareFile(chosen, now) })
    return true
  }

  if (path === '/api/debate/modes/import' && method === 'POST') {
    let body: { content?: unknown; dry_run?: boolean }
    try { body = JSON.parse((await readBody(req, { maxBytes: SHARE_MAX_BYTES * 2 })).toString()) } catch (err) {
      if (err instanceof RequestBodyTooLargeError) return fail(res, 413, 'too_big', T(l, SHARE_ERRORS.too_big[0], SHARE_ERRORS.too_big[1]))
      return fail(res, 400, 'bad_json', T(l, 'Hibás kérés.', 'Bad request.'))
    }
    const parsed = parseShareFile(body?.content)
    if (!parsed.ok) {
      const m = SHARE_ERRORS[parsed.error]
      return fail(res, parsed.error === 'too_big' ? 413 : 400, parsed.error, T(l, m[0], m[1]))
    }
    const plan = planImport(parsed.modes, loadStoredModes(), newModeId)
    const dry = body.dry_run === true
    if (!dry) appendStoredModes(plan.toSave)
    json(res, {
      dry_run: dry,
      imported: plan.toSave.map(m => ({ id: dry ? null : m.id, name: m.name, description: m.description, base: m.base })),
      renamed: plan.renamed,
      skipped: plan.skipped,
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
