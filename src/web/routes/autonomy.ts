import { readBody, json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import { setStoreWriteActor } from '../../store-watcher.js'
import {
  loadAutonomyConfig,
  saveAutonomyConfig,
  listAgentAutonomy,
  setAgentAdminOverride,
  derivedAdmin,
  isFreeAgent,
} from '../../autonomy.js'
import { listAgentNames } from '../agent-config.js'
import { MAIN_AGENT_ID } from '../../config.js'
import type { RouteContext } from './types.js'

export async function tryHandleAutonomy(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path === '/api/autonomy' && method === 'GET') {
    try {
      const config = loadAutonomyConfig()
      // The agent rows travel with the categories on purpose: the dashboard
      // renders both in one card, and a second round-trip would let the two
      // halves disagree for a moment about who is admin.
      json(res, { ...config, agents: listAgentAutonomy(config) })
    } catch (err) {
      logger.error({ err }, 'Failed to load autonomy config')
      json(res, {
        error: 'config_not_found',
        message: 'Az önállósági beállítások fájlja (store/autonomy-config.json) nem található. Futtasd az update.sh-t, az a seed-config mappából pótolja.',
      }, 404)
    }
    return true
  }

  if (path === '/api/autonomy' && method === 'POST') {
    try {
      const body = await readBody(req)
      const { key, level } = JSON.parse(body.toString())

      if (!key || typeof level !== 'number' || level < 1 || level > 3) {
        json(res, { error: 'invalid_input', message: 'Hiányzó kategória vagy érvénytelen szint (1 és 3 között lehet).' }, 400)
        return true
      }

      const config = loadAutonomyConfig()
      const cat = config.categories.find(c => c.key === key)
      if (!cat) {
        json(res, { error: 'unknown_category', message: `Nincs ilyen kategória: "${key}".` }, 404)
        return true
      }

      if (cat.locked && level > 1) {
        json(res, { error: 'locked', message: `A(z) "${cat.label}" kategória biztonsági okból 1-es szinten van rögzítve, nem emelhető.` }, 403)
        return true
      }

      if (level > cat.maxLevel) {
        json(res, { error: 'above_max', message: `A(z) "${cat.label}" kategóriánál a legmagasabb választható szint ${cat.maxLevel}.` }, 400)
        return true
      }

      cat.level = level
      setStoreWriteActor('dashboard')
      saveAutonomyConfig(config)
      logger.info({ key, level }, 'Autonomy level updated')
      json(res, { ok: true, key, level, updated_at: config.updated_at })
    } catch (err) {
      logger.error({ err }, 'Failed to update autonomy config')
      json(res, { error: 'save_failed', message: 'Nem sikerült menteni az önállósági beállítást. A részletek a dashboard naplójában vannak.' }, 500)
    }
    return true
  }

  // Per-agent admin right. `admin: null` clears the exception and puts the
  // agent back on the model rule (free -> not admin, paid -> admin), which is
  // a different state from an explicit false and must stay reachable.
  if (path === '/api/autonomy/agent' && method === 'POST') {
    try {
      const body = await readBody(req)
      const { agent, admin } = JSON.parse(body.toString())

      if (typeof agent !== 'string' || !agent.trim()) {
        json(res, { error: 'invalid_input', message: 'Meg kell adni, melyik ágensről van szó.' }, 400)
        return true
      }
      if (admin !== null && typeof admin !== 'boolean') {
        json(res, { error: 'invalid_input', message: 'Az "admin" mező csak igaz, hamis vagy null lehet (a null visszaállítja az alapszabályt).' }, 400)
        return true
      }

      const known = new Set([MAIN_AGENT_ID, ...listAgentNames()])
      if (!known.has(agent)) {
        json(res, { error: 'unknown_agent', message: `Nincs ilyen ágens ezen a telepítésen: "${agent}".` }, 404)
        return true
      }

      const config = loadAutonomyConfig()
      setAgentAdminOverride(config, agent, admin)
      setStoreWriteActor('dashboard')
      saveAutonomyConfig(config)
      logger.info({ agent, admin }, 'Agent admin right updated')
      json(res, {
        ok: true,
        agent,
        admin: admin === null ? derivedAdmin(agent) : admin,
        overridden: admin !== null,
        free: isFreeAgent(agent),
        updated_at: config.updated_at,
      })
    } catch (err) {
      logger.error({ err }, 'Failed to update agent admin right')
      json(res, { error: 'save_failed', message: 'Nem sikerült menteni az ágens jogosultságát. A részletek a dashboard naplójában vannak.' }, 500)
    }
    return true
  }

  return false
}
