import { readBody, json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import {
  findMechanismIssues, clampGateTokens, effectiveAutocompactTokens,
  maxGateTokensFor, GATE_MIN_TOKENS,
} from '../../context-mechanisms.js'
import { SETTINGS_REGISTRY, validateSettingValue } from '../../config-registry.js'
import { getEffectiveSettingValue, setOverride } from '../../settings-store.js'
import { isRestartPending, targetKind, decideRestartPending } from '../../settings-restart-pending.js'
import type { PendingSessionScope } from '../../settings-restart-pending.js'
import { logConfigChange, getLastConfigChangeAt, getConfigValueAt } from '../../db.js'
import { setStoreWriteActor } from '../../store-watcher.js'
import { readGateConfig, writeGateConfig } from '../context-restart-gate-store.js'
import { BROKER_ROLE_IDS, assignRole, type BrokerRoleId } from '../../context-broker.js'
import { getCodeSession } from '../code-bridge-store.js'
import {
  listBrokerCandidates,
  readBrokerConfig,
  resolveEffectiveBroker,
  writeBrokerConfig,
} from '../context-broker-store.js'
import { listAgentNames } from '../agent-config.js'
import { agentSessionName, localSessionStartTimes } from '../agent-process.js'
import { MAIN_CHANNELS_SESSION } from '../main-agent.js'
import { readMainAgentRuntime } from '../main-agent-runtime.js'
import { HEARTBEAT_AGENT_NAME } from '../heartbeat-agent-scaffold.js'
import { readRunningAutocompact } from '../running-autocompact.js'
import { MAIN_AGENT_ID, AUTOCOMPACT_TOKENS } from '../../config.js'
import { googleAccountNames } from './accounts.js'
import os from 'node:os'
import fs from 'node:fs'
import path0 from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { RouteContext } from './types.js'

export async function tryHandleSettings(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path === '/api/settings' && method === 'GET') {
    // Mikor indultak azok a folyamatok, amelyek NEM a vezerlopultban elnek?
    // EGYETLEN tmux hivas az egesz oldalra (a dontes ~40 sorra fut le), es
    // hataronkent kulon halmaz: a legKORABBI indulas csak azok kozott szamit,
    // amelyek az adott kulcsot TENYLEG olvassak. Egy kozos "legregebbi
    // munkamenet" ertek a foagens kulcsait egy napok ota futo sub-agenshez
    // meri, es orokre sargan hagyja a jelvenyt.
    const sessionStarts = localSessionStartTimes()
    const oldestOf = (names: string[]): number | null => {
      const ts = names.map(sn => sessionStarts.get(sn)).filter((v): v is number => typeof v === 'number')
      return ts.length ? Math.min(...ts) : null
    }
    // A FOAGENS ideje NEM a munkamenet letrejotte. Marvin ujrainditasa
    // `tmux respawn-pane`: ugyanabban a munkamenetben indul uj folyamat, tehat
    // a `session_created` soha nem lep elore. Boss meresi naploja
    // (2026-08-18 18:24:14) pontosan ezt fogta meg: az ujrainditas megtortent,
    // a futo modell mar egyezett, a jelveny megis sarga maradt. Ezert a FUTO
    // FOLYAMAT indulasat kerdezzuk meg; a munkamenet ideje csak vegso tartalek,
    // ha a folyamat nem olvashato.
    //
    // A sub-agensekre ez nem all: azok `kill-session` + `new-session` parral
    // indulnak, ott a munkamenet ideje helyes.
    const mainRuntime = readMainAgentRuntime()
    const mainStartedAt = mainRuntime.startedAtMs ?? oldestOf([MAIN_CHANNELS_SESSION])
    const startsByScope: Record<PendingSessionScope, number | null> = {
      none: null,
      main: mainStartedAt,
      heartbeat: oldestOf([agentSessionName(HEARTBEAT_AGENT_NAME)]),
      // Uj agens felvetelekor is helyes: a lista mindig readdir-bol jon.
      // Az 'all' halmazban is a foagens szamit a legkorabbinak, ha a
      // munkamenete regi -- de a FOLYAMATA friss. A ket forrast itt kezzel
      // vonjuk ossze, kulonben ugyanaz a respawn-csapda all elo egy szinttel
      // feljebb.
      all: (() => {
        const subs = oldestOf(listAgentNames().map(agentSessionName))
        const both = [mainStartedAt, subs].filter((v): v is number => typeof v === 'number')
        return both.length ? Math.min(...both) : null
      })(),
    }
    const restartPendingFor = (def: { key: string; requiresRestart?: boolean; restartTarget?: string }): boolean => {
      if (!def.requiresRestart) return false
      const kind = targetKind(def.restartTarget)
      const startedAt = startsByScope[kind.sessions]
      return decideRestartPending({
        // Ma egyetlen kulcshoz olvashato ki, mit hasznal a futo folyamat: a
        // foagens modelljehez (ott all a `--model` a parancssorban). Eppen ez
        // volt az a kulcs, amirol a Boss haromszor szolt.
        runningValue: def.key === 'MAIN_AGENT_MODEL' ? mainRuntime.model : undefined,
        bootDiffers: isRestartPending(def.key),
        kind,
        changedAt: getLastConfigChangeAt(def.key),
        sessionsStartedAt: startedAt,
        // Amivel a cel-munkamenet elindult, szemben a mostani ertekkel.
        valueAtSessionStart: startedAt === null ? null : getConfigValueAt(def.key, startedAt),
        currentValue: getEffectiveSettingValue(def.key),
      })
    }
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
      restartPending: restartPendingFor(def),
      valueSet: def.valueSet,
      min: def.min,
      max: def.max,
      // Amit a futo folyamat TENYLEG hasznal (ma csak a foagens modelljehez
      // tudjuk). Egy sarga "Ujrainditasra var" jelveny nem mondja meg, MI a
      // baj; ez megmondja: "Most fut: X -- Beallitva: Y". A Boss haromszor
      // szolt ugyanezert a jelvenyert -- ha latszik a ket ertek, a kerdes fel
      // sem tud tenni magat.
      runningValue: def.key === 'MAIN_AGENT_MODEL' ? mainRuntime.model : undefined,
      // A KET IDOPONT. Boss (2026-08-18 18:40) ezt latta: "egyszer mar
      // ujrainditottam. es most megint ujra kell inditanom? sarga megint."
      // A naplo szerint igaza is volt, es a jelvenynek is: 18:39:21-kor
      // ujraindult (sonnet-5-tel, helyesen), majd 18:39:45-kor -- huszonnegy
      // masodperccel KESOBB -- atallitotta opus-5-re. A sorrend volt fordult,
      // nem a program hibazott. Ezt viszont csak akkor lehet tudni, ha a ket
      // idopont OTT ALL: "indult 18:39:27" / "mentve 18:39:45". Egy sarga
      // jelveny sose fogja ezt elmondani.
      runningSince: def.key === 'MAIN_AGENT_MODEL' ? mainRuntime.startedAtMs : undefined,
      valueSavedAt: def.key === 'MAIN_AGENT_MODEL' ? getLastConfigChangeAt(def.key) : undefined,
    }))
    json(res, { settings })
    return true
  }

  // ---------------------------------------------------------------------
  // GET /api/settings/options?key=X[&account=Y]
  //
  // Boss (2026-08-18): "a komuvesunk honnan tudja hogy mit kell ide beirni?
  // lehessen valasztani, kitallozni!" -- ahol a helyes ertek a GEPEN mar
  // megvan (Google-fiokok, naptarak, Claude config-konyvtarak, futo Ollama),
  // ott nem a felhasznalo dolga kitalalni: felsoroljuk neki.
  //
  // MINDIG 200-zal terunk vissza, hibas agon is: a `note` mezoben emberi
  // nyelven elmondjuk, miert ures a lista. Egy 500-as valasz csak egy nema,
  // ures legordulot eredmenyezne -- pontosan azt az allapotot, ami ellen ez
  // az egesz vegpont keszult.
  if (path === '/api/settings/options' && method === 'GET') {
    const key = ctx.url.searchParams.get('key') || ''
    const options: Array<{ value: string; label: string; hint?: string }> = []
    let note = ''
    try {
      if (key === 'MAIN_AGENT_CONFIG_DIR') {
        // A gepen MEGLEVO Claude-config konyvtarak. A beallitas csak LETEZO
        // konyvtarra ervenyes (kulonben no-op + figyelmeztetes a logban),
        // ezert kizarolag letezoket kinalunk fel.
        const home = os.homedir()
        options.push({
          value: '',
          label: 'Kozos ~/.claude (alapertelmezes)',
          hint: 'A fo agens ugyanazt a Claude-bejelentkezest hasznalja, mint a tobbi.',
        })
        let names: string[] = []
        try { names = fs.readdirSync(home) } catch { names = [] }
        for (const name of names.sort()) {
          if (!name.startsWith('.claude')) continue
          const full = path0.join(home, name)
          let isDir = false
          try { isDir = fs.statSync(full).isDirectory() } catch { isDir = false }
          if (!isDir) continue
          if (full === path0.join(home, '.claude')) continue
          const hasCreds = fs.existsSync(path0.join(full, '.credentials.json'))
          options.push({
            value: full,
            label: full,
            hint: hasCreds
              ? 'Sajat bejelentkezes van benne -- ez kell, ha a botnak kulon Claude-fiokja van.'
              : 'Nincs benne bejelentkezes (.credentials.json) -- ide meg be kell lepni.',
          })
        }
        if (options.length === 1) {
          note = 'Ezen a gepen nincs kulon Claude config-konyvtar. Ha a botnak sajat fiokot akarsz, eloszor hozz letre egyet (pl. ~/.claude-bot) es lepj be vele.'
        }
      } else if (key === 'HEARTBEAT_CALENDAR_ACCOUNT') {
        const { accounts, default: def } = googleAccountNames()
        options.push({
          value: '',
          label: def ? 'Alapertelmezett fiok (' + def + ')' : 'Alapertelmezett fiok',
          hint: 'Ures = amelyik fiok epp az alapertelmezett. Ez a legtobb esetben jo.',
        })
        for (const a of accounts) {
          options.push({ value: a, label: a, hint: a === def ? 'Ez most az alapertelmezett.' : undefined })
        }
        if (!accounts.length) {
          note = 'Nincs bekotott Google-fiok. Eloszor kosd be a Kapcsolatok oldalon, utana lesz mibol valasztani.'
        }
      } else if (key === 'HEARTBEAT_CALENDAR_ID') {
        options.push({
          value: 'primary',
          label: 'Sajat naptar (primary)',
          hint: 'A fiok fo naptara. Ha nem tudod, melyik kell, ez az.',
        })
        const account = ctx.url.searchParams.get('account')
          || String(getEffectiveSettingValue('HEARTBEAT_CALENDAR_ACCOUNT') || '')
          || ''
        const root = path0.resolve(path0.dirname(fileURLToPath(import.meta.url)), '../../..')
        const args = [path0.join(root, 'scripts', 'google-auth.py'), 'calendars']
        if (account) args.push(account)
        const out = await new Promise<string>((resolve) => {
          execFile('python3', args, { cwd: root, timeout: 15000 }, (err, stdout) => {
            resolve(err && !stdout ? '' : String(stdout || ''))
          })
        })
        let parsed: { error?: string; account?: string; calendars?: Array<Record<string, unknown>> } | null = null
        try { parsed = JSON.parse(out.trim() || '{}') } catch { parsed = null }
        if (!parsed || parsed.error || !Array.isArray(parsed.calendars)) {
          note = parsed && parsed.error
            ? 'A naptarlista most nem kerdezheto le (' + String(parsed.error).slice(0, 120) + '). A "Sajat naptar" valasztas ettol meg mukodik.'
            : 'A naptarlista most nem kerdezheto le (nincs bekotott Google-fiok, vagy nem elerheto a halozat). A "Sajat naptar" valasztas ettol meg mukodik.'
        } else {
          for (const c of parsed.calendars) {
            if (!c || !c.id || c.primary) continue
            options.push({
              value: String(c.id),
              label: String(c.summary || c.id),
              hint: c.role === 'reader' ? 'Csak olvashato naptar.' : undefined,
            })
          }
          if (parsed.account) note = 'A(z) "' + parsed.account + '" fiok naptarai.'
        }
      } else if (key === 'OLLAMA_URL') {
        // Nem talalgatunk: VEGIGPROBALJUK a szoba johetoket, es megmondjuk,
        // melyik valaszol tenylegesen.
        const cands = new Set<string>([
          String(getEffectiveSettingValue('OLLAMA_URL') || ''),
          'http://localhost:11434',
          'http://127.0.0.1:11434',
        ])
        cands.delete('')
        try {
          // WSL-ben az Ollama gyakran a WINDOWS oldalon fut: a gazdagep IP-je
          // a resolv.conf-ban all.
          const rc = fs.readFileSync('/etc/resolv.conf', 'utf8')
          const m = rc.match(/nameserver\s+([0-9.]+)/)
          if (m) cands.add('http://' + m[1] + ':11434')
        } catch { /* nem WSL, vagy nincs resolv.conf -- nem baj */ }
        const probe = async (base: string): Promise<string | undefined> => {
          const ctrl = new AbortController()
          const timer = setTimeout(() => ctrl.abort(), 1200)
          try {
            const r = await fetch(base.replace(/\/+$/, '') + '/api/tags', { signal: ctrl.signal })
            if (!r.ok) return 'valaszol, de hibat ad'
            const d = await r.json() as { models?: unknown[] }
            const n = Array.isArray(d?.models) ? d.models.length : 0
            return 'valaszol -- ' + n + ' modell van rajta'
          } catch {
            return undefined
          } finally {
            clearTimeout(timer)
          }
        }
        const list = [...cands]
        const hints = await Promise.all(list.map(probe))
        list.forEach((u, i) => options.push({
          value: u,
          label: u,
          hint: hints[i] ? '[OK] ' + hints[i] : 'nem valaszol',
        }))
        if (!hints.some(Boolean)) {
          note = 'Egyik cimen sem valaszol az Ollama. A szemantikus emlek-kereseshez futnia kell (WSL-ben: ollama serve).'
        }
      } else {
        json(res, { key, options: [], note: '', supported: false })
        return true
      }
    } catch (err) {
      logger.warn('settings options failed for ' + key + ': ' + String(err))
      note = 'A lista lekerese nem sikerult. A mezo kezzel is kitoltheto.'
    }
    json(res, { key, options, note, supported: true })
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
      // A role assignment is a separate, additive edit: POSTing {role, agent}
      // changes only that role and leaves the generator designation alone, so
      // ticking "planner" on a card does not un-designate the generator. Read
      // it up front because it also changes WHO is a valid holder below: a
      // role (unlike the generator designation) can be held by a VS Code
      // code-bridge project, addressed as "vscode:<project>" (see
      // web/app.js cbRoleHolder) -- that string is never a fleet agent name,
      // so it must be checked against the code-bridge session table instead.
      const roleId = typeof body?.role === 'string' ? body.role.trim() : ''
      const clearing = body?.enabled === false || body?.agent === null || raw === ''
      if (!clearing) {
        const known = new Set(listBrokerCandidates().map((c) => c.agent))
        const codeBridgeProject = roleId && raw.startsWith('vscode:') ? raw.slice('vscode:'.length) : ''
        const validCodeBridgeHolder = codeBridgeProject !== '' && getCodeSession(codeBridgeProject) !== null
        if (!known.has(raw) && !validCodeBridgeHolder) {
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
