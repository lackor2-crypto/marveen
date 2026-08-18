import { readBody, json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import {
  findMechanismIssues, clampGateTokens, effectiveAutocompactTokens,
  maxGateTokensFor, GATE_MIN_TOKENS,
} from '../../context-mechanisms.js'
import { SETTINGS_REGISTRY, validateSettingValue } from '../../config-registry.js'
import { getEffectiveSettingValue, setOverride } from '../../settings-store.js'
import { isRestartPending } from '../../settings-restart-pending.js'
import { logConfigChange } from '../../db.js'
import { setStoreWriteActor } from '../../store-watcher.js'
import { readGateConfig, writeGateConfig } from '../context-restart-gate-store.js'
import { BROKER_ROLE_IDS, assignRole, type BrokerRoleId } from '../../context-broker.js'
import {
  listBrokerCandidates,
  readBrokerConfig,
  resolveEffectiveBroker,
  writeBrokerConfig,
} from '../context-broker-store.js'
import { listAgentNames } from '../agent-config.js'
import { agentSessionName } from '../agent-process.js'
import { MAIN_CHANNELS_SESSION } from '../main-agent.js'
import { readRunningAutocompact } from '../running-autocompact.js'
import { MAIN_AGENT_ID, AUTOCOMPACT_TOKENS } from '../../config.js'
import type { RouteContext } from './types.js'

export async function tryHandleSettings(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path === '/api/settings' && method === 'GET') {
    // secret:true entries are filtered out entirely -- not just the value,
    // the whole row -- per spec: a secret's existence is exposed elsewhere
    // (the vault page), not duplicated here.
    const settings = SETTINGS_REGISTRY.filter((def) => !def.secret).map((def) => ({
      key: def.key,
      type: def.type,
      value: getEffectiveSettingValue(def.key),
      default: def.default,
      description: def.description,
      module: def.module,
      requiresRestart: def.requiresRestart,
      // What the owner has to restart, and whether he owes one RIGHT NOW.
      // requiresRestart alone put a permanent yellow badge on nine rows that no
      // restart could ever clear (Boss, 2026-08-16).
      restartTarget: def.restartTarget,
      restartPending: def.requiresRestart ? isRestartPending(def.key) : false,
      valueSet: def.valueSet,
      min: def.min,
      max: def.max,
    }))
    json(res, { settings })
    return true
  }

  if (path === '/api/settings' && method === 'POST') {
    try {
      const body = await readBody(req)
      const { key, value, actor } = JSON.parse(body.toString())

      if (!key || typeof key !== 'string') {
        json(res, { error: 'Missing or invalid "key"' }, 400)
        return true
      }

      const def = SETTINGS_REGISTRY.find((s) => s.key === key)
      if (!def) {
        json(res, { error: `Unknown setting key: ${key}` }, 404)
        return true
      }
      if (def.secret) {
        // Defensive: v1 has no secret entries, but a future registry entry
        // marked secret must never be settable through this generic route.
        json(res, { error: 'Secret settings cannot be changed via this endpoint' }, 403)
        return true
      }

      // Validate before touching anything. setOverride re-validates
      // internally too, but checking here lets us read the "old" value for
      // the change log without assuming the write will succeed.
      const validation = validateSettingValue(def, value)
      if (!validation.ok) {
        json(res, { error: validation.error }, 400)
        return true
      }

      const resolvedActor = typeof actor === 'string' && actor ? actor : 'dashboard'
      setStoreWriteActor(resolvedActor)
      const oldValue = getEffectiveSettingValue(key)
      const result = setOverride(key, value)
      if (!result.ok) {
        json(res, { error: result.error }, 400)
        return true
      }

      logConfigChange(key, oldValue, validation.value!, resolvedActor)
      logger.info({ key, oldValue, newValue: validation.value }, 'Setting updated')
      json(res, { ok: true, key, value: validation.value, requiresRestart: def.requiresRestart })
    } catch (err) {
      logger.error({ err }, 'Failed to update setting')
      json(res, { error: 'Failed to update setting' }, 500)
    }
    return true
  }

  // Per-agent config for the proactive context-restart (/clear) gate. The gate
  // ships OFF for every agent (enabled defaults to false); this is the surface
  // the owner uses to turn it on and pick a per-agent threshold by hand, rather
  // than editing store/context-restart-gate.json directly.
  if (path === '/api/context-restart-gate' && method === 'GET') {
    const names = [MAIN_AGENT_ID, ...listAgentNames()]
    // autocompactRunning is what the agent's LIVE process was started with,
    // which is not necessarily AUTOCOMPACT_TOKENS: the flag is passed at launch
    // and these sessions run for days. Sending both lets the card say "in
    // effect at the next start" instead of showing a value the agent is not
    // actually using (see src/web/running-autocompact.ts for the incident).
    const agents = names.map((name) => {
      const running = readRunningAutocompact(
        name === MAIN_AGENT_ID ? MAIN_CHANNELS_SESSION : agentSessionName(name),
      )
      return {
        agent: name,
        ...readGateConfig(name),
        autocompactRunning: running,
        // The 69% figure stays server-side, like maxGateTokens: one place owns
        // it, so a measurement that moves does not have to be found twice.
        autocompactRunningFiresAt: running === null ? null : effectiveAutocompactTokens(running),
      }
    })
    // The card cannot judge its own threshold without knowing where the CLI
    // fires, and that value lives in .env, not here. Sending it means the UI
    // can refuse a broken combination BEFORE the owner saves it, instead of
    // storing a number that quietly never takes effect (which is exactly what
    // happened to every agent but one).
    json(res, {
      agents,
      autocompactTokens: AUTOCOMPACT_TOKENS,
      autocompactFiresAt: effectiveAutocompactTokens(AUTOCOMPACT_TOKENS),
      maxGateTokens: maxGateTokensFor(AUTOCOMPACT_TOKENS),
      minGateTokens: GATE_MIN_TOKENS,
    })
    return true
  }

  if (path === '/api/context-restart-gate' && method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req)).toString())
      const agent = typeof body?.agent === 'string' ? body.agent : ''
      const known = new Set([MAIN_AGENT_ID, ...listAgentNames()])
      if (!agent || !known.has(agent)) {
        json(res, { error: 'Unknown or missing "agent"' }, 400)
        return true
      }
      // The UI blocks this combination too, but the rule has to hold at the
      // boundary: an API caller, an older cached page or a hand-written curl
      // must not be able to store a threshold above where the CLI's autocompact
      // fires. That is not a stricter setting, it is a dead one -- the CLI
      // reaches the context first every time and the gate never runs.
      const requestedTokens = Number(body?.thresholdTokens)
      if (body?.enabled === true && Number.isFinite(requestedTokens) && requestedTokens > 0) {
        const issues = findMechanismIssues({
          gateEnabled: true,
          gateTokens: requestedTokens,
          autocompactTokens: AUTOCOMPACT_TOKENS,
          brokerDesignated: false,
          brokerCleanStart: false,
        })
        const blocking = issues.find((i) => i.severity === 'error')
        if (blocking) {
          json(res, {
            error: 'gate threshold conflicts with autocompact',
            issue: blocking,
            suggestedThresholdTokens: clampGateTokens(requestedTokens, AUTOCOMPACT_TOKENS),
          }, 400)
          return true
        }
      }
      // writeGateConfig normalizes (enabled must be strictly true; thresholdTokens
      // a positive int, else the documented default), so partial/garbage input
      // can never produce a half-valid config on disk.
      const saved = writeGateConfig(agent, {
        enabled: body?.enabled,
        thresholdTokens: body?.thresholdTokens,
      })
      logger.info({ agent, saved }, 'Context-restart gate config updated')
      json(res, { ok: true, agent, config: saved })
    } catch (err) {
      logger.error({ err }, 'Failed to update context-restart gate config')
      json(res, { error: 'Failed to update gate config' }, 500)
    }
    return true
  }

  // Who prepares the work packages for the fleet (kanban 90d945b5). Exactly one
  // agent holds the role, so this endpoint takes a single name rather than a
  // per-agent flag -- POSTing a new name clears the previous holder in the same
  // write. The response also carries who is ACTUALLY doing it right now, which
  // differs from the designation when the designated agent is stopped or out of
  // quota, and agents read it to know where to send a "send me more context"
  // request.
  if (path === '/api/context-broker' && method === 'GET') {
    const resolution = resolveEffectiveBroker()
    json(res, { ...resolution, config: readBrokerConfig(), candidates: listBrokerCandidates() })
    return true
  }

  if (path === '/api/context-broker' && method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req)).toString())
      const raw = typeof body?.agent === 'string' ? body.agent.trim() : ''
      // enabled:false (unchecking the box) and agent:null both mean "nobody",
      // which is a valid state: the fleet falls back to every agent preparing
      // its own context, exactly as it did before this feature existed.
      const clearing = body?.enabled === false || body?.agent === null || raw === ''
      if (!clearing) {
        const known = new Set(listBrokerCandidates().map((c) => c.agent))
        if (!known.has(raw)) {
          json(res, { error: 'Unknown or missing "agent"' }, 400)
          return true
        }
      }
      const previous = readBrokerConfig().designated
      const target = clearing ? null : raw
      // No validation of cleanStart here on purpose. It is ONE policy for the
      // whole fleet ("the generator hands its delegates a fresh window"), not a
      // per-agent flag, so there is no combination to reject at this boundary.
      // The rule it must obey -- never wipe the generator itself, never wipe a
      // busy agent -- is a property of the moment the clear happens, and is
      // enforced where that happens: scripts/hooks/broker-role.py and the
      // context-action route, both of which can see the agent's live state.
      // A role assignment is a separate, additive edit: POSTing {role, agent}
      // changes only that role and leaves the generator designation alone, so
      // ticking "planner" on a card does not un-designate the generator.
      const roleId = typeof body?.role === 'string' ? body.role.trim() : ''
      if (roleId) {
        if (!(BROKER_ROLE_IDS as readonly string[]).includes(roleId)) {
          json(res, { error: `Unknown role "${roleId}"` }, 400)
          return true
        }
        const current = readBrokerConfig()
        const holder = body?.enabled === false ? null : (target ?? null)
        const savedRoles = writeBrokerConfig(current.designated, {
          roles: assignRole(current.roles, roleId as BrokerRoleId, holder),
        })
        logger.info({ role: roleId, agent: holder }, 'Broker role assignment updated')
        json(res, { ok: true, config: savedRoles, ...resolveEffectiveBroker() })
        return true
      }
      const saved = writeBrokerConfig(target, {
        cleanStart: typeof body?.cleanStart === 'boolean' ? body.cleanStart : undefined,
        handBackAfterSeconds: Number.isFinite(Number(body?.handBackAfterSeconds))
          ? Number(body.handBackAfterSeconds) : undefined,
      })
      logger.info({ previous, designated: saved.designated }, 'Context broker designation updated')
      json(res, { ok: true, config: saved, ...resolveEffectiveBroker() })
    } catch (err) {
      logger.error({ err }, 'Failed to update context broker designation')
      json(res, { error: 'Failed to update context broker' }, 500)
    }
    return true
  }

  return false
}
