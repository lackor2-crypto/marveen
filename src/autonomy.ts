// Per-agent autonomy: who may act without asking the owner.
//
// Boss, 2026-08-27 (Telegram 593 and 595, verbatim):
//   "a jovoben soha ne kelljen ilyet csinalni hogy brmit jova kelljen hagyni
//    nekem. csak mert a marveen t modositom. akarmelyik agenttel."
//   "kapjon az osszes agent admin jogot. es kesz. kiveve az ingyenes agenteket."
//
// Two separate things come out of those two sentences, and they are separate
// here too:
//
//   1. Modifying Marveen itself never needs an approval, for ANY agent -- the
//      free ones included ("akarmelyik agenttel"). That is the marveen_selfdev
//      category, level 3 fleet-wide.
//   2. Every agent EXCEPT the free ones runs as admin: each category is lifted
//      to the ceiling the config itself declares for it (maxLevel).
//
// Why "except the free ones" is DERIVED and not a stored list: a stored list is
// a snapshot, and the next agent created after it is written would silently
// fall outside it -- admin or not admin, nobody could tell which was meant. The
// rule Boss stated is about the MODEL ("ingyenes"), so the model is what we
// read. An explicit per-agent override exists on top for the cases his rule
// does not decide (a paid-but-cheap agent he may not want at admin), and that
// override is what the dashboard writes.
//
// Why admin stops at maxLevel instead of forcing 3 everywhere: the maxLevel:2
// entries are the config's own statement that a human decides those -- the
// owner's money (payment), a message to a real recipient (email_send,
// external_message, publish_content), an irreversible delete (data_delete), a
// permission change, sudo, a reboot. "Admin" removes the friction Boss was
// annoyed by; it does not quietly hand out his wallet. Every one of those caps
// is visible and raisable on the dashboard, so this is a default, not a wall.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT, STORE_DIR, MAIN_AGENT_ID } from './config.js'
import { isFreeOpenRouterModel } from './openrouter-dispatch-throttle.js'
import { readAgentModel, listAgentNames, DEFAULT_MODEL } from './web/agent-config.js'

export const AUTONOMY_CONFIG_PATH = join(STORE_DIR, 'autonomy-config.json')

/** The category that makes Boss's sentence 593 true for every agent. */
export const MARVEEN_SELFDEV_KEY = 'marveen_selfdev'

export interface AutonomyCategory {
  key: string
  label: string
  level: number
  locked: boolean
  maxLevel: number
  timeout_minutes?: number
}

export interface AutonomyConfig {
  version: number
  updated_at: number
  _doc?: string
  /**
   * Per-agent exceptions to the derived default only. Absent agent = derived
   * from its model (free -> not admin, paid -> admin). Never a full roster.
   */
  agent_admin_overrides?: Record<string, boolean>
  categories: AutonomyCategory[]
}

export function loadAutonomyConfig(path = AUTONOMY_CONFIG_PATH): AutonomyConfig {
  if (!existsSync(path)) throw new Error('autonomy-config.json not found')
  return JSON.parse(readFileSync(path, 'utf-8')) as AutonomyConfig
}

export function saveAutonomyConfig(config: AutonomyConfig, path = AUTONOMY_CONFIG_PATH): void {
  config.updated_at = Math.floor(Date.now() / 1000)
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', 'utf-8')
}

/**
 * The model the MAIN agent runs on. It has no agents/<name>/ directory, so
 * readAgentModel() would answer with the sub-agent default and quietly say
 * something untrue about it. Resolution order mirrors what actually launches
 * the main session: .env MAIN_AGENT_MODEL, then .claude/settings.json "model".
 */
export function mainAgentModel(root = PROJECT_ROOT): string {
  const fromEnv = (process.env['MAIN_AGENT_MODEL'] ?? '').trim()
  if (fromEnv) return fromEnv
  try {
    const settings = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf-8'))
    if (typeof settings.model === 'string' && settings.model.trim()) return settings.model.trim()
  } catch { /* fall through -- an unreadable settings file is not a model name */ }
  return DEFAULT_MODEL
}

export function agentModelFor(name: string): string {
  return name === MAIN_AGENT_ID ? mainAgentModel() : readAgentModel(name)
}

/** "Ingyenes" as Boss used the word: the model id ends with `:free`. */
export function isFreeAgent(name: string): boolean {
  return isFreeOpenRouterModel(agentModelFor(name))
}

/** What the rule alone says, before any hand-set exception. */
export function derivedAdmin(name: string): boolean {
  return !isFreeAgent(name)
}

export function isAdminAgent(name: string, config?: AutonomyConfig): boolean {
  const override = config?.agent_admin_overrides?.[name]
  if (typeof override === 'boolean') return override
  return derivedAdmin(name)
}

/**
 * The level THIS agent runs a category at. Admin agents get the category's own
 * declared ceiling; everyone else gets the fleet level. `locked` wins over
 * both -- a hard safety constraint is not an autonomy setting.
 */
export function effectiveLevel(cat: AutonomyCategory, name: string, config?: AutonomyConfig): number {
  if (cat.locked) return Math.min(cat.level, 1)
  if (!isAdminAgent(name, config)) return cat.level
  return Math.max(cat.level, cat.maxLevel)
}

export interface AgentAutonomyRow {
  name: string
  model: string
  free: boolean
  admin: boolean
  /** true when admin came from an explicit dashboard setting, not from the model rule. */
  overridden: boolean
}

/** Every agent the dashboard should offer a switch for, main agent first. */
export function listAgentAutonomy(config?: AutonomyConfig): AgentAutonomyRow[] {
  let names: string[]
  try {
    names = listAgentNames()
  } catch {
    names = []
  }
  if (!names.includes(MAIN_AGENT_ID)) names = [MAIN_AGENT_ID, ...names]

  return names.map((name) => {
    const override = config?.agent_admin_overrides?.[name]
    return {
      name,
      model: agentModelFor(name),
      free: isFreeAgent(name),
      admin: isAdminAgent(name, config),
      overridden: typeof override === 'boolean',
    }
  })
}

/**
 * Sets (or clears, with null) one agent's exception. Clearing is a real
 * operation, not a delete-by-writing-false: "follow the rule" and "explicitly
 * not admin" must stay distinguishable, otherwise the dashboard cannot show
 * the user which of the two they picked.
 */
export function setAgentAdminOverride(
  config: AutonomyConfig,
  name: string,
  admin: boolean | null,
): AutonomyConfig {
  const overrides = { ...(config.agent_admin_overrides ?? {}) }
  if (admin === null) delete overrides[name]
  else overrides[name] = admin
  config.agent_admin_overrides = overrides
  return config
}
