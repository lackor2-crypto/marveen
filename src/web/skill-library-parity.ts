// A kozos skill-konyvtar paritasa -- kulon modulban, hogy MERHETO legyen.
//
// Kartya 3119f0bc. A meres korabban a startup-ellenorzo belsejeben ult, ami a
// naplot es a tulajdonos csatornajat is behuzza; egy teszt nem tudta meghivni
// mellekhatas nelkul, ezert a skill-fel egyetlen elo tesztje egy skipIf mogott
// allt, ami worktree-ben es CI-ben egyarant kihagyta, az elo telepitesen pedig
// a suite el sem indul. Vagyis sose futott le sehol.
//
// Itt csak fajlrendszer van, se naplo, se ertesites: a teszt egyszeruen meghivja.
import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fleetSkillsDir } from './agent-scaffold.js'
import { AGENTS_BASE_DIR, agentConfigRoot, listAgentNames } from './agent-config.js'
import { summarizeSkillLibraryParity, type SkillLibraryParity } from '../agent-parity.js'

/** Agents whose .claude/skills is not the shared library -- or the reason we
 *  could not tell. ensureAgentSkills() links it on every startup, so a name in
 *  `missing` means the link could not be made (a real directory is in the way,
 *  or the filesystem refused the symlink) and that agent knows less than the
 *  rest of the fleet without saying so.
 *
 *  Every early return used to be an EMPTY LIST, which the caller read as "no
 *  gaps" -- see summarizeSkillLibraryParity for what that cost. Now each blind
 *  branch reports itself instead.
 */
export function skillLibraryParity(): SkillLibraryParity {
  const shared = fleetSkillsDir()
  if (!existsSync(shared)) {
    return summarizeSkillLibraryParity({ sharedLibraryExists: false, agents: null, missing: [] })
  }
  let sharedReal: string
  try {
    sharedReal = realpathSync(shared)
  } catch (err) {
    return summarizeSkillLibraryParity({
      sharedLibraryExists: true,
      sharedLibraryError: err instanceof Error ? err.message : String(err),
      agents: null,
      missing: [],
    })
  }
  let agents: string[] | null = null
  let agentsError: string | null = null
  // ASK THE SOURCE, DO NOT COUNT: listAgentNames() answers [] both when the
  // install genuinely has no sub-agent yet AND when the agents directory is not
  // there at all (a git worktree, a CI checkout -- `agents/` is untracked). The
  // first is a measured zero, the second is a blind one, and only the directory
  // itself can tell them apart.
  if (!existsSync(AGENTS_BASE_DIR)) {
    agentsError = `az agens-konyvtar nem letezik ezen a checkouton (${AGENTS_BASE_DIR})`
  } else {
    try {
      agents = listAgentNames()
    } catch (err) {
      agentsError = err instanceof Error ? err.message : String(err)
    }
  }
  const missing: string[] = []
  for (const name of agents ?? []) {
    const link = join(agentConfigRoot(name), '.claude', 'skills')
    try {
      if (realpathSync(link) !== sharedReal) missing.push(name)
    } catch {
      missing.push(name)
    }
  }
  return summarizeSkillLibraryParity({ sharedLibraryExists: true, agents, agentsError, missing })
}
