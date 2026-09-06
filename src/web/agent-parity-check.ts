// Startup guard for fleet parity (see src/agent-parity.ts for the why).
//
// Runs once per dashboard start, right after the hook backfill, and answers one
// question: does the main agent run anything the rest of the fleet does not?
// If it does, the install is back in the "one agent is special" state Boss
// outlawed, and someone has to know -- so this logs it and tells the owner on
// his channel, because a warning only he can find in a log file is how the
// previous three occurrences stayed invisible.
//
// It never edits settings: the fix is a template change (fleet-wide, permanent)
// or a declared exception, and a watcher quietly patching one install would
// hide the drift from the repo, which is where it must be fixed.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID, PROJECT_ROOT, STORE_DIR } from '../config.js'
import { agentSettingsPath } from './agent-scaffold.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { sendAlert } from './channel-monitor.js'
import {
  findParityDrift, describeParityDrift, hookScriptNames, unionHookScripts,
  mainAgentSettingsPaths, describeSkillLibraryParity,
  type ParityDrift, type SkillLibraryParity,
} from '../agent-parity.js'
import { skillLibraryParity } from './skill-library-parity.js'

const TEMPLATE_PATH = join(PROJECT_ROOT, 'templates', 'settings.json.template')
// Restarting is routine here, and an identical alert on every restart trains
// the owner to ignore it. The signature is the drift itself: a NEW drift alerts
// immediately, the same drift stays quiet until it is fixed (or grows).
const MARKER_PATH = join(STORE_DIR, 'agent-parity-alert.json')

function readJsonHooks(path: string): unknown {
  try {
    return (JSON.parse(readFileSync(path, 'utf-8')) as { hooks?: unknown }).hooks
  } catch {
    return null
  }
}

function signature(drift: ParityDrift[]): string {
  return drift.map(d => `${d.direction}:${d.script}`).sort().join(',')
}

function alreadyAlerted(sig: string): boolean {
  try {
    return (JSON.parse(readFileSync(MARKER_PATH, 'utf-8')) as { signature?: unknown }).signature === sig
  } catch {
    return false
  }
}

function rememberAlert(sig: string): void {
  try {
    atomicWriteFileSync(MARKER_PATH, JSON.stringify({ signature: sig, at: Date.now() }, null, 2))
  } catch { /* best-effort: at worst the same alert repeats on the next start */ }
}

/** Compare the main agent's hooks with the fleet template AND check that every
 *  agent shares the skill library; alert on either kind of gap. Both lists are
 *  empty when the fleet is uniform. */
export function checkAgentParity(): { drift: ParityDrift[]; skills: SkillLibraryParity } {
  // The skill check does not depend on the hook comparison, so it runs even
  // when the settings files are missing or unparseable -- an unreadable main
  // settings.json used to take the skill-library check down with it, hiding a
  // second, unrelated gap (lackor3's review).
  const skills = skillLibraryParity()
  // #202: the main agent's hooks come from the user file AND the project file.
  // Reading only the first is what let ledger-capture.py hide from this gate.
  const mainSettings = agentSettingsPath(MAIN_AGENT_ID)
  const mainPaths = mainAgentSettingsPaths(homedir(), PROJECT_ROOT)
  const comparable = existsSync(mainSettings) && existsSync(TEMPLATE_PATH)
  const mainScripts = comparable
    ? unionHookScripts(mainPaths.filter(p => existsSync(p)).map(readJsonHooks))
    : new Set<string>()
  const templateScripts = comparable ? hookScriptNames(readJsonHooks(TEMPLATE_PATH)) : new Set<string>()
  // A settings file we could not parse yields an empty set, which would read as
  // "everything is missing" and alert about the whole fleet. Say nothing rather
  // than cry wolf.
  const canCompare = mainScripts.size > 0 && templateScripts.size > 0

  const drift = canCompare ? findParityDrift(mainScripts, templateScripts) : []
  const sig = signature(drift) + '|skills:' + skills.verdict + ':' + skills.missing.slice().sort().join(',')
  // 'not_measured' is NOT silence: an unmeasured half used to leave this branch
  // as quiet as a clean one, and the caller then logged "parity verified".
  if (drift.length === 0 && skills.verdict === 'ok') {
    if (existsSync(MARKER_PATH)) rememberAlert('')
    return { drift, skills }
  }

  logger.warn({ parityDrift: drift, skills }, 'agent parity: a capability is not wired for every agent, or could not be measured')
  if (!alreadyAlerted(sig)) {
    const parts: string[] = []
    if (drift.length > 0) parts.push(describeParityDrift(drift))
    if (skills.verdict !== 'ok') parts.push(describeSkillLibraryParity(skills))
    // A fejlec kovesse a TENYT: egy meg nem elvegzett meres nem ugyanaz, mint
    // egy megmert elteres, es a ket allitas mas teendot kivan.
    const onlyUnmeasured = drift.length === 0 && skills.verdict === 'not_measured'
    sendAlert(
      (onlyUnmeasured
        ? '⚠️ Agens-paritas: NEM tudtam megmerni, hogy minden agens ugyanazt kapja-e. '
        : '⚠️ Agens-paritas: nem minden agens kapja meg ugyanazt. ')
      + parts.join('; ')
      + '. Szabaly: ami az egyik agensnek jar, az mindnek jar (CLAUDE.md, agens-paritas).',
    )
    rememberAlert(sig)
  }
  return { drift, skills }
}
