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
// CORRECTION, same day (Telegram 604). The "except the free ones" half above
// was Boss's first wording; when he saw what it would mean, he threw it out:
//
//   "az admin jogon azt ertettem hogy az osszes ai en vagyok. tehat ennek a
//    korlatozasnak nincs semmi ertelme. hiszen a marvin alatt lehet barmi.
//    tehetek oda opus 5 ot. de tehetek pt modelt is. barmit. es ha igy van
//    akkor mitol rosszabb mondjuk most a masik fiok mint marvin. tehat csak
//    annyit ertettem rajta hogy vedd ki a kibaszott korlatozasokat."
//
// His argument is about identity, and it is correct: which model sits under an
// agent is his choice, changeable in one click, so it cannot be what decides
// whether that agent is trusted. A free model is not a different person -- it
// is the same owner on a cheaper engine. So the default is now ADMIN FOR
// EVERY AGENT, and the model is shown on the dashboard as information only.
//
// The per-agent override stays, and it is the reason this file still exists:
// the switch now runs the other way (it can TAKE a right away), and whoever
// installs Marveen next may want exactly that. Removing the mechanism because
// today's default is "everyone" would mean rebuilding it the first time
// somebody disagrees.
//
// SECOND CORRECTION, same day (Telegram 611):
//
//   "he. lattam hogy az autonomiaba belenyultal. amik ott be voltak allitva
//    azokat allitsd vissza! az jo hogy oda betetted az agenteket, de a
//    tobibhez miert nyultal?"
//
// Reading "vedd ki a korlatozasokat" as "raise every category to 3" was too
// wide: those per-category dials are HIS, set by hand on the Autonomy tab, and
// nobody asked for them to be moved. They are restored to their pre-change
// values, and the rule here is now simple enough that it cannot quietly
// override them again:
//
//   * the category level is the truth, for every agent alike -- no agent is
//     silently lifted above the number the owner sees on the dashboard;
//   * maxLevel is what it always was: the ceiling of the SLIDER, i.e. how high
//     the owner may turn that category up, not a right handed to an agent;
//   * the per-agent switch only TAKES away: an agent set to "alap" never acts
//     alone -- it is capped at 2 (ask first) even where the category says 3.
//     Capped at 2 and not at 1 because that is what the button on the
//     dashboard promises ("Alap: jovahagyast ker"); silently making it "report
//     and stop" would be a harsher rule than the label the owner clicked.
//     Default stays admin for everyone, per 604.
//
// What did NOT go away is the behavioural rule in every CLAUDE.md: before
// money, before a message to a real recipient, and before a delete, the agent
// asks the owner. That is a question on Telegram, not an approval ticket --
// which is precisely the difference Boss was complaining about.

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

/**
 * What the rule alone says, before any hand-set exception: everyone.
 *
 * The parameter is kept deliberately. It is what a per-agent policy would need
 * if the owner (or whoever installs this next) ever wants one back, and it
 * keeps every call site honest about asking "for WHICH agent" instead of
 * reading a global flag.
 */
export function derivedAdmin(_name: string): boolean {
  return true
}

export function isAdminAgent(name: string, config?: AutonomyConfig): boolean {
  const override = config?.agent_admin_overrides?.[name]
  if (typeof override === 'boolean') return override
  return derivedAdmin(name)
}

/**
 * The level THIS agent runs a category at.
 *
 * The category's own `level` is the answer for every admin agent -- i.e. the
 * number the owner set on the dashboard is the number that governs, so nothing
 * here can quietly run higher than what he can see (Boss, Telegram 611).
 * `maxLevel` is NOT consulted: it caps the slider in the UI and the POST
 * handler, it is not a right. An agent switched off admin is capped at 2 --
 * it asks before acting even where the category allows acting alone, which is
 * exactly what its dashboard button says. `locked` still wins over everything:
 * nothing ships locked today, but the field is what a future hard safety
 * constraint would use, and an autonomy setting must not out-vote one.
 */
export function effectiveLevel(cat: AutonomyCategory, name: string, config?: AutonomyConfig): number {
  if (cat.locked) return Math.min(cat.level, 1)
  if (!isAdminAgent(name, config)) return Math.min(cat.level, 2)
  return cat.level
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
