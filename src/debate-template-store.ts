// Debate templates (#597, phase 6): a saved set-up of the debate panel under one name, so it is not set again every
// time -- the mode, how hard the critic pushes, the role swap, the models and the judge. Kept in
// store/debate-templates.json (the owner's data, backed up, see src/backup/inventory.ts).
//
// A template holds NO question and no material: only the choices that repeat from one debate to the next. A mode
// that was deleted after the template was saved is not an error here -- the template still loads and the panel
// falls back to the default mode (`modeMissing`), because the models and the judge are still worth keeping.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { STORE_DIR } from './config.js'
import { logger } from './logger.js'
import { isStrength, type Strength } from './debate-modes.js'
import { lookupMode } from './debate-mode-store.js'

export const DEBATE_TEMPLATES_PATH = join(STORE_DIR, 'debate-templates.json')

export const TEMPLATE_NAME_MAX = 60
export const TEMPLATES_MAX = 50
const MODEL_MAX = 200
const MODELS_MAX = 3

/** What store/debate-templates.json keeps for one template. Plain data. */
export interface StoredTemplate {
  id: string
  name: string
  /** Id of a debate mode (built in or the owner's own). */
  mode: string
  /** null = the mode's own strength / role swap. */
  strength: Strength | null
  swapRoles: boolean | null
  /** The debaters in the order the panel shows them (the first one is the critic in a review mode). Empty strings stay empty. */
  models: string[]
  /** The model that writes the closing; empty = the first model does. */
  judge: string
}

export type SaveTemplateResult = { ok: true; template: StoredTemplate } | { ok: false; error: string }

function newTemplateId(): string {
  return `t-${randomBytes(4).toString('hex')}`
}

function clean(v: unknown, max: number): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : ''
}

/** Checks what the panel sent. An error is a short machine word that the route turns into a sentence. */
export function sanitizeTemplate(raw: unknown, newId: () => string = newTemplateId): SaveTemplateResult {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'bad_input' }
  const r = raw as Record<string, unknown>
  const name = clean(r.name, TEMPLATE_NAME_MAX)
  if (!name) return { ok: false, error: 'name_missing' }
  const mode = clean(r.mode, 80)
  if (!mode) return { ok: false, error: 'mode_missing' }
  const models = Array.isArray(r.models) ? r.models.slice(0, MODELS_MAX).map(m => clean(m, MODEL_MAX)) : []
  if (!models.some(Boolean)) return { ok: false, error: 'models_missing' }
  const id = typeof r.id === 'string' && /^t-[a-z0-9]{6,16}$/.test(r.id) ? r.id : newId()
  return {
    ok: true,
    template: {
      id, name, mode,
      strength: isStrength(r.strength) ? r.strength : null,
      swapRoles: typeof r.swapRoles === 'boolean' ? r.swapRoles : null,
      models, judge: clean(r.judge, MODEL_MAX),
    },
  }
}

/** The stored templates, the broken entries left out: a file the owner edited by hand must never break the panel. */
export function loadTemplates(): StoredTemplate[] {
  try {
    if (!existsSync(DEBATE_TEMPLATES_PATH)) return []
    const parsed = JSON.parse(readFileSync(DEBATE_TEMPLATES_PATH, 'utf-8')) as { templates?: unknown }
    if (!parsed || !Array.isArray(parsed.templates)) return []
    const out: StoredTemplate[] = []
    const seen = new Set<string>()
    for (const raw of parsed.templates) {
      const r = sanitizeTemplate(raw)
      // An entry without a valid id of its own is not kept (its id would change on every read).
      const hasId = !!raw && typeof raw === 'object' && (raw as { id?: unknown }).id === (r.ok ? r.template.id : null)
      if (r.ok && hasId && !seen.has(r.template.id)) { seen.add(r.template.id); out.push(r.template) }
    }
    return out
  } catch (err) {
    logger.warn({ err: String((err as Error)?.message || err) }, '[debate] templates file unreadable, no templates')
    return []
  }
}

function writeTemplates(list: StoredTemplate[]): void {
  mkdirSync(STORE_DIR, { recursive: true })
  const tmp = `${DEBATE_TEMPLATES_PATH}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ version: 1, templates: list }, null, 2))
  renameSync(tmp, DEBATE_TEMPLATES_PATH)
}

/**
 * Saves a template. With an `id` that exists it replaces that one; without one, a template of the same name (any
 * letter case) is replaced -- saving "Jogi atnezes" twice updates it instead of piling up copies.
 */
export function saveTemplate(raw: unknown): SaveTemplateResult {
  const r = sanitizeTemplate(raw)
  if (!r.ok) return r
  const list = loadTemplates()
  let at = list.findIndex(t => t.id === r.template.id)
  const hadId = typeof (raw as { id?: unknown }).id === 'string' && at >= 0
  if (!hadId) {
    at = list.findIndex(t => t.name.toLowerCase() === r.template.name.toLowerCase())
    if (at >= 0) r.template.id = list[at].id
  }
  if (at < 0 && list.length >= TEMPLATES_MAX) return { ok: false, error: 'too_many' }
  if (at >= 0) list[at] = r.template
  else list.push(r.template)
  writeTemplates(list)
  return { ok: true, template: r.template }
}

/** Deletes a template; false when there was none. */
export function deleteTemplate(id: string): boolean {
  const list = loadTemplates()
  const next = list.filter(t => t.id !== id)
  if (next.length === list.length) return false
  writeTemplates(next)
  return true
}

/** The templates as the panel lists them: with a flag for a mode that no longer exists. */
export function templatesForPanel(): (StoredTemplate & { modeMissing: boolean })[] {
  return loadTemplates().map(t => ({ ...t, modeMissing: lookupMode(t.mode) === null }))
}
