import { readRemovedDefaultTasks } from './scheduled-tasks-io.js'
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, statSync, cpSync, lstatSync, symlinkSync, rmSync, watchFile, unwatchFile } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import { PROJECT_ROOT, OWNER_NAME, MAIN_AGENT_ID, BOT_NAME, CHANNEL_PROVIDER, WEB_PORT, OWNER_DRIVE_FOLDER, APP_TZ, DASHBOARD_PUBLIC_URL, STORE_DIR, APP_LANG } from '../config.js'
import { channelStateDir } from '../channel-provider.js'
import { runAgent } from '../agent.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { agentDir, agentConfigRoot, listAgentNames, readAgentCapabilities, mainAgentEffectiveConfigDir } from './agent-config.js'
import { resolveProfilePlaceholders, type ProfileTemplate } from './profiles.js'
import { sanitizeCapabilityTag, CAPABILITY_TAG_MAX_PER_AGENT } from '../prompt-safety.js'
import { loadAutonomyConfig, isAdminAgent, effectiveLevel, MARVEEN_SELFDEV_KEY, type AutonomyConfig } from '../autonomy.js'

// Resolve the base URL agents should use to reach the dashboard API.
// DASHBOARD_PUBLIC_URL wins when set (distributed / k3s deployment); falls
// back to localhost for single-host installs. Exported so heartbeat-agent-
// scaffold and tests can import the same logic without duplicating it.
export function resolveDashboardOrigin(publicUrl: string, port: number | string): string {
  return (publicUrl || `http://localhost:${port}`).replace(/\/$/, '')
}

// Resolved once at module load; DASHBOARD_PUBLIC_URL requires a restart
// (see config-registry.ts `requiresRestart` flag), so a const is safe.
const dashboardOrigin = resolveDashboardOrigin(DASHBOARD_PUBLIC_URL, WEB_PORT)
// Dashboard token path emitted into generated CLAUDE.md curl examples.
// MUST be absolute: sub-agents run from agents/<name>/, where a relative
// `store/.dashboard-token` does not exist -- curl then sends an empty Bearer
// and every call 401s silently. Measured 2026-07-25: relative 401, absolute
// 200; this had been silently killing sub-agent memory saves and searches.
const tokenPath = join(PROJECT_ROOT, 'store', '.dashboard-token')

// Hook commands run under `/bin/sh -c` with a NON-interactive PATH. On nvm
// installs a bare `node` is not on that PATH, so the hook exits 127 -- which
// Claude Code treats as a NON-blocking error and lets the tool call through:
// the gate silently never enforces (atlas incident, 2026-07-30). process.execPath
// is the absolute binary of the node running this server, which by definition
// exists on the host that spawns the agents. Exported for unit tests.
export const HOOK_NODE_BIN = process.execPath

// The ONE way a gate hook command is assembled. Both halves are quoted:
// process.execPath with a space in it (native Windows `C:\Program Files`, a
// home directory with a space) would otherwise be split by `sh -c` at the
// space -- exit 127, silently non-enforcing, the exact failure this file
// exists to close. A single builder also keeps the injectors and every
// wired-already comparison byte-identical, so they cannot drift.
export function hookCommand(scriptPath: string): string {
  // The interpreter is checked before it is used, and a missing one BLOCKS.
  //
  // HOOK_NODE_BIN is process.execPath, which on a brew install is the
  // version-pinned real path (/opt/homebrew/Cellar/node@22/<version>/bin/node),
  // not the stable /opt/homebrew/bin/node symlink the launchd plist starts.
  // A `brew upgrade node@22` moves that directory, the burnt-in path goes
  // dangling, the hook exits 127 -- and 127 is exactly the non-blocking status
  // this whole file exists to stop, so the gate would go quiet again on a
  // different route (measured: the pinned path fails with 127 after a version
  // bump, the stable symlink survives).
  //
  // Burning the symlink instead is NOT the fix: nvm installs have no such
  // stable path outside the launchd PATH, which is the original defect. Making
  // the failure loud is install-manager agnostic and covers any future move.
  //
  // The message says the three things an operator needs: WHAT is missing, that
  // this is why the call is blocked (so a wall of blocked tools is not read as
  // some other breakage), and the way out -- restarting the dashboard reruns
  // the ensure* migrations, which rewrite the path. A blocking gate with no
  // stated way out is worse than a loud error.
  const miss = `governance-kapu: a hook interpretere nem talalhato (${HOOK_NODE_BIN}). A kapu ezert BLOKKOL. Javitas: inditsd ujra a dashboardot, az ujrairja a hook-utakat.`
  return `test -x "${HOOK_NODE_BIN}" || { echo "${miss}" >&2; exit 2; }; "${HOOK_NODE_BIN}" "${scriptPath}"`
}

// Wired-already predicate for the ensure* migrations: is `command` present in
// the serialized PreToolUse array? The command must be JSON-escaped before the
// includes() -- comparing the RAW string disagrees with the serialized form on
// any backslash path (Windows), where the check then never settles and every
// boot rewrites settings.json. Exported for unit tests.
export function hookCommandWired(ptuJson: string, command: string): boolean {
  return ptuJson.includes(JSON.stringify(command).slice(1, -1))
}

// Identity values the template substitution injects. Pulled out so the
// substitution is a pure, parameterizable function (the runtime binds these to
// config; tests can prove a non-default identity substitutes with no literal
// brand leak).
export interface TemplateIdentity {
  projectRoot: string
  mainAgentId: string
  botName: string
  ownerName: string
  webPort: number | string
}

// Pure substitution of the identity placeholders into a template body. Kept in
// sync with the install scripts' (install-macos.sh / install-linux.sh) sed
// substitutions, so a shipped template never seeds a foreign absolute path or
// name into a user's tree. {{INSTALL_DIR}} and {{PROJECT_ROOT}} both denote the
// install location.
export function substituteTemplatePlaceholders(content: string, id: TemplateIdentity): string {
  return content
    .replaceAll('{{PROJECT_ROOT}}', id.projectRoot)
    .replaceAll('{{INSTALL_DIR}}', id.projectRoot)
    .replaceAll('{{MAIN_AGENT_ID}}', id.mainAgentId)
    .replaceAll('{{BOT_NAME}}', id.botName)
    .replaceAll('{{OWNER_NAME}}', id.ownerName)
    .replaceAll('{{WEB_PORT}}', String(id.webPort))
}

export function resolveTemplatePlaceholders(content: string): string {
  return substituteTemplatePlaceholders(content, {
    projectRoot: PROJECT_ROOT,
    mainAgentId: MAIN_AGENT_ID,
    botName: BOT_NAME,
    ownerName: OWNER_NAME,
    webPort: WEB_PORT,
  })
}

// Return the settings.json path for an agent.
// The main agent's settings live in the config dir it ACTUALLY runs on --
// mainAgentEffectiveConfigDir() (explicit MAIN_AGENT_CONFIG_DIR, else the
// fleet-isolated .channels-config once provisioned, else the shared ~/.claude).
// It was hardcoded to ~/.claude before #290 isolated the main agent onto a
// separate CLAUDE_CONFIG_DIR; the hardcode then wrote every hook to a file the
// running agent no longer reads, so NO fleet hook reached the main agent.
// Sub-agents keep their per-agent project settings under agents/<name>/.claude.
// Exported so the startup self-heal (hook-registration-guard) can prune stale
// entries from the same files this module writes.
export function agentSettingsPath(name: string): string {
  if (name === MAIN_AGENT_ID) return join(mainAgentEffectiveConfigDir(), 'settings.json')
  return join(agentDir(name), '.claude', 'settings.json')
}

/** The skill library every agent shares: the main agent's ~/.claude/skills,
 *  which is where the installer renders seed-skills/ with this install's own
 *  identity substituted in. */
export function fleetSkillsDir(): string {
  return join(homedir(), '.claude', 'skills')
}

/**
 * Give an agent the SAME skill library the main agent has, by linking its
 * project-level .claude/skills at the shared one.
 *
 * Boss, 2026-08-11: "egysegesnek kel lennie az agentek tudasanak". Until this
 * existed, seed-skills were rendered once at install time into ~/.claude/skills
 * -- the MAIN agent's config dir -- and no sub-agent ever saw them. A delegate
 * was therefore missing the very procedures it is judged by (kanban-card-creation,
 * host-agnostic-development, this repo's own rules), while the supervisor had
 * them all. Nothing reported the gap: each agent simply knew less.
 *
 * A symlink rather than a copy, deliberately: a copy is a fork that drifts the
 * moment a skill is patched (skills ARE patched at runtime -- see the skill-patch
 * rule in CLAUDE.md), and the fleet would silently split into per-agent
 * dialects again, which is the bug this fixes.
 *
 * Safety: never touches a real directory that already holds an agent's own
 * skills, and never links an agent to itself.
 *
 * The MAIN agent is linked too (Boss, 2026-08-25: "mutasson a kozosre a marveen
 * mappaja is"). Its project-level skills dir is PROJECT_ROOT/.claude/skills, a
 * DIFFERENT directory from the shared ~/.claude/skills; historically the main
 * agent was skipped here, so a skill it created via the dashboard landed in that
 * project dir and no sub-agent ever saw it -- the exact "one agent knows more"
 * asymmetry agent-parity exists to kill. The only case still skipped is when the
 * two paths are literally the same (an install whose repo root IS the home dir),
 * which would be linking a directory to itself.
 */
export function ensureAgentSkills(name: string): boolean {
  const shared = fleetSkillsDir()
  if (!existsSync(shared)) return false
  // Project-level skills live under <cwd>/.claude/skills, next to the agent's
  // settings.json -- the same directory Claude Code reads for this agent.
  const claudeDir = join(agentConfigRoot(name), '.claude')
  const link = join(claudeDir, 'skills')
  // A directory cannot be symlinked to itself: skip when the project-level dir
  // resolves to the shared library's own path.
  if (resolve(link) === resolve(shared)) return false
  try {
    const current = lstatSync(link, { throwIfNoEntry: false })
    if (current) {
      // Already linked (to anywhere): leave it alone -- re-pointing an operator's
      // deliberate link is not this function's business.
      if (current.isSymbolicLink()) return false
      // A real directory that holds NO actual skills is just the scaffold's
      // placeholder (every agent is created with one), and leaving it is what
      // kept the whole OpenRouter pool -- and, per Boss 2026-08-25, the MAIN
      // agent -- skill-less. Replacing it loses nothing. "Holds no skills"
      // ignores dotfiles: a skill is a subdirectory with a SKILL.md, never a
      // dotfile, and the generated `.skill-index.md` alone must NOT count as
      // content (that exact file blocked this conversion on the live main dir).
      if (current.isDirectory() && readdirSync(link).every(e => e.startsWith('.'))) {
        rmSync(link, { recursive: true, force: true })
        symlinkSync(shared, link, 'dir')
        return true
      }
      // A real directory with the agent's own skills in it: linking would hide
      // them. Report nothing and let the parity check surface it instead.
      return false
    }
    mkdirSync(claudeDir, { recursive: true })
    symlinkSync(shared, link, 'dir')
    return true
  } catch {
    // Best-effort: a filesystem that refuses symlinks must not break startup.
    return false
  }
}

// Volatile tmpfs prefixes: a hook command referencing these directories is
// transient and must NOT be written into the shared ~/.claude/settings.json.
// When the /tmp directory disappears on the next reboot the referenced script
// is gone, python3/node exits non-zero, and Claude Code blocks every prompt --
// the 2026-07-14 silent fleet-freeze incident.
const _TMP_PREFIXES = ['/tmp/', '/var/tmp/', '/private/tmp/', '/dev/shm/']

// Shared hook-entry type used by ensureAgentHooks and upgradeLegacyHookCommands.
type HookEntry = {
  matcher?: string
  hooks?: Array<{ command?: string; type?: string; prompt?: string; timeout?: number; [k: string]: unknown }>
}

/**
 * Returns true when the command is unsafe to register in shared settings:
 *   (a) it references a path under a volatile tmpfs directory, OR
 *   (b) the script path it references does not currently exist on disk.
 *
 * Exported for unit tests. Used as a registration guard in all hook-injection
 * functions so that a scratchpad / staging checkout can never pollute the
 * fleet's shared ~/.claude/settings.json with stale paths.
 */
export function isUnsafeHookCommand(command: string): boolean {
  if (_TMP_PREFIXES.some((p) => command.includes(p))) return true
  const m = command.match(/\/[^\s'"]+\.(?:py|mjs|js|sh)\b/)
  if (m && !existsSync(m[0])) return true
  return false
}

/** Extracts the script file basename from a hook command string (e.g. "staleness-guard.py"). */
function _hookScriptBasename(command: string): string | null {
  const m = command.match(/\/([^/\s'"]+\.(?:py|mjs|js|sh))\b/)
  return m ? m[1] : null
}

/**
 * In-place upgrade: for each hook command in tplHooks, if an existing hook in
 * existingHooks references the same script basename but in a different form
 * (e.g. bare `python3 /path/staleness-guard.py` vs the fail-open wrapper), the
 * existing command is replaced with the template form. No-op when the command
 * already matches exactly (idempotent).
 *
 * This runs as the first pass inside ensureAgentHooks so that legacy bare
 * commands are upgraded automatically on every startup without any manual steps
 * -- satisfying the zero-touch migration requirement for upstream distribution.
 *
 * Exported for unit testing.
 */
export function upgradeLegacyHookCommands(
  existingHooks: Record<string, unknown>,
  tplHooks: Record<string, unknown>,
): boolean {
  let changed = false
  for (const [event, tplEntries] of Object.entries(tplHooks)) {
    const existEntries = existingHooks[event]
    if (!Array.isArray(existEntries)) continue
    for (const tplEntry of tplEntries as HookEntry[]) {
      for (const tplHook of tplEntry.hooks ?? []) {
        if (!tplHook.command || isUnsafeHookCommand(tplHook.command)) continue
        const tplBn = _hookScriptBasename(tplHook.command)
        if (!tplBn) continue
        for (const existEntry of existEntries as HookEntry[]) {
          for (const existHook of existEntry.hooks ?? []) {
            if (!existHook.command) continue
            const existBn = _hookScriptBasename(existHook.command)
            if (existBn === tplBn && existHook.command !== tplHook.command) {
              existHook.command = tplHook.command
              if (tplHook.timeout != null) existHook.timeout = tplHook.timeout
              changed = true
            }
          }
        }
      }
    }
  }
  return changed
}

/**
 * Sync prompt-carrying hooks (`type: "agent"`, e.g. the PreCompact checkpoint)
 * from the template into an agent's settings.
 *
 * Why this exists (found 2026-08-12, kanban 55af1bfe): every other merge pass in
 * ensureAgentHooks keys on `hook.command`. A `type: "agent"` hook has no command
 * -- only a prompt -- so it matched nothing: the upgrade pass skipped it, the add
 * pass filtered it out (`h.command && ...`), and the timeout sync never saw it.
 * The practical effect was that the PreCompact prompt was copied into each
 * agent's settings.json once, at scaffold time, and then FROZE there forever.
 * Editing templates/settings.json.template -- documented as the single source of
 * truth for fleet-wide hooks -- silently changed nothing for every existing
 * agent. Confirmed on the live fleet: main, lackor3 and usalackor all still
 * carried the original prompt.
 *
 * Matching is by event + matcher, then by hook type: at most one agent-type hook
 * per entry is expected. The template wins, deliberately -- a per-agent edit of
 * a fleet-wide prompt is exactly the divergence the parity rule forbids.
 *
 * For the same reason the template is authoritative about WHICH matchers exist:
 * an agent-type hook sitting under a matcher the template no longer declares is
 * dropped. Without that, widening a matcher (the PreCompact checkpoint went from
 * `auto` to `auto|manual` so a hand-typed /compact also checkpoints) would leave
 * the old narrow entry in place beside the new one and fire the hook twice on an
 * automatic compact.
 *
 * Exported for unit testing.
 */
export function syncAgentPromptHooks(
  existingHooks: Record<string, unknown>,
  tplHooks: Record<string, unknown>,
): boolean {
  let changed = false
  for (const [event, tplEntriesRaw] of Object.entries(tplHooks)) {
    const tplEntries = tplEntriesRaw as HookEntry[]
    const existEntries = existingHooks[event]
    if (!Array.isArray(existEntries)) continue

    // Prune pass: drop every agent-type hook the template no longer declares
    // under this event. The outer loop only visits events the template DOES
    // declare, so an event we say nothing about is still left completely alone.
    const tplPromptMatchers = new Set(
      tplEntries
        .filter((e) => (e.hooks ?? []).some((h) => h.type === 'agent' && typeof h.prompt === 'string'))
        .map((e) => e.matcher ?? ''),
    )
    // Deliberately UNGUARDED. This used to read `if (tplPromptMatchers.size > 0)`,
    // which made the prune unreachable precisely when it matters: converting a
    // hook away from `type: "agent"` empties the set, so the obsolete prompt
    // hook would survive in every agent's settings.json forever and keep firing
    // beside its replacement. That is what the PreCompact checkpoint hit
    // (kanban #128): an agent-type hook cannot run outside the REPL at all, so
    // it failed on every compaction, and no template edit could remove it.
    {
      const entries = existEntries as HookEntry[]
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i]
        if (tplPromptMatchers.has(entry.matcher ?? '')) continue
        const kept = (entry.hooks ?? []).filter((h) => h.type !== 'agent')
        if (kept.length === (entry.hooks ?? []).length) continue
        changed = true
        if (kept.length === 0) entries.splice(i, 1)
        else entry.hooks = kept
      }
    }

    for (const tplEntry of tplEntries) {
      const tplPromptHooks = (tplEntry.hooks ?? []).filter((h) => h.type === 'agent' && typeof h.prompt === 'string')
      if (tplPromptHooks.length === 0) continue
      const sameMatcher = (existEntries as HookEntry[]).filter((e) => (e.matcher ?? '') === (tplEntry.matcher ?? ''))
      for (const tplHook of tplPromptHooks) {
        let landed = false
        for (const existEntry of sameMatcher) {
          for (const existHook of existEntry.hooks ?? []) {
            if (existHook.type !== 'agent') continue
            landed = true
            if (existHook.prompt !== tplHook.prompt) {
              existHook.prompt = tplHook.prompt
              changed = true
            }
            if (tplHook.timeout != null && existHook.timeout !== tplHook.timeout) {
              existHook.timeout = tplHook.timeout
              changed = true
            }
          }
        }
        if (!landed) {
          // The agent has this event but no agent-type hook in it at all.
          ;(existEntries as HookEntry[]).push({ ...tplEntry, hooks: [tplHook] })
          changed = true
        }
      }
    }
  }
  return changed
}

/**
 * Widen an existing command hook's matcher to the template's, by exact command
 * string. A command hook is moved OUT of its stale-matcher group into the group
 * that already carries the template's matcher (creating one if none exists);
 * a group left empty afterwards is dropped. Siblings in the old group that are
 * not in the template (or belong under a different matcher) are left alone.
 *
 * Why this exists (kanban d345eb2c / #207, 2026-09-05): PR #17 widened
 * templates/settings.json.template's SessionStart matcher for
 * taskstate-replay.py from "compact|resume" to "startup|compact|resume" (a
 * fresh startup needs the same pending-work replay a compact/resume gets).
 * ensureAgentHooks' add-pass below only ADDS a hook whose exact command string
 * is missing from the event -- since taskstate-replay.py's command was already
 * present (just under the narrow matcher), the add-pass saw nothing to do and
 * the live fleet kept the stale matcher through every restart since. Confirmed
 * live: all 9 deployed agents still carried "compact|resume" days after the
 * template fix shipped. syncAgentPromptHooks already solved this exact class of
 * bug for `type: "agent"` prompt hooks (kanban 55af1bfe); this generalizes it to
 * `type: "command"` hooks. Runs after upgradeLegacyHookCommands so a legacy
 * bare-form command has already been normalized to the template's exact string.
 *
 * Exported for unit testing.
 */
export function syncAgentHookMatchers(
  existingHooks: Record<string, unknown>,
  tplHooks: Record<string, unknown>,
): boolean {
  let changed = false
  for (const [event, tplEntriesRaw] of Object.entries(tplHooks)) {
    const existEntries = existingHooks[event]
    if (!Array.isArray(existEntries)) continue
    const entries = existEntries as HookEntry[]
    const targets = new Map<string, HookEntry>()

    for (const tplEntry of tplEntriesRaw as HookEntry[]) {
      const matcherKey = tplEntry.matcher ?? ''
      for (const tplHook of tplEntry.hooks ?? []) {
        if (!tplHook.command) continue
        for (const entry of entries) {
          if ((entry.matcher ?? '') === matcherKey) continue
          const hooks = entry.hooks ?? []
          const idx = hooks.findIndex((h) => h.command === tplHook.command)
          if (idx === -1) continue
          const [hook] = hooks.splice(idx, 1)
          let target = targets.get(matcherKey) ?? entries.find((e) => (e.matcher ?? '') === matcherKey)
          if (!target) {
            target = { matcher: tplEntry.matcher, hooks: [] }
            entries.push(target)
          }
          targets.set(matcherKey, target)
          if (!target.hooks) target.hooks = []
          target.hooks.push(hook)
          changed = true
        }
      }
    }

    for (let i = entries.length - 1; i >= 0; i--) {
      if ((entries[i].hooks ?? []).length === 0) entries.splice(i, 1)
    }
  }
  return changed
}

// Idempotent migration: every agent's settings.json should carry the
// PreCompact hook (memory save + skill reflection). Pre-refactor agents
// were scaffolded before scaffoldAgentDir seeded the template, so their
// file is permissions-only. Merge the template's hooks block in place.
// Also handles the main agent (MAIN_AGENT_ID) whose settings.json lives in the
// config dir it actually runs on (mainAgentEffectiveConfigDir) -- voice hook is
// added alongside existing hooks.
export function ensureAgentHooks(name: string): boolean {
  const settingsPath = agentSettingsPath(name)
  const tplPath = join(PROJECT_ROOT, 'templates', 'settings.json.template')
  if (!existsSync(tplPath)) return false
  let tpl: Record<string, unknown>
  try {
    const raw = resolveTemplatePlaceholders(readFileSync(tplPath, 'utf-8'))
    tpl = JSON.parse(raw)
  } catch {
    return false
  }
  if (!tpl.hooks) return false
  let existing: Record<string, unknown> = {}
  if (existsSync(settingsPath)) {
    try { existing = JSON.parse(readFileSync(settingsPath, 'utf-8')) } catch { /* overwrite */ }
  }
  const tplHooks = tpl.hooks as Record<string, unknown>
  if (existing.hooks) {
    // Merge strategy:
    //   0. Upgrade pass: in-place replace any legacy bare hook commands with the
    //      fail-open wrapper form (basename-matched). This runs before the add pass
    //      so the exact-match dedup in step 2 sees the upgraded commands and skips
    //      them -- avoiding the double-entry bug where the wrapper is added alongside
    //      the old bare command.
    //   0.5. Matcher-widen pass: move a command hook that already exists but under
    //      a stale matcher into the group with the template's matcher (kanban #207) --
    //      otherwise step 2's exact-command dedup would see the command as "already
    //      present" and never touch its matcher.
    //   1. If a hook event is entirely missing: add it wholesale.
    //   2. If the event exists: add any template hook commands not yet present
    //      as a new hook group entry (preserves existing hooks like telegram_progress.py).
    //   3. Sync the timeout of any command hook whose command matches but timeout differs.
    const existingHooks = existing.hooks as Record<string, unknown>
    let changed = upgradeLegacyHookCommands(existingHooks, tplHooks)
    if (syncAgentHookMatchers(existingHooks, tplHooks)) changed = true
    // Prompt-carrying (type:agent) hooks are command-less, so the command-keyed
    // passes below cannot see them. Sync them from the template first.
    if (syncAgentPromptHooks(existingHooks, tplHooks)) changed = true
    for (const [event, handlers] of Object.entries(tplHooks)) {
      if (!existingHooks[event]) {
        existingHooks[event] = handlers
        changed = true
      } else {
        const tplEntries = handlers as HookEntry[]
        const existEntries = existingHooks[event] as HookEntry[]
        // Collect all command strings already present in this event's hook groups.
        const existingCommands = new Set(
          existEntries.flatMap((e) => (e.hooks ?? []).map((h) => h.command).filter(Boolean)),
        )
        for (const tplEntry of tplEntries) {
          // Add hooks that are missing AND safe to register (registration guard).
          const newHooks = (tplEntry.hooks ?? []).filter(
            (h) => h.command && !existingCommands.has(h.command) && !isUnsafeHookCommand(h.command),
          )
          if (newHooks.length > 0) {
            existEntries.push({ ...tplEntry, hooks: newHooks })
            changed = true
          }
          // Sync timeouts for hooks that already exist with a stale timeout.
          for (const tplHook of tplEntry.hooks ?? []) {
            if (!tplHook.command || tplHook.timeout == null) continue
            for (const existEntry of existEntries) {
              for (const existHook of existEntry.hooks ?? []) {
                if (existHook.command === tplHook.command && existHook.timeout !== tplHook.timeout) {
                  existHook.timeout = tplHook.timeout
                  changed = true
                }
              }
            }
          }
        }
      }
    }
    if (!changed) return false
  } else {
    // No hooks yet: seed from template, filtering unsafe commands before writing.
    const safeHooks: Record<string, unknown> = {}
    for (const [event, entries] of Object.entries(tplHooks)) {
      const safeEntries = (entries as HookEntry[]).map((entry) => ({
        ...entry,
        hooks: (entry.hooks ?? []).filter((h) => !h.command || !isUnsafeHookCommand(h.command)),
      })).filter((entry) => (entry.hooks?.length ?? 0) > 0)
      if (safeEntries.length > 0) safeHooks[event] = safeEntries
    }
    existing.hooks = safeHooks
  }
  // Ensure the settings.json's directory exists before writing. Sub-agents need
  // their agents/<name>/.claude created; the main agent's effective config dir
  // (mainAgentEffectiveConfigDir) already exists at runtime (the launcher
  // provisioned it, or it is the shared ~/.claude), but mkdir is idempotent and
  // guards the case where the isolated dir was configured but not yet populated.
  mkdirSync(dirname(settingsPath), { recursive: true })
  atomicWriteFileSync(settingsPath, JSON.stringify(existing, null, 2))
  return true
}

/**
 * Idempotent migration: carry the template's `permissions.defaultMode` into the
 * OWNER'S OWN Claude Code settings (~/.claude/settings.json) when nobody ever set
 * it. That file is what an interactive session -- VS Code, a terminal `claude` --
 * reads, and those sessions are the ones that prompt.
 *
 * WHY. install-linux.sh writes defaultMode=bypassPermissions at install time,
 * but an install that only UPGRADES (git pull) never ran that step, and
 * install-macos.sh did not write it at all before 2026-09-24. ensureAgentHooks
 * merges only the `hooks` block, so nothing ever filled the gap and nothing
 * said so. Measured 2026-09-13: the owner's ~/.claude/settings.json had no
 * defaultMode while the template and the installer carried bypassPermissions,
 * and a WSL VS Code session asked for permission on every command all day.
 *
 * WHY ONLY THIS FILE, NOT EVERY AGENT. The fleet's channel sessions are started
 * with --dangerously-skip-permissions (agent-process.ts), and a sub-agent's
 * `permissions` block is rewritten from its security profile on every launch
 * (writeAgentSettingsFromProfile) -- a value written here would be wiped on the
 * next start, and for a `strict` profile it would even undercut the allow/deny
 * list the profile is there to enforce.
 *
 * ABSENT IS NOT THE SAME AS CHOSEN. The value is set ONLY when the key is
 * missing. Any existing value -- "acceptEdits", "auto", "default", even "" --
 * is the owner's decision and stays: install-linux.sh documents exactly that
 * as the way to take the automation back, and a boot job that overwrote it
 * would silently undo the opt-out on every restart.
 */
export function decidePermissionMode(
  existing: Record<string, unknown>,
  want: unknown,
): Record<string, unknown> | null {
  if (typeof want !== 'string' || want === '') return null
  const perms = (existing.permissions ?? {}) as Record<string, unknown>
  if (perms.defaultMode != null) return null
  return { ...existing, permissions: { ...perms, defaultMode: want } }
}

export function userClaudeSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.json')
}

export function ensureUserPermissionMode(settingsPath: string = userClaudeSettingsPath()): boolean {
  const tplPath = join(PROJECT_ROOT, 'templates', 'settings.json.template')
  if (!existsSync(tplPath)) return false
  let want: unknown
  try {
    const tpl = JSON.parse(resolveTemplatePlaceholders(readFileSync(tplPath, 'utf-8')))
    want = (tpl?.permissions as Record<string, unknown> | undefined)?.defaultMode
  } catch {
    return false
  }
  let existing: Record<string, unknown> = {}
  if (existsSync(settingsPath)) {
    try {
      existing = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    } catch {
      // Unreadable settings: leave a hand-edited file we cannot parse alone.
      return false
    }
  }
  const next = decidePermissionMode(existing, want)
  if (!next) return false
  mkdirSync(dirname(settingsPath), { recursive: true })
  atomicWriteFileSync(settingsPath, JSON.stringify(next, null, 2))
  return true
}

// Idempotent migration: ensure the staleness-guard UserPromptSubmit hook is
// present. Unlike ensureAgentHooks (which seeds the WHOLE hooks block only for
// hook-less agents), this MERGES a single UserPromptSubmit entry into an agent
// that already has other hooks -- so the guard reaches the existing fleet, not
// just freshly-scaffolded agents. The guard warns the agent when an inbound
// <channel ts="..."> message was delivered long after it was sent (a lagged /
// re-delivered message that may be stale), so it re-confirms before irreversible
// actions. Re-running is a no-op once the entry exists (matched by command path).
// Fail-open wrapper: if the script file is missing (e.g. after a /tmp checkout is
// cleaned up), the bash test exits 0 instead of letting python3 exit non-zero and
// blocking the prompt. Intentional policy blocks (the script exists and returns
// non-zero) are still propagated via exec. The script path appears twice so the
// guard regex below can still match it.
const _stalenessScript = join(PROJECT_ROOT, 'scripts', 'hooks', 'staleness-guard.py')
const STALENESS_HOOK_CMD = `bash -c '[ -f ${_stalenessScript} ] && exec python3 ${_stalenessScript}; exit 0'`

export function ensureAgentStalenessHook(name: string): boolean {
  // agentSettingsPath() maps MAIN_AGENT_ID to its effective config dir's
  // settings.json (mainAgentEffectiveConfigDir); using agentDir() directly here
  // would create a spurious agents/<main> dir and make the main agent show up as
  // a phantom "down" agent on the dashboard.
  const settingsPath = agentSettingsPath(name)
  let settings: Record<string, unknown> = {}
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) } catch { return false }
  }
  const hooks = (settings.hooks && typeof settings.hooks === 'object')
    ? settings.hooks as Record<string, unknown>
    : {}
  const ups = Array.isArray(hooks.UserPromptSubmit) ? hooks.UserPromptSubmit as unknown[] : []
  // Idempotency: already wired if any command entry references the guard script.
  const already = JSON.stringify(ups).includes('staleness-guard.py')
  if (already) return false
  // Registration guard: don't write a /tmp or non-existent path into shared settings.
  if (isUnsafeHookCommand(STALENESS_HOOK_CMD)) return false
  ups.push({ hooks: [{ type: 'command', command: STALENESS_HOOK_CMD, timeout: 10 }] })
  hooks.UserPromptSubmit = ups
  settings.hooks = hooks
  // Main agent's ~/.claude already exists; only sub-agent dirs need creating.
  if (name !== MAIN_AGENT_ID) mkdirSync(join(agentDir(name), '.claude'), { recursive: true })
  atomicWriteFileSync(settingsPath, JSON.stringify(settings, null, 2))
  return true
}

export function writeAgentSettingsFromProfile(name: string, profile: ProfileTemplate): void {
  const agentRoot = agentDir(name)
  const settingsDir = join(agentRoot, '.claude')
  const settingsPath = join(settingsDir, 'settings.json')
  mkdirSync(settingsDir, { recursive: true })
  let existing: Record<string, unknown> = {}
  if (existsSync(settingsPath)) {
    try { existing = JSON.parse(readFileSync(settingsPath, 'utf-8')) } catch { /* overwrite */ }
  }
  const ctx = { HOME: homedir(), AGENT_DIR: agentRoot }
  existing.permissions = {
    allow: profile.filesystem.allow.map(p => resolveProfilePlaceholders(p, ctx)),
    deny: profile.filesystem.deny.map(p => resolveProfilePlaceholders(p, ctx)),
  }
  // Egress gate: applied to ALL agents including MAIN_AGENT_ID. WebFetch calls
  // that are not on the known API allowlist are hard-blocked and logged;
  // arbitrary web content must go through the quarantine-reader sub-agent. Every
  // agent can be hijacked via an injected WebFetch call, including the main one.
  //
  // The email-send + self-pace governance hard-gates that used to be wired here
  // for sub-agents were removed 2026-08-20 by the owner's decision (Telegram msg
  // 404): routing every sub-agent's email + scheduling through the main agent
  // made the main agent a single point of failure -- when its token/quota was
  // exhausted the whole fleet was blocked from work the others could still do.
  // ensureGovernanceGatesRemoved() strips any leftover gate wiring from existing
  // settings.json at startup.
  injectEgressGate(existing)
  atomicWriteFileSync(settingsPath, JSON.stringify(existing, null, 2))
}

// Governance gate tool-name denials + hook basenames, retained here ONLY so
// ensureGovernanceGatesRemoved() knows what to strip from settings.json files
// that were written before the 2026-08-20 removal. Nothing wires these anymore.
const LEGACY_SELF_PACE_TOOL_DENY = ['ScheduleWakeup', 'CronCreate', 'CronDelete', 'CronList', 'RemoteTrigger']
const LEGACY_GOVERNANCE_GATE_SCRIPTS = ['email-send-gate.mjs', 'self-pace-gate.mjs']

// Idempotently wire the egress-gate PreToolUse hook (hard-blocks WebFetch to
// any URL not on the known API allowlist, logs blocked calls). Applied to ALL
// agents including MAIN_AGENT_ID -- the hook defends against prompt-injection
// that exfiltrates data via an outbound WebFetch, and the main agent faces the
// same risk as sub-agents. Same dedupe shape as the other gate injectors.
export function injectEgressGate(existing: Record<string, unknown>): void {
  const hooks = (existing.hooks && typeof existing.hooks === 'object'
    ? existing.hooks
    : (existing.hooks = {})) as Record<string, unknown>
  const command = hookCommand(join(PROJECT_ROOT, 'scripts', 'hooks', 'egress-gate.mjs'))
  // Registration guard: a /tmp or missing path must never enter shared settings.
  if (isUnsafeHookCommand(command)) return
  const entry = {
    matcher: 'WebFetch',
    hooks: [{ type: 'command', command, timeout: 10 }],
  }
  const prev = Array.isArray(hooks.PreToolUse) ? (hooks.PreToolUse as unknown[]) : []
  hooks.PreToolUse = [
    ...prev.filter((e) => !JSON.stringify(e).includes('egress-gate.mjs')),
    entry,
  ]
}

// Idempotent migration: ensure every agent's settings.json carries the egress
// gate hook. Called at server startup (alongside ensureAgentStalenessHook) so
// the hook is applied to both existing and newly-created agents without a full
// respawn. Returns true if the file was updated, false if already wired.
export function ensureEgressGate(name: string): boolean {
  const settingsPath = agentSettingsPath(name)
  let settings: Record<string, unknown> = {}
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) } catch { return false }
  }
  const command = hookCommand(join(PROJECT_ROOT, 'scripts', 'hooks', 'egress-gate.mjs'))
  const hooks = (settings.hooks && typeof settings.hooks === 'object')
    ? settings.hooks as Record<string, unknown>
    : {}
  const ptu = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse as unknown[] : []
  // Idempotency: already wired only if an entry references the egress-gate
  // script AND already uses the absolute node binary. A legacy bare-`node`
  // entry (dead on nvm PATHs, exit 127 = silently non-enforcing) must NOT
  // count as wired -- fall through so injectEgressGate replaces it in place.
  const ptuJson = JSON.stringify(ptu)
  if (ptuJson.includes('egress-gate.mjs') && hookCommandWired(ptuJson, command)) return false
  if (isUnsafeHookCommand(command)) return false
  injectEgressGate(settings)
  if (name !== MAIN_AGENT_ID) mkdirSync(join(agentDir(name), '.claude'), { recursive: true })
  atomicWriteFileSync(settingsPath, JSON.stringify(settings, null, 2))
  return true
}

// The domains the owner added for this install, from the egress allowlist.
// That file is the owner's gate for outbound calls; the reader's own list used
// to be a SECOND list of the same decision, kept by hand, and the two drifted:
// on 2026-07-29 an install had claude.com on the egress gate but not in the
// reader, so every fetch to it failed with "domain not on allowlist" while the
// operator was looking at an allowlist that said otherwise.
// A hostname the reader may be pointed at. The egress allowlist and the reader
// are edited with different threat models in mind: the egress gate answers "may
// the main agent call this host", where an owner adding their own dashboard or a
// LAN box is ordinary. The reader's list answers "may a fetch target be steered
// here", and that one is the backstop against a fetch being aimed inward -- the
// caller is the main agent, and the main agent is exactly what earlier fetched
// content can influence. So an entry that is fine on the gate is not
// automatically fine here, and the ones that are not are dropped rather than
// inherited silently.
//
// Rejected: IP literals of any kind (a fetch target is a name, and an address
// bypasses the name check entirely), single-label names, and the internal
// suffixes. That covers loopback, RFC1918, link-local (169.254.169.254 is the
// cloud metadata endpoint), `localhost`, `*` and anything with a scheme, port,
// path or space in it.
export function isPublicFetchHost(value: string): boolean {
  const host = value.trim().toLowerCase()
  if (!host || host.length > 253) return false
  if (/[^a-z0-9.-]/.test(host)) return false          // scheme, port, path, wildcard, space
  if (host.startsWith('.') || host.endsWith('.')) return false
  if (host.startsWith('-') || host.endsWith('-')) return false
  if (/^\d+(\.\d+)*$/.test(host)) return false        // IPv4 literal or a bare number
  const labels = host.split('.')
  if (labels.length < 2) return false                 // single label: localhost and friends
  if (labels.some((l) => !l || l.length > 63 || l.startsWith('-') || l.endsWith('-'))) return false
  const INTERNAL_SUFFIX = ['local', 'internal', 'localdomain', 'lan', 'intranet', 'home', 'arpa', 'test', 'invalid', 'localhost']
  if (INTERNAL_SUFFIX.includes(labels[labels.length - 1])) return false
  return true
}

export function ownerAllowedDomains(storeDir = STORE_DIR): string[] {
  try {
    const raw = JSON.parse(readFileSync(join(storeDir, 'egress-allowlist.json'), 'utf-8'))
    const list = Array.isArray(raw?.domains) ? raw.domains : []
    return list.filter((d: unknown): d is string => typeof d === 'string')
      .map((d: string) => d.trim())
      .filter((d: string) => isPublicFetchHost(d))
  } catch {
    return []   // no file, unreadable, or malformed: ship the template as-is
  }
}

// Render the reader definition: the template's shipped feeds, plus the domains
// the owner allowed on this install. Pure, so the tests drive the same string
// the deploy writes.
//
// Marker-delimited so a re-render replaces the previous block instead of
// stacking copies, and so a reader can see which lines are per-install.
export function renderQuarantineReader(template: string, domains: string[]): string {
  const BEGIN = '<!-- BEGIN PER-INSTALL DOMAINS (from store/egress-allowlist.json) -->'
  const END = '<!-- END PER-INSTALL DOMAINS -->'
  // Strip a previous block by literal position, NOT with a regex: the markers
  // contain parentheses, dots and a slash, and an unescaped RegExp turns
  // "(from store/egress-allowlist.json)" into a capture group that never
  // matches the literal text. First version of this shipped that bug and the
  // revoke test caught it.
  let stripped = template
  const b = stripped.indexOf(BEGIN)
  if (b >= 0) {
    const e = stripped.indexOf(END, b)
    if (e > b) {
      const from = b > 0 && stripped[b - 1] === '\n' ? b - 1 : b
      stripped = stripped.slice(0, from) + stripped.slice(e + END.length)
    }
  }
  const already = new Set(
    [...stripped.matchAll(/^- `([^`]+)`/gm)].map((m) => m[1].toLowerCase()))
  const extra = domains.filter((d) => !already.has(d.toLowerCase()))
  if (!extra.length) return stripped
  const block = [BEGIN, ...extra.map((d) => `- \`${d}\``), END].join('\n')
  // Anchor on the LAST bullet inside the Domain restriction section, not on the
  // last bullet in the file: the moment a backtick-bullet appears in any later
  // section, a file-wide anchor would silently relocate the per-install block
  // there. Raised in review on #797.
  const headingRx = /^##\s+Domain restriction\s*$/m
  const heading = headingRx.exec(stripped)
  const sectionStart = heading ? (heading.index ?? 0) + heading[0].length : 0
  const nextHeading = /^##\s+/m.exec(stripped.slice(sectionStart))
  const sectionEnd = nextHeading ? sectionStart + (nextHeading.index ?? 0) : stripped.length
  const section = stripped.slice(sectionStart, sectionEnd)
  const bullets = [...section.matchAll(/^- `[^`]+`.*$/gm)]
  if (!bullets.length) return stripped
  const last = bullets[bullets.length - 1]
  const at = sectionStart + (last.index ?? 0) + last[0].length
  return `${stripped.slice(0, at)}\n${block}${stripped.slice(at)}`
}

// Idempotent migration: STRIP the legacy governance hard-gates (email-send +
// self-pace) from an agent's settings.json. These gates were removed 2026-08-20
// by the owner's decision (Telegram msg 404) -- they made the main agent a
// single point of failure for outbound email and scheduling. New spawns never
// write them (writeAgentSettingsFromProfile no longer injects them), but an
// install that ran an older build still has them baked into every sub-agent's
// settings.json, so this self-heals those files at server startup.
// Removes (a) the two PreToolUse hook entries and (b) the self-pace tool-name
// denials from permissions.deny. NOTE: a running session does NOT re-read
// settings.json -- the change takes effect at that agent's next (re)spawn.
//
// The main agent is deliberately skipped: agentSettingsPath(MAIN_AGENT_ID)
// resolves to the user-global ~/.claude/settings.json, which is shared with
// every non-fleet Claude Code session on this machine and is hand-maintained by
// the owner. The gates were only ever written into sub-agent files, so there is
// nothing to strip there -- and a fleet migration must never rewrite the global
// file on a mere JSON round-trip.
// Returns true if the file was updated, false if there was nothing to strip.
export function ensureGovernanceGatesRemoved(name: string): boolean {
  if (name === MAIN_AGENT_ID) return false
  const settingsPath = agentSettingsPath(name)
  if (!existsSync(settingsPath)) return false
  let settings: Record<string, unknown> = {}
  try { settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) } catch { return false }
  let changed = false

  // (a) Drop the PreToolUse hook entries that reference either gate script.
  const hooks = (settings.hooks && typeof settings.hooks === 'object')
    ? settings.hooks as Record<string, unknown>
    : undefined
  if (hooks && Array.isArray(hooks.PreToolUse)) {
    const prev = hooks.PreToolUse as unknown[]
    const kept = prev.filter((e) => {
      const json = JSON.stringify(e)
      return !LEGACY_GOVERNANCE_GATE_SCRIPTS.some((s) => json.includes(s))
    })
    if (kept.length !== prev.length) {
      hooks.PreToolUse = kept
      changed = true
    }
  }

  // (b) Drop the self-pace tool-name denials from permissions.deny.
  const perms = (settings.permissions && typeof settings.permissions === 'object')
    ? settings.permissions as Record<string, unknown>
    : undefined
  if (perms && Array.isArray(perms.deny)) {
    const prev = perms.deny as unknown[]
    const kept = prev.filter((d) => !(typeof d === 'string' && LEGACY_SELF_PACE_TOOL_DENY.includes(d)))
    if (kept.length !== prev.length) {
      perms.deny = kept
      changed = true
    }
  }

  if (changed) atomicWriteFileSync(settingsPath, JSON.stringify(settings, null, 2))
  return changed
}

// Deploy the quarantine-reader sub-agent definition to an agent's
// .claude/agents/ directory. The template lives in templates/sub-agents/
// (tracked in git); the deployed copies are per-install runtime state.
//
// Writes when the rendered content differs from what is on disk, in EITHER
// direction. The previous docstring claimed "only when the template is newer",
// but the code compared contents, so a hand-edited deployed file was silently
// reverted at the next boot -- which is how an owner-approved domain
// disappeared on 2026-07-30. Now the owner's domains are an INPUT to the
// render, so a re-render preserves the decision instead of erasing it.
// Returns true if the file was written, false if already up-to-date.
export function ensureQuarantineReader(
  name: string,
  paths?: { tplPath?: string; destDir?: string; storeDir?: string },
): boolean {
  const tplPath = paths?.tplPath ?? join(PROJECT_ROOT, 'templates', 'sub-agents', 'quarantine-reader.md')
  if (!existsSync(tplPath)) return false
  const destDir = paths?.destDir ?? quarantineReaderDestDir(name)
  mkdirSync(destDir, { recursive: true })
  const destPath = join(destDir, 'quarantine-reader.md')
  let rendered: string
  try {
    rendered = renderQuarantineReader(readFileSync(tplPath, 'utf-8'), ownerAllowedDomains(paths?.storeDir))
  } catch {
    return false
  }
  let upToDate = false
  if (existsSync(destPath)) {
    try {
      upToDate = readFileSync(destPath, 'utf-8') === rendered
    } catch { /* unreadable -> treat as stale, re-write below */ }
  }
  if (!upToDate) writeFileSync(destPath, rendered)
  // The old user-scope copy (~/.claude/agents) is left alone on purpose: the
  // project-scoped copy wins for the main agent, and the owner's interactive
  // sessions outside the repo may still use the user-scope one. (Upstream
  // deletes it; this fork does not delete files it did not just write.)
  return !upToDate
}

// Where an agent's deployed quarantine-reader definition lives: PROJECT scope
// for EVERY agent, the main agent included. The runtime reads a project-scoped
// agent definition from disk at each sub-agent spawn, but caches a user-scoped
// (~/.claude/agents) one at session start -- so a domain the owner granted only
// reached the main agent's reader after a full session restart, and the stale
// prompt copy refused it without a network call (nothing in egress-blocked.log).
// Rebuilt from upstream 10e120ef / c2bce828 (EGRESSRENDER824).
export function quarantineReaderDestDir(name: string): string {
  if (name === MAIN_AGENT_ID) return join(PROJECT_ROOT, '.claude', 'agents')
  return join(agentDir(name), '.claude', 'agents')
}

// A grant typed into store/egress-allowlist.json reached the egress-gate HOOK
// at once (it reads the JSON live) but the reader PROMPT copies only at the
// next scaffold. This watcher re-renders every deployed copy on a JSON change.
// fs.watchFile (mtime polling): survives atomic replaces, needs no debounce.
// `opts` is for tests only. Returns a stop function.
export function watchEgressAllowlistForReaderRender(
  listAgents: () => string[],
  onRendered?: (agents: string[]) => void,
  opts?: { storeDir?: string; intervalMs?: number; ensure?: (name: string) => boolean },
): () => void {
  const allowlistPath = join(opts?.storeDir ?? STORE_DIR, 'egress-allowlist.json')
  const ensure = opts?.ensure ?? ((name: string) => ensureQuarantineReader(name))
  const listener = () => {
    const rendered: string[] = []
    for (const name of [MAIN_AGENT_ID, ...listAgents()]) {
      try {
        if (ensure(name)) rendered.push(name)
      } catch { /* per-agent best effort: one bad dir must not stop the rest */ }
    }
    if (rendered.length) onRendered?.(rendered)
  }
  watchFile(allowlistPath, { interval: opts?.intervalMs ?? 5000 }, listener)
  return () => unwatchFile(allowlistPath, listener)
}

// Copy the repo's `scheduled-tasks/<task>/task-config.json` to the
// destination with the `agent` field rewritten to the host's
// MAIN_AGENT_ID. The repo-side configs ship with `"agent": "marveen"`
// hardcoded (canonical default in src/config.ts) so a non-marveen
// install would otherwise scaffold tasks bound to an agent that does
// not exist and the scheduler would fire silently into the void on
// every tick. All other files in the task directory (SKILL.md, etc.)
// are byte-identical copies as before.
//
// The rewrite is conservative: it only touches the `agent` field, and
// only when the parsed JSON has one. A malformed task-config.json
// falls back to copyFileSync so the seed does not lose its file --
// the operator can then inspect and fix the JSON, rather than the
// scaffold silently dropping the task.
function copyTaskConfigWithAgentRewrite(srcPath: string, destPath: string): void {
  try {
    // #393: the placeholders ({{PROJECT_ROOT}}, {{INSTALL_DIR}}, ...) are
    // resolved here too, not only in SKILL.md -- a `preCheck` path shipped as
    // "{{PROJECT_ROOT}}/scripts/..." otherwise reached the scheduler verbatim,
    // was treated as a relative path, never ran, and every tick woke the model.
    const raw = resolveTemplatePlaceholders(readFileSync(srcPath, 'utf-8'))
    const cfg = JSON.parse(raw) as Record<string, unknown>
    if (typeof cfg.agent === 'string') {
      cfg.agent = MAIN_AGENT_ID
    }
    atomicWriteFileSync(destPath, JSON.stringify(cfg, null, 2) + '\n')
  } catch {
    // Malformed or unreadable: fall back to a byte copy so the file is
    // still seeded and the operator gets a chance to fix it.
    copyFileSync(srcPath, destPath)
  }
}

// #393: an already-seeded task-config.json may still carry an unresolved
// template placeholder (the seeders before this fix left them in). Resolve ONLY
// the literal placeholders -- every other byte, including the operator's own
// edits, stays as it is. Idempotent: a config without "{{" is not touched.
export function healTaskConfigPlaceholders(cfgPath: string): boolean {
  try {
    if (!existsSync(cfgPath)) return false
    const raw = readFileSync(cfgPath, 'utf-8')
    if (!raw.includes('{{')) return false
    const fixed = resolveTemplatePlaceholders(raw)
    if (fixed === raw) return false
    JSON.parse(fixed)
    atomicWriteFileSync(cfgPath, fixed)
    return true
  } catch {
    return false
  }
}

export function ensureDefaultScheduledTasks(): void {
  const repoTasks = join(PROJECT_ROOT, 'scheduled-tasks')
  if (!existsSync(repoTasks)) return
  const destRoot = join(homedir(), '.claude', 'scheduled-tasks')
  mkdirSync(destRoot, { recursive: true })
  // A default the operator deleted is tombstoned in .removed-defaults by the
  // DELETE route; the shell seed loops already honour it, and this seeder runs
  // on EVERY dashboard start, so without the check a deleted default came back
  // on the next restart. (Rebuilt from upstream #796.)
  const removed = readRemovedDefaultTasks()

  for (const taskName of readdirSync(repoTasks)) {
    const src = join(repoTasks, taskName)
    const dest = join(destRoot, taskName)
    if (!statSync(src).isDirectory()) continue
    if (removed.has(taskName) && !existsSync(dest)) continue
    if (existsSync(dest)) { healTaskConfigPlaceholders(join(dest, 'task-config.json')); continue }
    mkdirSync(dest, { recursive: true })
    for (const file of readdirSync(src)) {
      const srcFile = join(src, file)
      const destFile = join(dest, file)
      // A seeded task dir isn't always flat (e.g. bumblebee-hygiene-scan's
      // threat-intel/ subfolder) -- this used to silently skip any nested
      // directory instead of copying it (same bug class found and fixed in
      // the install-linux.sh/install-macos.sh seed loops, 2026-08-07).
      // cpSync recurses on its own; no placeholder substitution inside a
      // subdirectory, same as the install scripts only sed top-level files.
      if (statSync(srcFile).isDirectory()) { cpSync(srcFile, destFile, { recursive: true }); continue }
      if (file === 'task-config.json') {
        copyTaskConfigWithAgentRewrite(srcFile, destFile)
      } else {
        // Substitute the identity placeholders (same set the install scripts
        // sed) so a template's SKILL.md never seeds a foreign absolute path or
        // name into the user's task. Binary/unreadable -> fall back to a copy.
        try {
          writeFileSync(destFile, resolveTemplatePlaceholders(readFileSync(srcFile, 'utf-8')))
        } catch {
          copyFileSync(srcFile, destFile)
        }
      }
    }
  }
}

export function scaffoldAgentDir(name: string) {
  const dir = agentDir(name)
  mkdirSync(join(dir, '.claude', 'skills'), { recursive: true })
  mkdirSync(join(dir, '.claude', 'hooks'), { recursive: true })
  mkdirSync(join(dir, '.claude', 'agents'), { recursive: true })
  mkdirSync(channelStateDir(CHANNEL_PROVIDER, dir), { recursive: true })
  mkdirSync(join(dir, 'memory'), { recursive: true })

  // Deploy the quarantine-reader sub-agent definition from the template so every
  // scaffolded agent can use it for safe web/RSS fetching without calling WebFetch
  // directly in the main context (where untrusted content would run as instructions).
  ensureQuarantineReader(name)

  // Initialize empty files if they don't exist
  const memoryMd = join(dir, 'memory', 'MEMORY.md')
  if (!existsSync(memoryMd)) writeFileSync(memoryMd, '')
  const mcpJson = join(dir, '.mcp.json')
  if (!existsSync(mcpJson)) {
    // Copy shared MCP config so agents get access to common tools (e.g. aiam-blog)
    const sharedMcp = join(PROJECT_ROOT, '.mcp.json')
    if (existsSync(sharedMcp)) {
      copyFileSync(sharedMcp, mcpJson)
    } else {
      // Valid empty shape -- `claude /doctor` rejects plain "{}"
      atomicWriteFileSync(mcpJson, JSON.stringify({ mcpServers: {} }, null, 2))
    }
  }
  // Seed settings.json from template so the agent gets the PreCompact
  // hook (memory save + skill reflection) out of the box. Only if the
  // file doesn't exist yet -- user edits and later profile writes stay.
  const settingsJson = join(dir, '.claude', 'settings.json')
  if (!existsSync(settingsJson)) {
    const tplPath = join(PROJECT_ROOT, 'templates', 'settings.json.template')
    if (existsSync(tplPath)) {
      const resolved = resolveTemplatePlaceholders(readFileSync(tplPath, 'utf-8'))
      atomicWriteFileSync(settingsJson, resolved)
    }
  }
}

// HTML comment markers that delimit the auto-generated fleet roster block.
// Using HTML comments means they are invisible to the LLM when the CLAUDE.md
// is read as plain text, but are stable enough for regex replacement.
// Do NOT change the marker strings without a coordinated migration: existing
// CLAUDE.md files already contain them and ensureFleetRosterSection() relies
// on exact string matching for idempotent replacement.
const FLEET_ROSTER_BEGIN = '<!-- BEGIN GENERATED: fleet-roster (auto-generated, do not edit by hand) -->'
const FLEET_ROSTER_END = '<!-- END GENERATED: fleet-roster -->'

// Non-greedy ([\\s\\S]*?) so the regex stops at the FIRST occurrence of the
// end-marker. A greedy match would span from BEGIN all the way to the LAST
// END in the file, eating unrelated content in between.
const FLEET_ROSTER_BLOCK_RE = new RegExp(
  `${FLEET_ROSTER_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${FLEET_ROSTER_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
)

const ASKBACK_BEGIN = '<!-- BEGIN GENERATED: ask-back-rule (auto-generated, do not edit by hand) -->'
const ASKBACK_END = '<!-- END GENERATED: ask-back-rule -->'
const WAKE_GREETING_BEGIN = '<!-- BEGIN GENERATED: wake-greeting-rule (auto-generated, do not edit by hand) -->'
const WAKE_GREETING_END = '<!-- END GENERATED: wake-greeting-rule -->'
const WAKE_GREETING_BLOCK_RE = new RegExp(
  `${WAKE_GREETING_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${WAKE_GREETING_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
)

const RECHECK_BEGIN = '<!-- BEGIN GENERATED: recheck-rule (auto-generated, do not edit by hand) -->'
const RECHECK_END = '<!-- END GENERATED: recheck-rule -->'
const RECHECK_BLOCK_RE = new RegExp(
  `${RECHECK_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${RECHECK_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
)
const ASKBACK_BLOCK_RE = new RegExp(
  `${ASKBACK_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${ASKBACK_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
)

const DELEGATE_CHECK_BEGIN = '<!-- BEGIN GENERATED: delegate-availability-rule (auto-generated, do not edit by hand) -->'
const DELEGATE_CHECK_END = '<!-- END GENERATED: delegate-availability-rule -->'
const DELEGATE_CHECK_BLOCK_RE = new RegExp(
  `${DELEGATE_CHECK_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${DELEGATE_CHECK_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
)

const AUTONOMY_BEGIN = '<!-- BEGIN GENERATED: autonomy-wiring (auto-generated, do not edit by hand) -->'
const AUTONOMY_END = '<!-- END GENERATED: autonomy-wiring -->'
const AUTONOMY_BLOCK_RE = new RegExp(
  `${AUTONOMY_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${AUTONOMY_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
)

// --- AZONOSITAS ELOTT KOTELEZO ELLENORIZNI doktrina (Boss, 2026-09-08) ---
// Sajat markeres-blokk, mint a tobbi doktrina (ask-back, recheck, landing,
// one-card), hogy minden agens CLAUDE.md-jebe ES a gepszintu
// ~/.claude/CLAUDE.md-be is eljusson, visszamenoleg is -- nem csak
// telepiteskor. Valos eset (2026-09-08): lackor3 sajat korabbi uzenetet (VS
// Code kod-hid javitas + kanban landolas) tevesen Marvinnak tulajdonitotta a
// modellvaltas (Opus 4.8 -> Sonnet 5) utani session-ujrainditasban, mert a
// temabol talalgatott ahelyett hogy ellenorizte volna a forrast.
const AGENT_IDENTITY_BEGIN = '<!-- BEGIN GENERATED: agent-identity-rule (auto-generated, do not edit by hand) -->'
const AGENT_IDENTITY_END = '<!-- END GENERATED: agent-identity-rule -->'
const AGENT_IDENTITY_BLOCK_RE = new RegExp(
  `${AGENT_IDENTITY_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${AGENT_IDENTITY_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
)

const NO_LIVE_TREE_BEGIN = '<!-- BEGIN GENERATED: no-live-tree-rule (auto-generated, do not edit by hand) -->'
const NO_LIVE_TREE_END = '<!-- END GENERATED: no-live-tree-rule -->'
const NO_LIVE_TREE_BLOCK_RE = new RegExp(
  `${NO_LIVE_TREE_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${NO_LIVE_TREE_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
)

const COMPLETION_REPORT_BEGIN = '<!-- BEGIN GENERATED: completion-report-rule (auto-generated, do not edit by hand) -->'
const COMPLETION_REPORT_END = '<!-- END GENERATED: completion-report-rule -->'
const COMPLETION_REPORT_BLOCK_RE = new RegExp(
  `${COMPLETION_REPORT_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${COMPLETION_REPORT_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
)

const KANBAN_WAITING_MOVE_BEGIN = '<!-- BEGIN GENERATED: kanban-waiting-move-rule (auto-generated, do not edit by hand) -->'
const KANBAN_WAITING_MOVE_END = '<!-- END GENERATED: kanban-waiting-move-rule -->'
const KANBAN_WAITING_MOVE_BLOCK_RE = new RegExp(
  `${KANBAN_WAITING_MOVE_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${KANBAN_WAITING_MOVE_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
)

const CARD_REFERENCE_BEGIN = '<!-- BEGIN GENERATED: card-reference-by-number-rule (auto-generated, do not edit by hand) -->'
const CARD_REFERENCE_END = '<!-- END GENERATED: card-reference-by-number-rule -->'
const CARD_REFERENCE_BLOCK_RE = new RegExp(
  `${CARD_REFERENCE_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${CARD_REFERENCE_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
)

// Builds the text body that goes between the BEGIN/END markers.
// Single source of truth -- called by both generateClaudeMd() (initial
// generation) and ensureFleetRosterSection() (idempotent update on respawn).
//
// Threat model for capability tags:
// - Capability strings come from two external-input paths: the Bearer-gated
//   PUT /api/agents/:name/capabilities endpoint and user-editable persona
//   frontmatter. Both can contain arbitrary text.
// - Each tag ends up embedded in every PEER agent's CLAUDE.md, so a poisoned
//   capability could inject instructions into the prompt of another agent.
// - sanitizeCapabilityTag() DROPS (does not normalise) any value outside
//   /^[a-z0-9][a-z0-9-]{0,31}$/. No character substitution is allowed:
//   replace(/[^a-z0-9-]/g, '-') would silently turn "IGNORE ALL PREVIOUS
//   INSTRUCTIONS" into "ignore-all-previous-instructio" -- still 32 chars,
//   still passes the regex. DROP closes this path entirely.
//
// Why MAIN_AGENT_ID is always prepended:
// - listAgentNames() reads the agents/ directory; the main agent has no
//   subdirectory there (it lives in the project root). Without explicit
//   prepending, the main agent would be absent from every peer's roster.
function buildFleetRosterBody(selfName: string): string {
  let agentNames: string[]
  try {
    agentNames = listAgentNames()
  } catch {
    agentNames = []
  }

  // Ensure the main agent appears even though it has no agents/ subdirectory.
  const names = agentNames.includes(MAIN_AGENT_ID)
    ? agentNames
    : [MAIN_AGENT_ID, ...agentNames]

  const lines: string[] = []
  for (const agentName of names) {
    if (agentName === selfName) continue

    let rawCaps: string[]
    try {
      rawCaps = readAgentCapabilities(agentName)
    } catch {
      rawCaps = []
    }

    const caps = rawCaps
      .map(sanitizeCapabilityTag)
      .filter((c): c is string => c !== null)
      .slice(0, CAPABILITY_TAG_MAX_PER_AGENT)

    const capsStr = caps.length > 0 ? caps.join(', ') : '-'
    lines.push(`- **${agentName}** (agent_id: ${agentName}): ${capsStr}`)
  }

  const roster = lines.length > 0 ? lines.join('\n') : '(nincs regisztrált ágens)'

  return [
    '## A flotta többi agense',
    '',
    'Ez a lista automatikusan generálódik az ágens indulásakor, ez a mérvadó és naprakész forrás.',
    'Ha a fenti szövegben régebbi, kézzel írt felsorolás szerepel, ezt a szekciót vedd figyelembe.',
    '',
    roster,
    '',
    'Ha egy kérés egyértelműen más szakterületére esik, jelezd vagy delegáld inter-agent üzenettel a megfelelő ágensnek.',
  ].join('\n')
}

// Builds the autonomy-wiring section body. Per agent, and no longer static:
// since 2026-08-27 the block states THIS agent's own rights, because the fleet
// stopped being uniform on purpose.
//
// Boss, Telegram 593 and 595 (verbatim): "a jovoben soha ne kelljen ilyet
// csinalni hogy brmit jova kelljen hagyni nekem. csak mert a marveen t
// modositom. akarmelyik agenttel." and "kapjon az osszes agent admin jogot. es
// kesz. kiveve az ingyenes agenteket."
//
// Why the concrete list of still-gated categories is COMPUTED and written out
// rather than described in prose: an agent that reads "check the level before
// acting" has to go look it up, and the failure mode of not looking it up is
// silent -- it asks for an approval nobody wanted, or skips one that was due.
// The list below is the answer already resolved for this agent, from the same
// config the dashboard writes.
//
// A missing/unreadable config does NOT silently mean "no rights": it falls back
// to the generic text that tells the agent to read the levels itself, and says
// so.
function buildAutonomyBody(name: string): string {
  let config: AutonomyConfig | null = null
  try {
    config = loadAutonomyConfig()
  } catch {
    config = null
  }

  const admin = config ? isAdminAgent(name, config) : false
  const gated = config
    ? config.categories.filter((c) => effectiveLevel(c, name, config!) < 3)
    : []
  const selfdev = config?.categories.find((c) => c.key === MARVEEN_SELFDEV_KEY) ?? null

  const rights: string[] = []
  if (!config) {
    rights.push(
      '**A jogosultsagi fajl nem volt olvashato az utolso generalaskor** (store/autonomy-config.json hianyzik vagy serult), ezert ez a szekcio nem tudja megmondani a te szintjeidet. Ne tippelj: nezd meg magad a fajlt, es ha nincs meg, szolj a tulajdonosnak -- az update.sh a seed-config mappabol potolja.',
      '',
    )
  } else if (admin) {
    rights.push(
      '**A TE JOGOSULTSAGOD: ADMIN.** Nem a modelled es nem a fiokod korlatoz: ugyanaz jar neked, mint barmelyik masik agensnek. Amit a kategoria 3. szinten enged, azt elvegzed es utana jelented -- nem kersz ra engedelyt.',
      '',
      'Amit a kategoria alacsonyabb szinten tart, az viszont RAD IS vonatkozik: a szinteket a tulajdonos allitja a dashboard Beallitasok / Autonomia lapjan, es az ott latott szam az igazsag. Egyetlen agens sem fut magatol magasabb szinten, mint ami ott ki van irva (a tulajdonos, 2026-08-27: "amik ott be voltak allitva azokat allitsd vissza").',
      '',
      'A tulajdonos, 2026-08-27: "az admin jogon azt ertettem hogy az osszes ai en vagyok. ... mitol rosszabb mondjuk most a masik fiok mint marvin. tehat csak annyit ertettem rajta hogy vedd ki a kibaszott korlatozasokat." Ezert MINDEN agens admin, fuggetlenul attol, milyen (akar ingyenes) modellen fut: a modell a tulajdonos valasztasa, nem egy bizalmi kulonbseg.',
      '',
      '**Amit ez NEM tett meg:** a penzmozgas, a valodi cimzettnek meno uzenet (email, kifele meno uzenet, publikalas) es a torles elott tovabbra is el a KOTELEZO VISSZAKERDEZES szabalya. Az nem jovahagyas-keres az API-n, hanem egy kerdes a tulajdonoshoz a sajat csatornajan -- pontosan ez a kulonbseg, amit kert.',
      '',
    )
  } else {
    rights.push(
      '**A TE JOGOSULTSAGOD: ALAP -- a tulajdonos KEZZEL vette el toled az admin jogot** a dashboard Beallitasok / Autonomia lapjan. Az alapertelmezes minden agensnel admin, tehat ez nalad szandekos kivetel. Amig igy all, egyetlen kategorian sem cselekszel onallóan: ahol a kategoria 3-at mutat, ott is jovahagyast kersz elotte az API-n (2. szint). A 2. szinten allo kategoriak nalad ugyanugy jovahagyasosak, mint mindenki masnal.',
      '',
    )
  }

  if (selfdev && effectiveLevel(selfdev, name, config!) >= 3) {
    rights.push(
      '**Marveen sajat fejlesztesehez (kod, skill, szabaly, dashboard) NEM kell jovahagyas -- egyetlen agensnek sem.** A tulajdonos, 2026-08-27: "soha ne kelljen ilyet csinalni hogy brmit jova kelljen hagyni nekem. csak mert a marveen t modositom. akarmelyik agenttel." A kategoria kulcsa: ' + MARVEEN_SELFDEV_KEY + '. Ettol fuggetlenul KOTELEZO marad a kanban kartya es a teszt-verifikacio: az nem jovahagyas, hanem nyom.',
      '',
    )
  }

  if (config) {
    if (gated.length === 0) {
      rights.push('Nalad egyetlen kategoria sem igenyel jovahagyast az API-n.', '')
    } else {
      rights.push('**Ami NALAD meg igy is jovahagyashoz kotott** (a tulajdonos penze, valodi cimzettnek meno uzenet, visszafordithatatlan torles, rendszer-szintu valtoztatas):', '')
      for (const c of gated) {
        rights.push(`- \`${c.key}\` (level ${effectiveLevel(c, name, config)}): ${c.label}`)
      }
      rights.push('')
    }
  }

  return [
    '## Autonómia és jóváhagyás',
    '',
    ...rights,
    'Az autonóm műveletek fokozatait a store/autonomy-config.json szabályozza (level: 1=csak jelez, 2=javasol+jóváhagyás, 3=autonóm+jelent). Mielőtt önállóan cselekszel, nézd meg az adott kategória szintjét.',
    '',
    '**Level 1 (csak jelez)**: küldj inter-agent értesítést a főágensnek, de NE végezd el a műveletet. Ezután ÁLLJ MEG.',
    `curl -s -X POST ${dashboardOrigin}/api/messages -H "Content-Type: application/json" -H "Authorization: Bearer $(cat ${tokenPath})" -d "{\\"from\\":\\"${name}\\",\\"to\\":\\"${MAIN_AGENT_ID}\\",\\"content\\":\\"[FELHÍVÁS] CATEGORY_KEY: MIT akartam elvégezni, de level 1 miatt csak jelzek.\\"}"`,
    '',
    '**Level 2 (jóváhagyás szükséges)**: kérj jóváhagyást az API-n MIELŐTT cselekszel.',
    '',
    'Jóváhagyás kérése (POST):',
    `curl -s -X POST ${dashboardOrigin}/api/approvals -H "Content-Type: application/json" -H "Authorization: Bearer $(cat ${tokenPath})" -d '{"agent_id":"${name}","category":"CATEGORY_KEY","action_description":"Mit tervezel elvégezni és miért","timeout_seconds":3600}'`,
    'A válaszban kapott id-vel kérdezheted le a döntést.',
    '',
    'Döntés lekérdezése (GET, 60 mp-enként ismételve):',
    `curl -s -H "Authorization: Bearer $(cat ${tokenPath})" "${dashboardOrigin}/api/approvals/<id>"`,
    'status=approved -> végezd el a műveletet. status=rejected vagy status=timeout -> ne csináld, naplózd az okot.',
    '',
    '**Level 3 (autonóm)**: elvégzed a műveletet, majd utána jelented a főágensnek.',
    '',
    '## Flotta-doktrína (szabály, nem kapu)',
    '',
    'Ezekre 2026-08-20 óta NINCS technikai kapu (a governance hard-gate-eket a tulajdonos leszereltette). Attól még kötelező szabályok -- a betartásuk rajtad múlik.',
    '',
    '**Önütemezés**: szabadon ütemezheted magad (ScheduleWakeup / CronCreate / /loop), nem kell hozzá a főágens. Cserébe minden ismétlődő futásnak legyen leállási feltétele és látható nyoma; ne indíts olyan hurkot, amit nem tudsz megállítani.',
    '',
    '**Idegen ágens vezérlése**: MÁS ágens tmux paneljébe, munkamenetébe vagy worktree-jébe soha ne írj be parancsot, és ne indítsd vagy állítsd le a folyamatát a háta mögött. Ha kell tőle valami, inter-agent üzenetet küldesz (/api/messages), vagy a dashboard hivatalos végpontját hívod.',
    '',
    '**Gépszintű ütemezők**: crontab, at, batch, systemd-run, launchctl -- ezekhez csak a tulajdonos kifejezett kérésére nyúlj. A flotta saját ütemezője a ~/.claude/scheduled-tasks; azt használd.',
    '',
    '**E-mail**: közvetlenül küldesz, közvetítő nélkül. Csak IGAZOLT címre írj (a felhasználó adta meg, vagy korábbi levélből származik) -- címet SOHA ne találj ki. A tulajdonos nevében nem írsz alá, és senki nevében nem kérsz pénzt. Küldés előtt a címzettet, a tárgyat és a tartalmat visszaolvasod jóváhagyásra.',
  ].join('\n')
}

// The mandatory ask-back rule. Boss, 2026-08-24: "ha ketertelmu akkor
// kotelezoen vissza kell kerdeznie! mindenhova tedd be."
//
// Why this is a GENERATED block and not just a line in the template: the
// template only reaches agents created AFTER it changes. This block lands in
// every agent's CLAUDE.md on the next start (and on dashboard boot), so an
// agent that already exists is not left with the old, silent behaviour.
//
// The text is deliberately concrete about the incident that produced it. A
// rule stated as a principle gets read as advice; a rule with the cost written
// next to it gets followed.
function buildAskBackBody(): string {
  return [
    '## KOTELEZO VISSZAKERDEZES KETERTELMUSEGNEL',
    '',
    'Ha egy utasitasnak egynel tobb ertelme van, **KOTELEZO visszakerdezned** --',
    'akkor is, ha erted. A tippelt ertelmezes rosszabb a kerdesnel: a kerdes tiz',
    'masodperc, a rossz tipp gyakran visszafordithatatlan.',
    '',
    'Kerdezz, ha: a halmazt neked kell megallapitanod ("mind", "az osszeset", "a',
    'nem mukodoket"); nincs megnevezve, MIN vegezd el; a mondatnak ket olvasata van;',
    'a muvelet egy merteken mulik ("regi", "nagy", "sok"); vagy a megnevezett eszkoz',
    'mast eredmenyezne, mint a kimondott cel. Ezek elott MINDIG kerdezz, meg halvany',
    'ketely eseten is: torles, kifele meno uzenet valodi cimzettnek,',
    'jelszo/hozzaferes/jogosultsag valtoztatas, penzmozgas vagy hivatalos beadvany,',
    'tomeges muvelet (egynel tobb elem egy lepesben), eles szolgaltatas leallitasa.',
    '',
    'Egy uzenetben az OSSZES nyitott kerdes, konkret A/B valasztassal; kozben vegezd',
    'el azt a reszt, ami a valasz nelkul is biztos. NE kerdezz, ha egy ertelme van',
    'es csak a feladat nagy -- rutin dontest (fajlnev, sorrend) hozz meg magad.',
    '',
    'Reszletek (miert, valos eset, teljes eljaras): `ask-back-when-ambiguous` skill.',
  ].join('\n')
}

// The second mandatory rule, and it came from the same kind of failure as the
// first: something was said with confidence that had not been looked at.
//
// The incident (2026-08-25): a break-glass password reset had happened on
// 2026-08-24 13:09, and the fact "the password is still the test string" was
// carried forward from earlier in the conversation and repeated to the owner.
// The owner had changed it at 13:16 the same day -- seven minutes later. The
// answer to "how do you know?" was: I did not, I remembered. One SELECT on
// dashboard_users.updated_at settled it in two seconds.
//
// Stale facts are worse than missing ones: a missing fact makes someone go and
// look, a stale fact makes them act on yesterday.
// The wake greeting is a STANDING rule in the agent's own CLAUDE.md, never a
// line in the wake message itself. The wake arrives over the inter-agent queue
// as untrusted data, and an agent that obeys "message the owner" from that
// source has been taught the exact shape of a prompt-injection attack -- lackor3
// correctly refused an earlier version that tried it (agent-wake.sh:32-38). A
// rule the agent already carries is trusted; the wake stays a statement of fact.
function buildWakeGreetingBody(): string {
  return [
    '## FELEBREDESKOR AZ ELSO MONDAT A KOSZONES',
    '',
    'Ha egy ebresztes felebreszt (keret-visszaallas, ujraindulas, kapcsolat-',
    'visszateres), az ELSO dolgod egy rovid koszones a tulajdonos sajat csatornajan:',
    '"Szia, itt vagyok, felebredtem." Csak EZUTAN kezdj barmi masba. A koszones EGY',
    'mondat, nem statusz-riport; a munka utana jon.',
    '',
    'Ez nem mond ellent annak, hogy KIESESKOR hallgatsz: kifutott kerettel nem irsz,',
    'mert arrol nincs mit mondani -- a visszatereskor viszont kotelezo megszolalni.',
    '',
    'EGYETLEN KIVETEL: ha a session inditasakor kapsz egy "EBREDES-KOSZONES: NE',
    'koszonj" sort, akkor NE koszonj -- csak folytasd. Ez akkor jon, ha a tulajdonos',
    'EPP MOST irt es meg valaszra var (a beszelgetes az o szemszogebol nem szakadt',
    'meg). Minden mas esetben (csend a csatornan, vagy nem merheto allapot) a fenti',
    'szabaly all valtozatlanul.',
  ].join('\n')
}

function buildRecheckBody(): string {
  return [
    '## UJRA ALLITAS ELOTT UJRA MEG KELL NEZNI',
    '',
    'Ha egy tenyt **masodszor** is kimondasz (a felhasznalo visszaker, osszefoglaloba',
    'irod, vagy egy kesobbi lepes epul ra), **ujra le kell merned**, mielott',
    'kimondod. A sajat korabbi valaszod es az emlekezet NEM forras: azok arrol',
    'szolnak, mi volt igaz akkor, nem arrol, mi igaz most.',
    '',
    'Mindig nezd meg ujra: allapot (fut-e, aktiv-e, mennyi), datum es idobelyeg,',
    'verzio- es commit-szam, fajl tartalma es letezese, jelszo/token/hozzaferes,',
    'darabszamok es listak, egy korabbi hiba "meg mindig fennall-e".',
    '',
    'Ha nem tudod ujra megnezni, NE add elo tenykent: mondd meg, mikori adatbol',
    'beszelsz. A "legutobb X volt" es az "X" ket kulonbozo mondat. Ha az ujrameres',
    'mast mutat, a friss adat nyer -- javitsd ki roviden es tenyszeruen.',
    '',
    'Reszletek (valos eset, teljes lista): `recheck-before-restating` skill.',
  ].join('\n')
}

// The fourth mandatory rule. Incident (2026-08-29): a login-box bugfix was
// handed to a sub-agent that was, at that exact moment, sitting at "Not
// logged in -- Please run /login" -- unable to process anything, including
// the very message carrying the task. A second attempt went to another
// sub-agent that had already hit its own weekly usage wall. Both handoffs
// were pure waste: the task sat untouched until the owner pointed out what a
// single status check would have shown before either message was sent.
function buildDelegateCheckBody(): string {
  return [
    '## MUNKA ATADASA ELOTT KOTELEZO ELLENORIZNI: ONLINE-E A CIMZETT',
    '',
    'Mielott barkinek (sub-agensnek, flotta-tagnak) munkat adnal at, ELOSZOR',
    'ellenorizd elo forrasbol, hogy a cimzett tud-e most dolgozni: fut-e, be van-e',
    'jelentkezve (nincs "Please run /login"), nincs-e kimerult keretnel. Ez az ELSO',
    'lepes, meg a feladat megfogalmazasa elott -- SOSE a legutobbi ismert allapotbol',
    'vagy emlekezetbol (ugyanaz az elv, mint a `recheck-before-restating`).',
    '',
    'Ha a cimzett NEM elerheto: (1) van-e HARMADIK agens, aki elerheto ES megfelel a',
    'feladat kovetelmenyeinek -- ha igen, oda add ki; (2) ha nincs, magadnak kell',
    'elvegezned, nem maradhat kiadatlanul. Kivetel: ha a feladat maga a cimzett',
    'elerhetetlensegenek elharitasa (pl. "allitsd helyre X bejelentkezeset").',
    '',
    'Reszletek (valos eset, teljes eljaras): `delegate-availability-check` skill.',
  ].join('\n')
}

// Idempotently ensures the ask-back block is present and current in the
// agent's CLAUDE.md. Same five-rule idempotency contract as
// ensureFleetRosterSection(). The main agent's CLAUDE.md lives at
// PROJECT_ROOT; it carries the rule as tracked repo text instead, so this
// function deliberately skips it rather than writing a generated block into a
// git-tracked file on every boot.
//
// The return value exists so the caller can tell the two kinds of "nothing
// happened" apart. 'no-file' means the agent has no CLAUDE.md of its own, which
// on this fleet is normal (a worktree-based agent reads the repo file and
// ~/.claude/CLAUDE.md instead) -- but 'unreadable' means the rule did NOT reach
// that agent and nobody would otherwise know. A count of zero writes must never
// be reported as "everyone is up to date".
export type AskBackOutcome = 'written' | 'current' | 'skipped-main' | 'no-file' | 'unreadable'

export function ensureAskBackSection(name: string): AskBackOutcome {
  if (name === MAIN_AGENT_ID) return 'skipped-main'
  const claudeMdPath = join(agentDir(name), 'CLAUDE.md')
  if (!existsSync(claudeMdPath)) return 'no-file'

  const block = `${ASKBACK_BEGIN}\n${buildAskBackBody()}\n${ASKBACK_END}`

  let existing: string
  try {
    existing = readFileSync(claudeMdPath, 'utf-8')
  } catch {
    return 'unreadable'
  }

  const updated = ASKBACK_BLOCK_RE.test(existing)
    ? existing.replace(ASKBACK_BLOCK_RE, block)
    : existing.trimEnd() + '\n\n' + block + '\n'

  if (updated === existing) return 'current'
  atomicWriteFileSync(claudeMdPath, updated)
  return 'written'
}

// The global CLAUDE.md (~/.claude/CLAUDE.md) is the ONLY instruction file every
// Claude Code session on this machine reads regardless of its working
// directory. Per-agent CLAUDE.md files do not reach an agent that runs from a
// git worktree (measured 2026-08-24: usalackor's CWD is
// .worktrees/usalackor, so agents/usalackor/CLAUDE.md is never loaded -- and
// that agent has no such file at all). The mandatory ask-back rule must bind
// the whole fleet, so it is written here too.
//
// The file is NOT owned by us: it may already carry the operator's own rules,
// and on a fresh install it may not exist at all. Both cases are handled --
// missing file is created with just the block, existing file keeps every line
// outside the markers untouched. Same five-rule idempotency contract as
// ensureAskBackSection().
export function ensureGlobalAskBackRule(): void {
  const dir = join(homedir(), '.claude')
  const path = join(dir, 'CLAUDE.md')
  const block = `${ASKBACK_BEGIN}\n${buildAskBackBody()}\n${ASKBACK_END}`

  let existing = ''
  if (existsSync(path)) {
    try {
      existing = readFileSync(path, 'utf-8')
    } catch {
      return
    }
  } else {
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      return
    }
  }

  const updated = ASKBACK_BLOCK_RE.test(existing)
    ? existing.replace(ASKBACK_BLOCK_RE, block)
    : existing.trim() === ''
      ? block + '\n'
      : existing.trimEnd() + '\n\n' + block + '\n'

  if (updated === existing) return
  atomicWriteFileSync(path, updated)
}

// Same shape as ensureAskBackSection/ensureGlobalAskBackRule, for the
// recheck rule. The two rules are kept as separate blocks on purpose: each has
// its own markers, so one can be reworded later without rewriting the other,
// and an agent that already carries one still receives the other.
export function ensureRecheckSection(name: string): AskBackOutcome {
  if (name === MAIN_AGENT_ID) return 'skipped-main'
  const claudeMdPath = join(agentDir(name), 'CLAUDE.md')
  if (!existsSync(claudeMdPath)) return 'no-file'

  const block = `${RECHECK_BEGIN}\n${buildRecheckBody()}\n${RECHECK_END}`

  let existing: string
  try {
    existing = readFileSync(claudeMdPath, 'utf-8')
  } catch {
    return 'unreadable'
  }

  const updated = RECHECK_BLOCK_RE.test(existing)
    ? existing.replace(RECHECK_BLOCK_RE, block)
    : existing.trimEnd() + '\n\n' + block + '\n'

  if (updated === existing) return 'current'
  atomicWriteFileSync(claudeMdPath, updated)
  return 'written'
}

// Same shape again, for the wake-greeting rule. Kept as its own block with its
// own markers so rewording one mandatory rule never rewrites the others, and an
// agent that already carries two still receives the third.
export function ensureWakeGreetingSection(name: string): AskBackOutcome {
  if (name === MAIN_AGENT_ID) return 'skipped-main'
  const claudeMdPath = join(agentDir(name), 'CLAUDE.md')
  if (!existsSync(claudeMdPath)) return 'no-file'

  const block = `${WAKE_GREETING_BEGIN}\n${buildWakeGreetingBody()}\n${WAKE_GREETING_END}`

  let existing: string
  try {
    existing = readFileSync(claudeMdPath, 'utf-8')
  } catch {
    return 'unreadable'
  }

  const updated = WAKE_GREETING_BLOCK_RE.test(existing)
    ? existing.replace(WAKE_GREETING_BLOCK_RE, block)
    : existing.trimEnd() + '\n\n' + block + '\n'

  if (updated === existing) return 'current'
  atomicWriteFileSync(claudeMdPath, updated)
  return 'written'
}

// The machine-wide half. This one matters more than for the other two rules:
// the MAIN agent is skipped above (it has no agents/<name>/CLAUDE.md), and an
// agent running out of a git worktree never loads its own file either -- yet
// both of them wake up and both must greet. ~/.claude/CLAUDE.md is the only
// file every Claude Code session reads no matter where it runs.
export function ensureGlobalWakeGreetingRule(): void {
  const dir = join(homedir(), '.claude')
  const path = join(dir, 'CLAUDE.md')
  const block = `${WAKE_GREETING_BEGIN}\n${buildWakeGreetingBody()}\n${WAKE_GREETING_END}`

  let existing = ''
  if (existsSync(path)) {
    try {
      existing = readFileSync(path, 'utf-8')
    } catch {
      return
    }
  } else {
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      return
    }
  }

  const updated = WAKE_GREETING_BLOCK_RE.test(existing)
    ? existing.replace(WAKE_GREETING_BLOCK_RE, block)
    : existing.trim() === ''
      ? block + '\n'
      : existing.trimEnd() + '\n\n' + block + '\n'

  if (updated === existing) return
  atomicWriteFileSync(path, updated)
}

// The machine-wide half: see the comment on ensureGlobalAskBackRule for why
// ~/.claude/CLAUDE.md is the only file that reaches a worktree-based agent.
export function ensureGlobalRecheckRule(): void {
  const dir = join(homedir(), '.claude')
  const path = join(dir, 'CLAUDE.md')
  const block = `${RECHECK_BEGIN}\n${buildRecheckBody()}\n${RECHECK_END}`

  let existing = ''
  if (existsSync(path)) {
    try {
      existing = readFileSync(path, 'utf-8')
    } catch {
      return
    }
  } else {
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      return
    }
  }

  const updated = RECHECK_BLOCK_RE.test(existing)
    ? existing.replace(RECHECK_BLOCK_RE, block)
    : existing.trim() === ''
      ? block + '\n'
      : existing.trimEnd() + '\n\n' + block + '\n'

  if (updated === existing) return
  atomicWriteFileSync(path, updated)
}

// Same shape again, for the delegate-availability rule (2026-08-29): check the
// recipient is actually online before handing off work, not after.
export function ensureDelegateCheckSection(name: string): AskBackOutcome {
  if (name === MAIN_AGENT_ID) return 'skipped-main'
  const claudeMdPath = join(agentDir(name), 'CLAUDE.md')
  if (!existsSync(claudeMdPath)) return 'no-file'

  const block = `${DELEGATE_CHECK_BEGIN}\n${buildDelegateCheckBody()}\n${DELEGATE_CHECK_END}`

  let existing: string
  try {
    existing = readFileSync(claudeMdPath, 'utf-8')
  } catch {
    return 'unreadable'
  }

  const updated = DELEGATE_CHECK_BLOCK_RE.test(existing)
    ? existing.replace(DELEGATE_CHECK_BLOCK_RE, block)
    : existing.trimEnd() + '\n\n' + block + '\n'

  if (updated === existing) return 'current'
  atomicWriteFileSync(claudeMdPath, updated)
  return 'written'
}

// The machine-wide half: see the comment on ensureGlobalAskBackRule for why
// ~/.claude/CLAUDE.md is the only file that reaches a worktree-based agent.
export function ensureGlobalDelegateCheckRule(): void {
  const dir = join(homedir(), '.claude')
  const path = join(dir, 'CLAUDE.md')
  const block = `${DELEGATE_CHECK_BEGIN}\n${buildDelegateCheckBody()}\n${DELEGATE_CHECK_END}`

  let existing = ''
  if (existsSync(path)) {
    try {
      existing = readFileSync(path, 'utf-8')
    } catch {
      return
    }
  } else {
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      return
    }
  }

  const updated = DELEGATE_CHECK_BLOCK_RE.test(existing)
    ? existing.replace(DELEGATE_CHECK_BLOCK_RE, block)
    : existing.trim() === ''
      ? block + '\n'
      : existing.trimEnd() + '\n\n' + block + '\n'

  if (updated === existing) return
  atomicWriteFileSync(path, updated)
}

// Idempotently ensures the autonomy-wiring block is present and current in the
// agent's CLAUDE.md. Called on every startAgentProcess() alongside
// ensureFleetRosterSection() so that existing agents receive the block
// automatically on respawn without manual migration.
//
// Idempotency contract mirrors ensureFleetRosterSection (five rules apply).
export function ensureAutonomySection(name: string): void {
  // The main agent's CLAUDE.md lives at PROJECT_ROOT, not inside agents/<name>/.
  // Sub-agents use agentDir(name)/CLAUDE.md as usual.
  const claudeMdPath = name === MAIN_AGENT_ID
    ? join(PROJECT_ROOT, 'CLAUDE.md')
    : join(agentDir(name), 'CLAUDE.md')
  if (!existsSync(claudeMdPath)) return

  const body = buildAutonomyBody(name)
  const block = `${AUTONOMY_BEGIN}\n${body}\n${AUTONOMY_END}`

  let existing: string
  try {
    existing = readFileSync(claudeMdPath, 'utf-8')
  } catch {
    return
  }

  let updated: string
  if (AUTONOMY_BLOCK_RE.test(existing)) {
    updated = existing.replace(AUTONOMY_BLOCK_RE, block)
  } else {
    updated = existing.trimEnd() + '\n\n' + block + '\n'
  }

  if (updated === existing) return
  atomicWriteFileSync(claudeMdPath, updated)
}

// Idempotently ensures the fleet roster block is present and current in the
// agent's CLAUDE.md. Called on every startAgentProcess() so that existing
// agents receive the block automatically on respawn -- no manual migration.
//
// Idempotency contract (five rules, in order):
//   1. No CLAUDE.md present  → skip entirely (e.g. main agent or fresh install).
//   2. Marker block present  → replace ONLY the block; content outside the
//      markers is never touched.
//   3. No marker block       → append block after existing content (first run).
//   4. Computed content identical to existing → return immediately; no disk
//      write, no mtime change (safe to call on every respawn).
//   5. Any write             → goes through atomicWriteFileSync to avoid a
//      torn file if the process is killed mid-write.
export function ensureFleetRosterSection(name: string): void {
  const claudeMdPath = join(agentDir(name), 'CLAUDE.md')
  if (!existsSync(claudeMdPath)) return

  const body = buildFleetRosterBody(name)
  const block = `${FLEET_ROSTER_BEGIN}\n${body}\n${FLEET_ROSTER_END}`

  let existing: string
  try {
    existing = readFileSync(claudeMdPath, 'utf-8')
  } catch {
    return
  }

  let updated: string
  if (FLEET_ROSTER_BLOCK_RE.test(existing)) {
    updated = existing.replace(FLEET_ROSTER_BLOCK_RE, block)
  } else {
    updated = existing.trimEnd() + '\n\n' + block + '\n'
  }

  if (updated === existing) return
  atomicWriteFileSync(claudeMdPath, updated)
}

export async function generateClaudeMd(name: string, description: string, model: string): Promise<string> {
  // Distribution-safe default-drive line: only emit a concrete folder when this
  // install has one configured (OWNER_DRIVE_FOLDER). A fresh install with no
  // configured folder tells the agent to ask the owner instead of baking in
  // some other install's drive id.
  const driveDefault = OWNER_DRIVE_FOLDER
    ? `Ha nincs MÁS kijelölve, az ALAPÉRTELMEZETT közös meghajtó: https://drive.google.com/drive/folders/${OWNER_DRIVE_FOLDER} - ide írj, rendezett almappákba.`
    : `Ha nincs kijelölt közös meghajtó, MIELŐTT bárhova írsz, kérd el ${OWNER_NAME}-tól a megfelelő Drive mappát.`
  const prompt = `You are creating the CLAUDE.md (project instructions) file for an AI agent.
Agent name: ${name}
Description of what the agent should do: ${description}
Model: ${model}

Generate a comprehensive CLAUDE.md that includes:
- Clear role and responsibilities based on the description above
- Behavioral guidelines
- Communication style
- Language rules (Hungarian with ${OWNER_NAME}, English for code/technical)
- Tool usage guidelines relevant to the agent's role
- Any domain-specific instructions

The owner's name is ${OWNER_NAME}. Use this exact name everywhere the CLAUDE.md
refers to the owner/user. Do not substitute or invent any other name.

IMPORTANT FORMATTING RULES:
- Write ALL Hungarian text with proper accents (á, é, í, ó, ö, ő, ú, ü, ű). NEVER write Hungarian without accents.
- The agent's first line description should reflect what the user typed as description, in Hungarian with accents.
- Never use em dash (—), only simple hyphen (-).

IMPORTANT: The CLAUDE.md MUST include the following sections at the end (copy them exactly, replacing AGENT_NAME with ${name}):

## Memoria rendszer

A memoria 3 retegbol all (hot/warm/cold) + napi naplo.

### Tier-ek:
- **hot**: Aktiv feladatok, pending dontesek, ami MOST tortenik
- **warm**: Stabil konfig, preferenciák, projekt kontextus (ritkán változik)
- **cold**: Hosszútávú tanulságok, történeti döntések, archívum
- **shared**: Más ágenseknek is releváns információk

### NINCS MENTAL NOTE! Ha meg kell jegyezni -> AZONNAL mentsd:

Minden /api/* végpont Bearer tokenes: a token a store/.dashboard-token fájlban.

Memória mentés:
curl -s -X POST ${dashboardOrigin}/api/memories -H "Content-Type: application/json" -H "Authorization: Bearer $(cat ${tokenPath})" -d '{"agent_id":"AGENT_NAME","content":"MIT","category":"CATEGORY","keywords":"kulcsszo1, kulcsszo2"}'

Napi napló (append-only):
curl -s -X POST ${dashboardOrigin}/api/daily-log -H "Content-Type: application/json" -H "Authorization: Bearer $(cat ${tokenPath})" -d '{"agent_id":"AGENT_NAME","content":"## HH:MM -- Tema\nMi tortent, mi lett az eredmeny"}'

Keresés (mielőtt válaszolsz, nézd meg van-e releváns emlék):
curl -s -H "Authorization: Bearer $(cat ${tokenPath})" "${dashboardOrigin}/api/memories?agent=AGENT_NAME&q=KULCSSZO&category=warm"

## Ütemezett feladatok

Az ütemezett feladatok a ~/.claude/scheduled-tasks/ mappában élnek, fájl-alapúak (SKILL.md + task-config.json). A schedule runner 15 másodpercenként ellenőrzi és a te tmux session-ödbe küldi a promptot.

Feladat létrehozása API-n keresztül:
curl -s -X POST ${dashboardOrigin}/api/schedules -H "Content-Type: application/json" -H "Authorization: Bearer $(cat ${tokenPath})" -d '{"name": "feladat-nev", "description": "Rövid leírás", "prompt": "A részletes prompt", "schedule": "0 8 * * *", "agent": "AGENT_NAME", "type": "heartbeat"}'

Típusok: task (mindig szól az eredménnyel) vagy heartbeat (csak fontosnál szól).
Cron formátum: perc óra nap hónap hétnapja (pl. 0 8 * * * = minden nap 8:00).
NE írd közvetlenül az SQLite scheduled_tasks táblát - az egy régi API.

## Öntanulás és Skill rendszer

Te egy önfejlesztő ágens vagy. A munkád során tanulsz, és újrafelhasználható skill-eket hozol létre.

### Skill-ek helye
- Globális: ~/.claude/skills/ (minden ágens számára elérhető)
- Egyéni: a te munkakönyvtárad .claude/skills/ mappája

### Automatikus skill generálás
Komplex feladatok után (5+ tool hívás, hiba utáni recovery, user korrekció, többlépéses workflow) automatikusan hozz létre SKILL.md fájlt:

mkdir -p ~/.claude/skills/SKILL-NEV
A SKILL.md tartalmazzon YAML frontmatter-t (name, description, scope), majd szekciókat: Mikor használd, Eljárás, Buktatók, Ellenőrzés.
A scope sor KÖTELEZŐ: scope: personal (konkrét emberre/fiókra/magánügyre szól, ezen a gépen marad) vagy scope: global (bárkinek hasznos, a rendszer átviszi a seed-skills/ alá). Scope nélküli SKILL.md írását a gép megállítja (skill-scope-gate.py); ha nem tudod eldönteni, kérdezd meg a tulajdonost, és addig ne hozd létre.

### Skill patch (runtime javítás)
Ha egy meglévő skill használata közben jobb megoldást találsz:
1. Ne írd újra az egész skill-t, csak a megváltozott részt javítsd
2. Használj célzott cserét (régi szöveg -> új szöveg)
3. Jegyezd fel a változtatás okát a skill Buktatók szekciójába

### Mikor generálj skill-t?
- 5+ tool hívás, sikeres befejezés: Generálj skill-t
- Hiba -> recovery -> siker: Generálj skill-t (buktató szekcióval)
- User korrekció: Patch-eld a meglévő skill-t
- Nem triviális workflow: Generálj skill-t
- Egyszerű, egylépéses feladat: Ne generálj semmit

### Skill reflexió
Minden kontextus-tömörítés előtt (PreCompact hook) automatikusan vizsgáld meg:
- Van-e a session-ben újrafelhasználható minta?
- Van-e meglévő skill amit javítani kellene?

## Időkezelés

MINDIG az install időzónáját használd: **${APP_TZ}** (a teljes telepítés ebben az EGY zónában dolgozik: ütemezés ÉS megjelenítés).

- **Jelenlegi idő**: \`date\` Bash első lépés időponti feladatoknál (heartbeat, naptár-művelet, scheduled-task analízis) — a rendszeróra is ${APP_TZ}
- **Channel message \`ts\`**: UTC-ben jön (postfix \`Z\`), átkonvertálni ${APP_TZ}-re
- **Google Calendar list_events \`dateTime\`**: már lokál ISO 8601 offszettel, OK
- **SQLite \`unixepoch()\`**: UTC, humán-megjelenítéshez \`localtime\` modifier kell
- **Cron expressions** (scheduled-tasks + fleet-timer): a scheduler ${APP_TZ} időben értelmezi (SCHEDULER_TZ); a fleet-timer \`once --at\` = ${APP_TZ} fali óra

Heartbeat-eknél és minden időpontot kezelő feladatnál kötelező: \`date\` Bash parancs az elemzés ELŐTT.

## Flotta-szabályok (MEGSZEGHETETLEN - kollégák ${BOT_NAME}jaira)

Ezeket ${OWNER_NAME} adta, a flotta minden kolléga-asszisztensére kötelezőek. SOHA ne szegd meg őket.

1. **Drive írás CSAK a kijelölt helyre.** Írni kizárólag egy megadott Google Drive mappába VAGY egy külön megosztott meghajtóba (Shared Drive) szabad. Ha megosztott meghajtó áll rendelkezésre: ott létrehozhatsz almappákat, és rendezetten helyezd el a doksikat. ${driveDefault} Ha valamiért ez sem elérhető, kérd el a tulajdonostól; ne találgass, ne írj máshova.
2. **Saját ("My Drive") meghajtóra TILOS írni.**
3. **Olvasni a teljes Drive-ot szabad.**
4. **Céges email-válasz előtt KÖTELEZŐ a kontextus beolvasása.** Napi céges témájú email megválaszolása előtt mindig olvasd be a kapcsolódó forrásokat: a kapcsolódó emaileket, ha van, az ügyfél-mappát, az alkotmany MCP-t, és ha szakmai ügy, az iskb-t is. A Circleback (megbeszélés-átiratok) szintén kulcsfontosságú - rengeteg infó a meetingeken hangzik el.
5. **Eredmény-fájlok a közös Drive mappába.** Az elkészült eredmény-fájlokat külön kérés nélkül is a közösen használt Drive mappába tedd (lásd 1. szabály).
6. **Login-automatizálás / külső credential / futtatható szkript -> ELŐBB szólj a Főnöknek.** Mielőtt bármilyen külső szolgáltatásba automatikus bejelentkezést, jelszó-/credential-kezelést, vagy futtatható szkriptet (pl. Playwright/böngésző-automatizálás, scraper, login-szkript) írsz vagy futtatsz, jelezd a ${BOT_NAME} Főnöknek (${MAIN_AGENT_ID}) inter-agent üzenettel - ő koordinálja és ${OWNER_NAME}-val egyezteti. Credential-t SOHA ne égess nyersen kódba; ha titok kell, kérd a Főnöktől a biztonságos tárolás módját.

Output ONLY the markdown content, no code fences.`

  const { text, error } = await runAgent(prompt)
  if (!text) throw new Error(error ? blockedHint('CLAUDE.md', error) : noOutputHint('CLAUDE.md'))
  let cleaned = text.trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\w*\n?/, '').replace(/\n?```$/, '')
  }
  // Append marker-delimited sections after LLM output so the model can never
  // see or rewrite them. Single source of truth: same builders as the
  // ensure*Section() functions used on every subsequent respawn.
  const fleetBody = buildFleetRosterBody(name)
  const autonomyBody = buildAutonomyBody(name)
  cleaned = cleaned.trimEnd()
    + '\n\n' + FLEET_ROSTER_BEGIN + '\n' + fleetBody + '\n' + FLEET_ROSTER_END
    + '\n\n' + AUTONOMY_BEGIN + '\n' + autonomyBody + '\n' + AUTONOMY_END + '\n'
  return cleaned
}

// Shared "Claude Code returned nothing" message for the three generators below.
// Issue #179: the bare "Failed to generate <file>" message left VPS operators
// chasing the wrong thread when the actual cause was an unauthenticated Claude
// Code CLI on the host. Always surface the diagnostic command sequence.
function noOutputHint(target: string): string {
  return (
    `Failed to generate ${target}: the Claude Code CLI returned no output. ` +
    `Most likely cause: the CLI on this host is not authenticated. ` +
    `Verify with: \`claude --version\`, then \`claude /login\` (or set ` +
    `ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN). ` +
    `If that succeeds and the error persists, run \`claude --print "ping"\` ` +
    `from this directory to confirm headless invocation works.`
  )
}

// Issue #209: distinct from noOutputHint -- here the SDK returned a result that
// was a usage-policy (AUP) block or an API/execution error, NOT empty output.
// runAgent already refused to propagate the block text as content; we surface
// the structured reason so the operator does not chase an auth red herring.
function blockedHint(target: string, reason: string): string {
  return (
    `Failed to generate ${target}: the model returned a blocked/errored result ` +
    `(not generated content), so it was not written to avoid corrupting the file. ` +
    `Reason: ${reason}. If this is an AUP block, rephrase the request or try a ` +
    `different model; the prior conversation/session is unaffected.`
  )
}

export async function generateSoulMd(name: string, description: string): Promise<string> {
  const prompt = `You are creating the SOUL.md (personality definition) for an AI agent.
Agent name: ${name}
Description: ${description}

Generate a personality definition that includes:
- Core personality traits
- Communication tone and style
- How it addresses the user (whose name is ${OWNER_NAME} -- use this name, not any other)
- Unique quirks or characteristics
- What it should avoid

IMPORTANT FORMATTING RULES:
- Write ALL Hungarian text with proper accents (á, é, í, ó, ö, ő, ú, ü, ű). NEVER write Hungarian without accents.
- Never use em dash (—), only simple hyphen (-).

Make the personality distinctive but professional.
Output ONLY the markdown content, no code fences.`

  const { text, error } = await runAgent(prompt)
  if (!text) throw new Error(error ? blockedHint('SOUL.md', error) : noOutputHint('SOUL.md'))
  let cleaned = text.trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\w*\n?/, '').replace(/\n?```$/, '')
  }
  return cleaned
}

export async function generateSkillMd(skillName: string, description: string): Promise<string> {
  const prompt = `You are creating a SKILL.md file for a Claude Code skill. Follow this exact format:

Skill name: ${skillName}
What the user described: ${description}

Generate a SKILL.md with this structure:

1. YAML frontmatter (between --- delimiters):
   - name: ${skillName}
   - description: A comprehensive description that includes what the skill does AND specific contexts for when to use it. Be "pushy" - include multiple trigger phrases. Example: instead of "Creates reports" write "Creates detailed reports. Use this skill whenever the user mentions reports, summaries, data analysis, dashboards, metrics overview, or wants to compile information into a structured document."

2. Body with these sections:
   - # [Skill Name] - main heading
   - ## Purpose - what this skill does and why
   - ## When to use - specific triggers and contexts
   - ## Instructions - step-by-step guide for Claude
   - ## Output format - what the output should look like
   - ## Examples - 1-2 concrete examples with Input/Output
   - ## Language rules - Hungarian with ${OWNER_NAME} (the user), English for code/technical
   - ## What to avoid - common pitfalls

IMPORTANT FORMATTING RULES:
- Write ALL Hungarian text with proper accents (á, é, í, ó, ö, ő, ú, ü, ű). NEVER write Hungarian without accents.
- Never use em dash (—), only simple hyphen (-).

Keep the body under 200 lines. Be specific and actionable. The owner's name is ${OWNER_NAME}; use only this name when referring to the user.
Output ONLY the markdown content, no code fences.`

  const { text, error } = await runAgent(prompt)
  if (!text) throw new Error(error ? blockedHint('SKILL.md', error) : noOutputHint('SKILL.md'))
  let cleaned = text.trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\w*\n?/, '').replace(/\n?```$/, '')
  }
  return cleaned
}


// ---------------------------------------------------------------------------
// NYOMTALAN MUNKA: az eletfat nem szemeteljuk tele.
//
// Boss, 2026-08-30: "onmagatol ne keletkezzen semmilyen fajl (...) senki nem
// tehet plusz fajlt ebbe az eletfaba (...) es akkor kesobb itt kiderul, hogy na
// egyebkent meg 8 darab fajl ott van" -- majd ugyanabban a beszelgetesben:
// "hogyha ideiglenesen (...) kell letrehozni egy fajlt, akkor azt utana, amikor
// a fejlesztes keszen van, utana torolni kell", es "amikor vege van a munkanak
// commit es push azonnal".
//
// A mert eset: 2026-08-29 18:34-18:37 kozott nyolc fajl keletkezett a repo
// gyokereben (negy Playwright-probaszkript + a kimeneteik). Nem a repo kodja
// irta oket, es egy napig ott alltak -- a commitolatlan-munka ora ugyanis a
// nem-kovetett fajlokat szandekosan eldobja. Ket reteg volt nyitva egyszerre:
// semmi nem allitotta meg a keletkezest, es semmi nem vette eszre utana.
//
// Ket reteg zarul be: (1) a PreToolUse kapu megallitja a gyokerbe irast es az
// ideiglenes nevu fajlt, es megmondja, hova irja helyette; (2) a szabaly
// szoveg minden agens CLAUDE.md-jebe es a gepszintu ~/.claude/CLAUDE.md-be
// bekerul, ugyanugy, ahogy a visszakerdezes- es az ujrameres-szabaly.
// ---------------------------------------------------------------------------

const NO_STRAY_BEGIN = '<!-- BEGIN GENERATED: no-stray-files-rule (auto-generated, do not edit by hand) -->'
const NO_STRAY_END = '<!-- END GENERATED: no-stray-files-rule -->'
const NO_STRAY_BLOCK_RE = new RegExp(
  `${NO_STRAY_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${NO_STRAY_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
)

function buildNoStrayBody(): string {
  return [
    '## NYOMTALAN MUNKA -- AZ ELETFAT NEM SZEMETELJUK TELE',
    '',
    'Onmagatol NE keletkezzen semmilyen fajl. Amit letrehozol, azt vagy kertek,',
    'vagy a munka vegtermeke -- minden mas szemet, es a szemet nem marad a fan.',
    '',
    '1. **Ideiglenes fajl SOHA nem a projekt fajaba megy.** Probaszkript, dump,',
    '   kimenet -> `/tmp/` vagy a session scratch-konyvtara; a projekt GYOKERBE',
    '   kulonosen nem.',
    '2. **Amit a fejleszteshez letrehoztal, a fejlesztes vegen TOROLD LE.**',
    '3. **A munkaegyseg vegen a fa legyen tiszta** (`git status --porcelain`):',
    '   minden sorra commit vagy torles.',
    '4. **A lezart munka vegen: hatasvizsgalat + bugkereses, utana AZONNAL commit ES push.**',
    '   Nem maradhat commitolatlan vagy pusholatlan munka. Ugyanez all a chat-naplora:',
    '   a lezart munkaegysegrol meg ugyanabban a valaszban irj bejegyzest.',
    '',
    'Torles elott a visszakerdezes-szabaly is all: ha nem te hoztad letre a fajlt,',
    'KERDEZZ -- vagy mozgasd el `/tmp/` ala (visszaforditható), es ugy kerdezz.',
    '',
    'A kapu: `scripts/hooks/no-stray-files.py` (PreToolUse) megallitja az uj fajlt es',
    'megmondja, hova ird helyette. Kikapcsolo: `MARVEEN_STRAY_FILE_GATE=0`.',
    '',
    'Reszletek (teljes lista, valos eset): `nyomtalan-munka` skill.',
  ].join('\n')
}

function noStrayGateCommand(): string {
  const script = join(PROJECT_ROOT, 'scripts', 'hooks', 'no-stray-files.py')
  // Ugyanaz az alak, mint a file-claim-gate-e: hianyzo szkript eseten exit 0
  // (atenged), sosem 127. Egy nem letezo hook NEM allithatja meg a flottat.
  return `bash -c '[ -f ${script} ] && exec python3 ${script}; exit 0'`
}

/**
 * Idempotensen bekoti a szemet-kaput egy settings.json objektumba.
 *
 * MIERT BLOKKOLHAT, amikor a file-claim-gate mar nem (Boss, 2026-08-25, #13):
 * ott a tiltas azt jelentette volna, hogy az agens ALL, mert nincs hova irnia.
 * Itt van hova: a kapu uzenete megnevezi a helyes utat, az agens egy masodperc
 * mulva ujra ir, csak jo helyre. A tiltas nem munkat vesz el, hanem cimet javit.
 */
export function injectStrayFileGate(existing: Record<string, unknown>): void {
  const hooks = (existing.hooks && typeof existing.hooks === 'object'
    ? existing.hooks
    : (existing.hooks = {})) as Record<string, unknown>
  const command = noStrayGateCommand()
  if (isUnsafeHookCommand(command)) return
  const entry = {
    matcher: 'Write|Edit|MultiEdit|NotebookEdit',
    hooks: [{ type: 'command', command, timeout: 10 }],
  }
  const prev = Array.isArray(hooks.PreToolUse) ? (hooks.PreToolUse as unknown[]) : []
  hooks.PreToolUse = [
    ...prev.filter((e) => !JSON.stringify(e).includes('no-stray-files.py')),
    entry,
  ]
}

/** Minden agens settings.json-jaba beviszi a szemet-kaput. true = irt. */
export function ensureStrayFileGate(name: string): boolean {
  const settingsPath = agentSettingsPath(name)
  let settings: Record<string, unknown> = {}
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) } catch { return false }
  }
  const command = noStrayGateCommand()
  const hooks = (settings.hooks && typeof settings.hooks === 'object')
    ? settings.hooks as Record<string, unknown>
    : {}
  const ptu = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse as unknown[] : []
  const ptuJson = JSON.stringify(ptu)
  if (ptuJson.includes('no-stray-files.py') && hookCommandWired(ptuJson, command)) return false
  if (isUnsafeHookCommand(command)) return false
  injectStrayFileGate(settings)
  if (name !== MAIN_AGENT_ID) mkdirSync(join(agentDir(name), '.claude'), { recursive: true })
  atomicWriteFileSync(settingsPath, JSON.stringify(settings, null, 2))
  return true
}

export type NoStrayOutcome = 'written' | 'current' | 'skipped-main' | 'no-file' | 'unreadable'

export function ensureNoStrayFilesSection(name: string): NoStrayOutcome {
  if (name === MAIN_AGENT_ID) return 'skipped-main'
  const claudeMdPath = join(agentDir(name), 'CLAUDE.md')
  if (!existsSync(claudeMdPath)) return 'no-file'

  const block = `${NO_STRAY_BEGIN}\n${buildNoStrayBody()}\n${NO_STRAY_END}`

  let existing: string
  try {
    existing = readFileSync(claudeMdPath, 'utf-8')
  } catch {
    return 'unreadable'
  }

  const updated = NO_STRAY_BLOCK_RE.test(existing)
    ? existing.replace(NO_STRAY_BLOCK_RE, block)
    : existing.trimEnd() + '\n\n' + block + '\n'

  if (updated === existing) return 'current'
  atomicWriteFileSync(claudeMdPath, updated)
  return 'written'
}

/** Gepszintu valtozat: egy worktree-ben dolgozo agens sosem olvassa a sajat
 *  agents/<nev>/CLAUDE.md-jet, a ~/.claude/CLAUDE.md-t viszont mindig. */
export function ensureGlobalNoStrayFilesRule(): void {
  const dir = join(homedir(), '.claude')
  const path = join(dir, 'CLAUDE.md')
  const block = `${NO_STRAY_BEGIN}\n${buildNoStrayBody()}\n${NO_STRAY_END}`

  let existing = ''
  if (existsSync(path)) {
    try {
      existing = readFileSync(path, 'utf-8')
    } catch {
      return
    }
  } else {
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      return
    }
  }

  const updated = NO_STRAY_BLOCK_RE.test(existing)
    ? existing.replace(NO_STRAY_BLOCK_RE, block)
    : existing.trim() === ''
      ? block + '\n'
      : existing.trimEnd() + '\n\n' + block + '\n'

  if (updated === existing) return
  atomicWriteFileSync(path, updated)
}

const LANDING_BEGIN = '<!-- BEGIN GENERATED: landing-rule (auto-generated, do not edit by hand) -->'
const LANDING_END = '<!-- END GENERATED: landing-rule -->'
const LANDING_BLOCK_RE = new RegExp(
  `${LANDING_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${LANDING_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
)

/**
 * A landolas hivatalos utja, agens-olvashato formaban.
 *
 * MIERT KELL IDE (kartya #230, a #215 ellenorzesebol): ez a szoveg eddig CSAK a
 * templates/CLAUDE.md.template-ben allt. A CLAUDE.md fajlok nincsenek git-ben
 * kovetve, tehat a sablon kizarolag TELEPITESKOR (illetve uj agens
 * letrehozasakor) er el egy fajlt -- a mar letezo elo CLAUDE.md-kbe semmi nem
 * viszi be utolag. Merve 2026-09-06-an az elo telepitesen: a projekt CLAUDE.md-ben
 * es mind a nyolc agens CLAUDE.md-jeben nulla talalat a "land-pr"-re. Ugyanaz a
 * sablon-vs-elo szinkron-res, ami a negy ledger-hookot is hetekig a fo agensnel
 * tartotta. Az egyetlen ut, ami visszamenoleg IS hat, ez a marker-blokkos
 * csalad -- ezert kap sajat ensure*-t.
 */
function buildLandingBody(): string {
  return [
    '## LANDOLAS A FO AGBA: PR + CI, NEM DIREKT PUSH',
    '',
    'A `main`-re DIREKT PUSH TILOS -- a GitHub branch protection elutasitja. A',
    'landolas utja egy CI-vel kapuzott PR, amit a `scripts/land-pr.sh` intez:',
    '',
    '```bash',
    '# sajat worktree-bol (scripts/agent-worktree.sh <nev>), a commitokkal a HEAD-en:',
    'scripts/land-pr.sh "commit/PR cim" ["leiras"]',
    '```',
    '',
    'A helper felnyom egy branchet, PR-t nyit a `main`-re, MEGVARJA amig a CI zold,',
    'es CSAK akkor merge-el; sikeres merge utan a tiszta worktree-t maga torli',
    '(kikapcsolo: `LAND_PR_KEEP_WORKTREE=1`). A kimenetet a TENY szerint olvasd (a',
    '"MERGE-ELVE" sor a bizonyitek), ne a kilepokod szerint: a torolt worktree miatti',
    '`getcwd`/`pwd` hiba NEM a landolas hibaja.',
    '',
    'Ha a CI piros a PR-en: a helper NYITVA hagyja a PR-t -- javitsd es pushold ujra,',
    'ne kerüld meg. Veszhelyzeti kapu-kihagyas CSAK a lokalis gyors-kapunal',
    '(`MARVEEN_SKIP_TEST_GATE=1`); a CI-t megkerulni nem lehet. A landolt kod az elo',
    'peldanyra a `scripts/deploy-live.sh`-val kerul ki.',
    '',
    '**A DEPLOY-T MINDIG MEG KELL CSINALNI, DE MAS AGENSEKET NEM AKADALYOZHATOD.**',
    'Landolas utan a munka nem kesz, amig az elo peldany nem futtatja (a tulajdonos szabalya).',
    'Ellenorizd: `store/.deployed-sha` egyezik-e az `origin/main` hash-sel, vagy a',
    '`store/deploy.log` utolso sora `DEPLOYED`. Ha nem, futtasd a `scripts/deploy-live.sh`-t.',
    'Szabalyok: (1) CSAK a `deploy-live.sh`, kezi service-ujrainditas nincs; (2) ha a',
    'zarat mas deploy tartja, NEM erőlteted, nem varod ki idegesen: vagy megvarod, vagy',
    'a kovetkezo tick viszi ki, de ellenorizd utana; (3) masik agens tmux-at,',
    'folyamatat, worktree-jet nem allitod le es nem nyulsz hozza; (4) ha REFUSING-et',
    'ir (piszkos elo fa), NEM tisztitod el, nem force-olod: jelentsd; (5) a dashboard',
    'egy pillanatra ujraindul, ez normalis, nem hiba.',
  ].join('\n')
}

export type LandingOutcome = 'written' | 'current' | 'skipped-main' | 'no-file' | 'unreadable'

/** Beviszi a landolasi szabalyt egy agens sajat CLAUDE.md-jebe. A fo agens ezt a
 *  gepszintu valtozatbol kapja (lasd ensureGlobalLandingRule), ugyanugy, mint a
 *  tobbi marker-blokkot. */
export function ensureLandingSection(name: string): LandingOutcome {
  if (name === MAIN_AGENT_ID) return 'skipped-main'
  const claudeMdPath = join(agentDir(name), 'CLAUDE.md')
  if (!existsSync(claudeMdPath)) return 'no-file'

  const block = `${LANDING_BEGIN}\n${buildLandingBody()}\n${LANDING_END}`

  let existing: string
  try {
    existing = readFileSync(claudeMdPath, 'utf-8')
  } catch {
    return 'unreadable'
  }

  const updated = LANDING_BLOCK_RE.test(existing)
    ? existing.replace(LANDING_BLOCK_RE, block)
    : existing.trimEnd() + '\n\n' + block + '\n'

  if (updated === existing) return 'current'
  atomicWriteFileSync(claudeMdPath, updated)
  return 'written'
}

/** Gepszintu valtozat: egy worktree-ben dolgozo agens sosem olvassa a sajat
 *  agents/<nev>/CLAUDE.md-jet -- es a landolas eppen worktree-bol tortenik,
 *  tehat ez a valtozat a fontosabb a kettobol. */
export function ensureGlobalLandingRule(): void {
  const dir = join(homedir(), '.claude')
  const path = join(dir, 'CLAUDE.md')
  const block = `${LANDING_BEGIN}\n${buildLandingBody()}\n${LANDING_END}`

  let existing = ''
  if (existsSync(path)) {
    try {
      existing = readFileSync(path, 'utf-8')
    } catch {
      return
    }
  } else {
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      return
    }
  }

  const updated = LANDING_BLOCK_RE.test(existing)
    ? existing.replace(LANDING_BLOCK_RE, block)
    : existing.trim() === ''
      ? block + '\n'
      : existing.trimEnd() + '\n\n' + block + '\n'

  if (updated === existing) return
  atomicWriteFileSync(path, updated)
}

// --- EGY HIBA = EGY KARTYA doktrina (Boss, 2026-09-07) ---
// + 6. pont: EGY PROJEKT = EGY KARTYA (Boss, 2026-09-23, a #336 szabdalasa utan).
// Sajat markeres-blokk, mint a tobbi doktrina (ask-back, recheck, landing), hogy
// minden agens CLAUDE.md-jebe ES a gepszintu ~/.claude/CLAUDE.md-be is eljusson,
// visszamenoleg is -- nem csak telepiteskor. Boss panasza (2026-09-07): a
// kartyak egymasra hivatkozgatasa, a felbehagyott es a masik kartya ala
// athelyezett hibak a problema forrasa; egy kartyat azonnal, teljesen keszre
// kell csinalni.
const ONECARD_BEGIN = '<!-- BEGIN GENERATED: one-card-one-fix-rule (auto-generated, do not edit by hand) -->'
const ONECARD_END = '<!-- END GENERATED: one-card-one-fix-rule -->'
const ONECARD_BLOCK_RE = new RegExp(
  `${ONECARD_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${ONECARD_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
)

function buildOneCardOneFixBody(): string {
  return [
    '## EGY HIBA = EGY KARTYA, AZONNAL ES TELJESEN KESZRE',
    '',
    '1. **Egy hiba = egy kartya.** Ne hivatkozgass kartyarol kartyara, es ne szabdald',
    '   szet egy hibat tobb kartyara.',
    '2. **SZIGORUAN TILOS egy adott hibat kivenni egy kartyabol es athelyezni egy',
    '   masik kartya ala.** Ami egy kartyan van, azt ott kell befejezni.',
    '3. **A kartyat azonnal, teljesen keszre kell csinalni.** Nincs "felbehagyom",',
    '   nincs "majd" -- addig megy, amig kesz.',
    '4. **Ha a javitas kozben UJ hiba jon elo, azt AZONNAL javitani kell** -- ugy',
    '   veve, mintha a tulajdonos annak a javitasat is kerte volna.',
    '5. **A "varakozo" (waiting) oszlop NEM felmentes a befejezes alol.** Nincs olyan,',
    '   hogy "ez mar waiting, ezt mar nem csinalom meg": ami a kartya SAJAT, mar',
    '   vallalt munkajabol hianyzik, azt be kell fejezni -- a kartya MOZGATASA NELKUL',
    '   (komment + izolalt worktree, a kartya marad waiting).',
    '6. **EGY PROJEKT = EGY KARTYA -- amig a kartya NINCS a varakozoban.** Egy',
    '   `planned` / `in_progress` kartya projektjehez tartozo uj munkat (reszfeladat,',
    '   kovetkezo fazis, uj hiba) NEM uj kartyara veszel: kommentet irsz ra, vagy',
    '   alfeladatkent (`parent_id`). A szerver ki is kenyszeriti: ilyen kartyahoz',
    '   kapcsolodo uj kartyat `same_project` (409) hibaval elutasit; kulon kartya csak',
    '   kimondott `separate_project` indokkal.',
    '7. **A VARAKOZOBA KERULT KARTYAT NEM BOVITJUK.** Amint egy kartya a `waiting`',
    '   oszlopban all, UJ munka (uj keres, kovetkezo resz, ujonnan talalt hiba) NEM',
    '   kerul ra -- se kommentben, se alfeladatkent. Az uj munka UJ kartyat kap, es az',
    '   uj kartya LEIRASA mondja meg, melyik varakozo kartyahoz tartozik (`#N`); a',
    '   regire legfeljebb egy mutato komment megy ("folytatas: #N"). Miert: a',
    '   tulajdonos a varakozobol hagy jova, es egy kozben tovabb hizo kartyat nyitott',
    '   munkaval egyutt hagyna jova. A szerver az ilyen uj kartyat atengedi. Munkat',
    '   masnak kiadni is az UJ kartya szamaval kell.',
    '',
    'Reszletek (owner-idezetek, valos eset): `one-card-one-fix` skill.',
  ].join('\n')
}

/** Beviszi az "egy hiba = egy kartya" doktrinat egy agens sajat CLAUDE.md-jebe.
 *  A fo agens ezt a gepszintu valtozatbol kapja (ensureGlobalOneCardOneFixRule),
 *  ugyanugy, mint a tobbi marker-blokkot. */
export function ensureOneCardOneFixSection(name: string): LandingOutcome {
  if (name === MAIN_AGENT_ID) return 'skipped-main'
  const claudeMdPath = join(agentDir(name), 'CLAUDE.md')
  if (!existsSync(claudeMdPath)) return 'no-file'

  const block = `${ONECARD_BEGIN}\n${buildOneCardOneFixBody()}\n${ONECARD_END}`

  let existing: string
  try {
    existing = readFileSync(claudeMdPath, 'utf-8')
  } catch {
    return 'unreadable'
  }

  const updated = ONECARD_BLOCK_RE.test(existing)
    ? existing.replace(ONECARD_BLOCK_RE, block)
    : existing.trimEnd() + '\n\n' + block + '\n'

  if (updated === existing) return 'current'
  atomicWriteFileSync(claudeMdPath, updated)
  return 'written'
}

/** Gepszintu valtozat: egy worktree-ben dolgozo agens (es a fo agens) sosem
 *  olvassa a sajat agents/<nev>/CLAUDE.md-jet, ~/.claude/CLAUDE.md az egyetlen
 *  fajl, amit minden Claude Code session olvas, barhonnan is fut. */
export function ensureGlobalOneCardOneFixRule(): void {
  const dir = join(homedir(), '.claude')
  const path = join(dir, 'CLAUDE.md')
  const block = `${ONECARD_BEGIN}\n${buildOneCardOneFixBody()}\n${ONECARD_END}`

  let existing = ''
  if (existsSync(path)) {
    try {
      existing = readFileSync(path, 'utf-8')
    } catch {
      return
    }
  } else {
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      return
    }
  }

  const updated = ONECARD_BLOCK_RE.test(existing)
    ? existing.replace(ONECARD_BLOCK_RE, block)
    : existing.trim() === ''
      ? block + '\n'
      : existing.trimEnd() + '\n\n' + block + '\n'

  if (updated === existing) return
  atomicWriteFileSync(path, updated)
}

// The sixth mandatory rule. Incident (2026-09-08): after a model switch
// (Opus 4.8 -> Sonnet 5) forced a session restart, the freshly loaded context
// contained the agent's OWN prior message about a VS Code code-bridge fix and
// a kanban landing. The topic looked like the main agent's territory, so it
// was attributed to the main agent without checking -- when in fact it was
// this agent's own earlier turn. The owner corrected it with a Telegram
// screenshot proving the message came from this agent's own bot chat. The
// root cause was guessing from topic/role fit instead of checking a concrete
// source (which bot chat it arrived on, which worktree/branch did the work,
// which agent_id is on the approval that the kanban move raised).
function buildAgentIdentityBody(): string {
  return [
    '## AZONOSITAS ELOTT KOTELEZO ELLENORIZNI, NEM TALALGATNI',
    '',
    'Ha meg kell mondanod, KI irt vagy KI csinalt valamit (uzenet, commit, kartya-',
    'munka), TILOS a temabol vagy szerepkorbol talalgatni -- konkret, ellenorizheto',
    'forrast nezz meg ELOBB: melyik csatornan/boton jott az uzenet, a git worktree/',
    'branch neve, az approval `agent_id`-je, a komment/uzenet szerzoje. A sajat korabbi',
    '("Te:") kontextus ALAPBOL a SAJAT korabbi munkad. Modellvaltas vagy session-',
    'ujrainditas NEM valtoztatja meg, MELYIK agens vagy. Ha nincs ellenorizheto forras,',
    'MONDD MEG hogy nem sikerult ellenorizni -- ne allits tenykent talalgatott azonossagot.',
    '',
    'Reszletek (valos eset): `agent-identity-verification` skill.',
  ].join('\n')
}

/** Beviszi az azonositas-ellenorzesi doktrinat egy agens sajat CLAUDE.md-jebe.
 *  A fo agens ezt a gepszintu valtozatbol kapja (ensureGlobalAgentIdentityRule),
 *  ugyanugy, mint a tobbi marker-blokkot. */
export function ensureAgentIdentitySection(name: string): LandingOutcome {
  if (name === MAIN_AGENT_ID) return 'skipped-main'
  const claudeMdPath = join(agentDir(name), 'CLAUDE.md')
  if (!existsSync(claudeMdPath)) return 'no-file'

  const block = `${AGENT_IDENTITY_BEGIN}\n${buildAgentIdentityBody()}\n${AGENT_IDENTITY_END}`

  let existing: string
  try {
    existing = readFileSync(claudeMdPath, 'utf-8')
  } catch {
    return 'unreadable'
  }

  const updated = AGENT_IDENTITY_BLOCK_RE.test(existing)
    ? existing.replace(AGENT_IDENTITY_BLOCK_RE, block)
    : existing.trimEnd() + '\n\n' + block + '\n'

  if (updated === existing) return 'current'
  atomicWriteFileSync(claudeMdPath, updated)
  return 'written'
}

/** Gepszintu valtozat: egy worktree-ben dolgozo agens (es a fo agens) sosem
 *  olvassa a sajat agents/<nev>/CLAUDE.md-jet, ~/.claude/CLAUDE.md az egyetlen
 *  fajl, amit minden Claude Code session olvas, barhonnan is fut. */
export function ensureGlobalAgentIdentityRule(): void {
  const dir = join(homedir(), '.claude')
  const path = join(dir, 'CLAUDE.md')
  const block = `${AGENT_IDENTITY_BEGIN}\n${buildAgentIdentityBody()}\n${AGENT_IDENTITY_END}`

  let existing = ''
  if (existsSync(path)) {
    try {
      existing = readFileSync(path, 'utf-8')
    } catch {
      return
    }
  } else {
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      return
    }
  }

  const updated = AGENT_IDENTITY_BLOCK_RE.test(existing)
    ? existing.replace(AGENT_IDENTITY_BLOCK_RE, block)
    : existing.trim() === ''
      ? block + '\n'
      : existing.trimEnd() + '\n\n' + block + '\n'

  if (updated === existing) return
  atomicWriteFileSync(path, updated)
}

// The seventh mandatory rule. Incident (2026-09-12): a VS Code Claude Code
// session (Opus 5, git identity "T") worked DIRECTLY in the live checkout
// (the main PROJECT_ROOT tree, not an isolated worktree): it committed onto
// the local main branch (92494c4), staged 58 files, and edited 2 tracked
// files. Because those edits diverge from origin/main, scripts/deploy-live.sh
// began REFUSING to deploy every tick (by design -- it never clobbers local
// work), so the running app froze and no future landing could reach it until
// the tree was reset to a clean origin/main. Boss: "sohasem dolgozunk
// kozvetlenul az elo tree ben! claude md be es mindenhova."
function buildNoLiveTreeBody(): string {
  return [
    '## SOHA NE DOLGOZZ KOZVETLENUL AZ ELO TREE-BEN',
    '',
    'Az elo checkout (a fo PROJECT_ROOT munkafa, amibol a dashboard fut) NEM',
    'fejlesztoi munkahely. TILOS ott kozvetlenul szerkeszteni, `git add`-elni,',
    'commitolni vagy branchet valtani. Minden kod-, skill-, szabaly- es',
    'dashboard-munka izolalt git worktree-ben tortenik:',
    '',
    '1. **Worktree eloszor.** `scripts/agent-worktree.sh <nev>` sajat munkakonyvtarat',
    '   es branchet ad -- ott szerkessz, tesztelj, commitolj.',
    '2. **Landolas PR-rel.** `scripts/land-pr.sh "cim"` (branch -> PR -> CI -> merge).',
    '   A `main`-re direkt push es a fo tree-be kozvetlen commit is tilos.',
    '3. **A landolt kod magatol jut ki** a `scripts/deploy-live.sh`-val; ha az elo',
    '   faba irsz, a deploy MEGTAGADJA a frissitest es a futo app beragad.',
    '',
    'Ha veletlenul megis az elo faban kezdtel: NE commitolj ott, nyiss worktree-t es',
    'vidd at oda a valtoztatast. A guard hook (`no-live-tree-commit.py`) a kozvetlen',
    'commit/add-ot az elo main checkoutban meg is allitja.',
    '',
    '**TORLES AZ ELO FABAN TILOS.** Az elo checkoutban nem torolsz, nem helyezel at,',
    'nem csonkitasz semmit (`rm`, `unlink`, `mv`, `truncate`, `find -delete`, `git clean`).',
    'A mert eset (2026-10-03): `cd <worktree> && ...; rm -rf store/<adatbazis>*` -- a `cd`',
    'elbukott, a torles az elo fan futott le, es ~23 ora adat ment el (kartyak, memoriak,',
    'projektek, a tulajdonos prezentacioja es nevjegye). Torles csak worktree-ben,',
    'ABSZOLUT uttal (`rm -rf /abs/ut/.worktrees/<nev>/...`); ideiglenes fajl: /tmp vagy a',
    'session scratch-konyvtara. A `scripts/hooks/no-live-tree-delete.py` es a',
    '`no-live-store-delete.py` az elo faban megallitja; az elo fan torles csak a tulajdonos',
    'dontesevel.',
  ].join('\n')
}

/** Beviszi a "soha ne dolgozz kozvetlenul az elo tree-ben" doktrinat egy agens
 *  sajat CLAUDE.md-jebe. A fo agens ezt a gepszintu valtozatbol kapja
 *  (ensureGlobalNoLiveTreeRule), ugyanugy, mint a tobbi marker-blokkot. */
export function ensureNoLiveTreeSection(name: string): LandingOutcome {
  if (name === MAIN_AGENT_ID) return 'skipped-main'
  const claudeMdPath = join(agentDir(name), 'CLAUDE.md')
  if (!existsSync(claudeMdPath)) return 'no-file'

  const block = `${NO_LIVE_TREE_BEGIN}\n${buildNoLiveTreeBody()}\n${NO_LIVE_TREE_END}`

  let existing: string
  try {
    existing = readFileSync(claudeMdPath, 'utf-8')
  } catch {
    return 'unreadable'
  }

  const updated = NO_LIVE_TREE_BLOCK_RE.test(existing)
    ? existing.replace(NO_LIVE_TREE_BLOCK_RE, block)
    : existing.trimEnd() + '\n\n' + block + '\n'

  if (updated === existing) return 'current'
  atomicWriteFileSync(claudeMdPath, updated)
  return 'written'
}

/** Gepszintu valtozat: egy worktree-ben dolgozo agens (es a fo agens) sosem
 *  olvassa a sajat agents/<nev>/CLAUDE.md-jet, ~/.claude/CLAUDE.md az egyetlen
 *  fajl, amit minden Claude Code session olvas, barhonnan is fut. */
export function ensureGlobalNoLiveTreeRule(): void {
  const dir = join(homedir(), '.claude')
  const path = join(dir, 'CLAUDE.md')
  const block = `${NO_LIVE_TREE_BEGIN}\n${buildNoLiveTreeBody()}\n${NO_LIVE_TREE_END}`

  let existing = ''
  if (existsSync(path)) {
    try {
      existing = readFileSync(path, 'utf-8')
    } catch {
      return
    }
  } else {
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      return
    }
  }

  const updated = NO_LIVE_TREE_BLOCK_RE.test(existing)
    ? existing.replace(NO_LIVE_TREE_BLOCK_RE, block)
    : existing.trim() === ''
      ? block + '\n'
      : existing.trimEnd() + '\n\n' + block + '\n'

  if (updated === existing) return
  atomicWriteFileSync(path, updated)
}

// Builds the "always send a completion signal on the owner's channel" body.
// Single source of truth for both the per-agent and machine-wide writers.
// ASCII-only (no accents) to match the other generated blocks; the accented
// human-facing copy lives in the tracked CLAUDE.md / CLAUDE.md.template.
function buildCompletionReportBody(): string {
  return [
    '## FELADAT VEGEN KOTELEZO KESZ-JELZES A TULAJDONOSNAK',
    '',
    'Ha egy rad bizott feladatot ELVEGZEL, a vegen KOTELEZO egy rovid "kesz" uzenet a',
    'tulajdonos sajat csatornajan -- MI lett kesz + ellenorizheto azonosito',
    '(commit/PR/kartya). A befejezes jelzese a feladat resze, nem kulon engedelyhez',
    'kotott extra. IDE tartozik minden rad bizott munka befejezese; NEM tartozik ide',
    'a csendes heartbeat es a sajat belso karbantartas. Az uzenet EGY rovid sor.',
    '',
    'Ez nem mond ellent a "kieskeskor hallgatsz" szabalynak: kifutott kerettel nem',
    'irsz, de amint egy feladat kesz, a kesz-jelzes kotelezo.',
  ].join('\n')
}

/** Beviszi a "feladat vegen kotelezo kesz-jelzes" doktrinat egy agens sajat
 *  CLAUDE.md-jebe. A fo agens ezt a gepszintu valtozatbol kapja
 *  (ensureGlobalCompletionReportRule), ugyanugy, mint a tobbi marker-blokkot. */
export function ensureCompletionReportSection(name: string): LandingOutcome {
  if (name === MAIN_AGENT_ID) return 'skipped-main'
  const claudeMdPath = join(agentDir(name), 'CLAUDE.md')
  if (!existsSync(claudeMdPath)) return 'no-file'

  const block = `${COMPLETION_REPORT_BEGIN}\n${buildCompletionReportBody()}\n${COMPLETION_REPORT_END}`

  let existing: string
  try {
    existing = readFileSync(claudeMdPath, 'utf-8')
  } catch {
    return 'unreadable'
  }

  const updated = COMPLETION_REPORT_BLOCK_RE.test(existing)
    ? existing.replace(COMPLETION_REPORT_BLOCK_RE, block)
    : existing.trimEnd() + '\n\n' + block + '\n'

  if (updated === existing) return 'current'
  atomicWriteFileSync(claudeMdPath, updated)
  return 'written'
}

/** Gepszintu valtozat: a fo agens (es a worktree-ben dolgozo agensek) a
 *  ~/.claude/CLAUDE.md-t olvassak, barhonnan is futnak. */
export function ensureGlobalCompletionReportRule(): void {
  const dir = join(homedir(), '.claude')
  const path = join(dir, 'CLAUDE.md')
  const block = `${COMPLETION_REPORT_BEGIN}\n${buildCompletionReportBody()}\n${COMPLETION_REPORT_END}`

  let existing = ''
  if (existsSync(path)) {
    try {
      existing = readFileSync(path, 'utf-8')
    } catch {
      return
    }
  } else {
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      return
    }
  }

  const updated = COMPLETION_REPORT_BLOCK_RE.test(existing)
    ? existing.replace(COMPLETION_REPORT_BLOCK_RE, block)
    : existing.trim() === ''
      ? block + '\n'
      : existing.trimEnd() + '\n\n' + block + '\n'

  if (updated === existing) return
  atomicWriteFileSync(path, updated)
}

/** A "kesz kartya azonnal a varakozoba" doktrina szovege. Host-agnosztikus:
 *  nem nevez meg tulajdonost es nem tartalmaz utvonalat (a template-identity
 *  higiene-teszt ezt ki is kenyszeriti). */
function buildKanbanWaitingMoveBody(): string {
  return [
    '## KESZ KARTYA AZONNAL A VARAKOZOBA -- A STATUSZT NEM FELEJTJUK EL',
    '',
    'Ha egy kanban kartya MUNKAJA ELKESZUL (landolt PR, kesz elemzes, kesz javitas),',
    'UGYANABBAN a lepesben AT KELL TENNI a kartyat "waiting" (varakozo) oszlopba --',
    'azonnal, amikor befejezted. A "done"-t SOHA nem te teszed meg, csak a tulajdonos;',
    'te a "waiting"-ig viszed. Ha egy kartya valodi allapota valtozik, az OSZLOPAT is',
    'mozgatni kell: egy "kesz, de meg in_progress-ben allo" kartya hazugsag a tablan.',
    '',
    'A tulajdonos a "waiting" oszlopbol viszi be a kartyat a jovahagyasokba, ezert a',
    'kesz munka ott lathato. Ez NEM mond ellent a "visszafele mozgatas csak kerdes',
    'utan" szabalynak: elore (in_progress -> waiting) rutin es kotelezo; a tilalom CSAK',
    'a visszafele mozgatasra (waiting -> korabbi oszlop) all.',
    '',
    'DE: a "waiting"-be CSAK KESZ kartya mehet. Mielott atteszed, ELLENORIZD AZ OSSZES',
    'PONTOT (lepesek, alfeladat-kartyak, a leirasban es a kommentekben szereplo',
    'teendok). Ha akar EGY is nyitott, a kartya in_progress-ben marad es a munka megy',
    'tovabb -- egy fel-kesz kartya a varakozoban hazugsag. A mozgatasi kereshez ird',
    'hozza: "all_points_done": true (ezzel mondod ki, hogy mindent leellenoriztel);',
    'nyitott alfeladat mellett a szerver 409-cel visszautasitja.',
  ].join('\n')
}

/** Beviszi a "kesz kartya azonnal a varakozoba" doktrinat egy agens sajat
 *  CLAUDE.md-jebe. A fo agens ezt a gepszintu valtozatbol kapja
 *  (ensureGlobalKanbanWaitingMoveRule), ugyanugy, mint a tobbi marker-blokkot. */
export function ensureKanbanWaitingMoveSection(name: string): LandingOutcome {
  if (name === MAIN_AGENT_ID) return 'skipped-main'
  const claudeMdPath = join(agentDir(name), 'CLAUDE.md')
  if (!existsSync(claudeMdPath)) return 'no-file'

  const block = `${KANBAN_WAITING_MOVE_BEGIN}\n${buildKanbanWaitingMoveBody()}\n${KANBAN_WAITING_MOVE_END}`

  let existing: string
  try {
    existing = readFileSync(claudeMdPath, 'utf-8')
  } catch {
    return 'unreadable'
  }

  const updated = KANBAN_WAITING_MOVE_BLOCK_RE.test(existing)
    ? existing.replace(KANBAN_WAITING_MOVE_BLOCK_RE, block)
    : existing.trimEnd() + '\n\n' + block + '\n'

  if (updated === existing) return 'current'
  atomicWriteFileSync(claudeMdPath, updated)
  return 'written'
}

/** Gepszintu valtozat: a fo agens (es a worktree-ben dolgozo agensek) a
 *  ~/.claude/CLAUDE.md-t olvassak, barhonnan is futnak. */
export function ensureGlobalKanbanWaitingMoveRule(): void {
  const dir = join(homedir(), '.claude')
  const path = join(dir, 'CLAUDE.md')
  const block = `${KANBAN_WAITING_MOVE_BEGIN}\n${buildKanbanWaitingMoveBody()}\n${KANBAN_WAITING_MOVE_END}`

  let existing = ''
  if (existsSync(path)) {
    try {
      existing = readFileSync(path, 'utf-8')
    } catch {
      return
    }
  } else {
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      return
    }
  }

  const updated = KANBAN_WAITING_MOVE_BLOCK_RE.test(existing)
    ? existing.replace(KANBAN_WAITING_MOVE_BLOCK_RE, block)
    : existing.trim() === ''
      ? block + '\n'
      : existing.trimEnd() + '\n\n' + block + '\n'

  if (updated === existing) return
  atomicWriteFileSync(path, updated)
}

/** A "kartyara a SORSZAMAVAL hivatkozunk" doktrina szovege (kanban #369).
 *  Host-agnosztikus: nem nevez meg tulajdonost es nem tartalmaz utvonalat. */
function buildCardReferenceBody(): string {
  return [
    '## KARTYARA MINDIG A SORSZAMAVAL HIVATKOZZ (#N)',
    '',
    'Ha egy kanban kartyat megnevezel (Telegram, komment, commit, PR, jelentes, masik',
    'agensnek), MINDIG a kartya SORSZAMAT ird: `#369`. A tulajdonos a tablan ezt latja;',
    'a 8 karakteres belso azonosito (pl. `27410f1b`) neki semmit nem mond. A sorszam a',
    '`seq` mezo (`GET /api/kanban`), az adatbazisban `kanban_cards.rowid` -- ha csak a',
    'belso azonositod van, ELOBB kerdezd le. A belso azonosito CSAK zarojelben, a',
    'sorszam UTAN allhat, ha egy parancsnak kell: `#369 (27410f1b)`. Egymagaban SOHA.',
  ].join('\n')
}

/** Beviszi a "kartyara a sorszamaval" doktrinat egy agens sajat CLAUDE.md-
 *  jebe. A fo agens a gepszintu valtozatbol es a sablonbol kapja. */
export function ensureCardReferenceSection(name: string): LandingOutcome {
  if (name === MAIN_AGENT_ID) return 'skipped-main'
  const claudeMdPath = join(agentDir(name), 'CLAUDE.md')
  if (!existsSync(claudeMdPath)) return 'no-file'

  const block = `${CARD_REFERENCE_BEGIN}\n${buildCardReferenceBody()}\n${CARD_REFERENCE_END}`

  let existing: string
  try {
    existing = readFileSync(claudeMdPath, 'utf-8')
  } catch {
    return 'unreadable'
  }

  const updated = CARD_REFERENCE_BLOCK_RE.test(existing)
    ? existing.replace(CARD_REFERENCE_BLOCK_RE, block)
    : existing.trimEnd() + '\n\n' + block + '\n'

  if (updated === existing) return 'current'
  atomicWriteFileSync(claudeMdPath, updated)
  return 'written'
}

/** Gepszintu valtozat (~/.claude/CLAUDE.md): a worktree-ben futo es a fo
 *  agens is ezt olvassa, barhonnan indul. */
export function ensureGlobalCardReferenceRule(): void {
  const dir = join(homedir(), '.claude')
  const path = join(dir, 'CLAUDE.md')
  const block = `${CARD_REFERENCE_BEGIN}\n${buildCardReferenceBody()}\n${CARD_REFERENCE_END}`

  let existing = ''
  if (existsSync(path)) {
    try {
      existing = readFileSync(path, 'utf-8')
    } catch {
      return
    }
  } else {
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      return
    }
  }

  const updated = CARD_REFERENCE_BLOCK_RE.test(existing)
    ? existing.replace(CARD_REFERENCE_BLOCK_RE, block)
    : existing.trim() === ''
      ? block + '\n'
      : existing.trimEnd() + '\n\n' + block + '\n'

  if (updated === existing) return
  atomicWriteFileSync(path, updated)
}

// --- Owner-language rule (kanban #416, owner 2026-09-27) --------------------
//
// Since the Telegram progress mirror went live in verbose mode, the agents'
// visible terminal text reaches the owner's chat as "▸ ..." messages. That
// text was English, so every agent suddenly "spoke English" on Telegram. The
// mirror now drops foreign-language blocks (src/progress-mirror.ts); this rule
// makes the agents write that text in the owner's language in the first place,
// so the owner keeps seeing the progress instead of silence.
const OWNER_LANGUAGE_BEGIN = '<!-- BEGIN GENERATED: owner-language-rule (auto-generated, do not edit by hand) -->'
const OWNER_LANGUAGE_END = '<!-- END GENERATED: owner-language-rule -->'
const OWNER_LANGUAGE_BLOCK_RE = new RegExp(
  `${OWNER_LANGUAGE_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${OWNER_LANGUAGE_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
)

/** A "tulajdonos nyelven irunk" szabaly szovege. A telepites nyelvet
 *  (APP_LANG) koveti, nem nevez meg tulajdonost. */
export function buildOwnerLanguageBody(lang: string = APP_LANG): string {
  if (lang === 'en') {
    return [
      '## WRITE TO THE OWNER IN ENGLISH ONLY -- THE TERMINAL TEXT TOO',
      '',
      'Every message to the owner is in English. Your visible text in the',
      'terminal counts as well: the progress mirror forwards it to the',
      'owner\'s chat. Code, commit messages and technical docs follow the',
      'project\'s own rules.',
    ].join('\n')
  }
  return [
    '## A TULAJDONOSNAK KIZAROLAG MAGYARUL -- A TERMINAL-SZOVEG IS',
    '',
    'A tulajdonosnak minden uzenet magyarul megy. A terminalba irt lathato',
    'szoveged is ide tartozik: a haladas-tukor (Telegram, "verbose" mod) ezt',
    'tovabbitja a tulajdonos csatornajara "▸" kezdetu uzenetekben. Ezert a',
    'munka kozbeni magyarazo mondataidat is magyarul ird ("Megnezem a',
    'naplot.", nem "Let me check the log."). Kod, kommentek, commit-uzenet',
    'es technikai dokumentacio tovabbra is angolul -- az nem a tulajdonosnak',
    'szolo szoveg.',
  ].join('\n')
}

/** Beviszi a nyelvi szabalyt egy agens sajat CLAUDE.md-jebe. */
export function ensureOwnerLanguageSection(name: string): LandingOutcome {
  if (name === MAIN_AGENT_ID) return 'skipped-main'
  const claudeMdPath = join(agentDir(name), 'CLAUDE.md')
  if (!existsSync(claudeMdPath)) return 'no-file'

  const block = `${OWNER_LANGUAGE_BEGIN}\n${buildOwnerLanguageBody()}\n${OWNER_LANGUAGE_END}`

  let existing: string
  try {
    existing = readFileSync(claudeMdPath, 'utf-8')
  } catch {
    return 'unreadable'
  }

  const updated = OWNER_LANGUAGE_BLOCK_RE.test(existing)
    ? existing.replace(OWNER_LANGUAGE_BLOCK_RE, block)
    : existing.trimEnd() + '\n\n' + block + '\n'

  if (updated === existing) return 'current'
  atomicWriteFileSync(claudeMdPath, updated)
  return 'written'
}

/** Gepszintu valtozat (~/.claude/CLAUDE.md): a fo agens es a worktree-ben
 *  futo agens is ezt olvassa. */
export function ensureGlobalOwnerLanguageRule(): void {
  const dir = join(homedir(), '.claude')
  const path = join(dir, 'CLAUDE.md')
  const block = `${OWNER_LANGUAGE_BEGIN}\n${buildOwnerLanguageBody()}\n${OWNER_LANGUAGE_END}`

  let existing = ''
  if (existsSync(path)) {
    try {
      existing = readFileSync(path, 'utf-8')
    } catch {
      return
    }
  } else {
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      return
    }
  }

  const updated = OWNER_LANGUAGE_BLOCK_RE.test(existing)
    ? existing.replace(OWNER_LANGUAGE_BLOCK_RE, block)
    : existing.trim() === ''
      ? block + '\n'
      : existing.trimEnd() + '\n\n' + block + '\n'

  if (updated === existing) return
  atomicWriteFileSync(path, updated)
}

// --- Availability rule (kanban #463, owner 2026-10-02) ----------------------
//
// An agent's quota reset went unnoticed for hours because the main agent kept
// repeating an old "exhausted" reading. The watcher (src/web/agent-availability-
// watch.ts) now measures every agent every minute; this rule tells every agent
// to read THAT, never its own earlier statement, and to hand work to whoever
// just became available.
const AVAILABILITY_BEGIN = '<!-- BEGIN GENERATED: availability-rule (auto-generated, do not edit by hand) -->'
const AVAILABILITY_END = '<!-- END GENERATED: availability-rule -->'
const AVAILABILITY_BLOCK_RE = new RegExp(
  `${AVAILABILITY_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${AVAILABILITY_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
)

export function buildAvailabilityBody(): string {
  return [
    '## ELERHETOSEGROL ELO ALLAPOTOT NEZZ, KORABBI MERES NEM FORRAS',
    '',
    'Mielott BARMIT mondasz egy masik agens elerhetosegerol vagy kereterol (fut-e,',
    'kimerult-e, mikor all vissza), nezd meg az ELO allapotot: GET /api/agents/availability',
    '(agensenkent: available, reason, since, resetsAt, measuredAt) vagy az uzenetkuldes',
    'WARN-ja. A sajat korabbi mondatod es egy regi meres NEM forras. Ha egy agens',
    'elerhetove valt es van varakozo munka, add ki neki AZONNAL: nem kell, hogy a',
    'tulajdonos ra kerdezzen. Aki felebred, maga is folytatja a sajat fuggo munkajat',
    '("[ELERHETO]" uzenet a rendszertol): arra nem kell masra varnia.',
  ].join('\n')
}

/** Beviszi az elerhetoseg-szabalyt egy agens sajat CLAUDE.md-jebe. */
export function ensureAvailabilitySection(name: string): LandingOutcome {
  if (name === MAIN_AGENT_ID) return 'skipped-main'
  const claudeMdPath = join(agentDir(name), 'CLAUDE.md')
  if (!existsSync(claudeMdPath)) return 'no-file'

  const block = `${AVAILABILITY_BEGIN}\n${buildAvailabilityBody()}\n${AVAILABILITY_END}`

  let existing: string
  try {
    existing = readFileSync(claudeMdPath, 'utf-8')
  } catch {
    return 'unreadable'
  }

  const updated = AVAILABILITY_BLOCK_RE.test(existing)
    ? existing.replace(AVAILABILITY_BLOCK_RE, block)
    : existing.trimEnd() + '\n\n' + block + '\n'

  if (updated === existing) return 'current'
  atomicWriteFileSync(claudeMdPath, updated)
  return 'written'
}

/** Gepszintu valtozat (~/.claude/CLAUDE.md): a fo agens es a worktree-ben
 *  futo agens is ezt olvassa. */
export function ensureGlobalAvailabilityRule(): void {
  const dir = join(homedir(), '.claude')
  const path = join(dir, 'CLAUDE.md')
  const block = `${AVAILABILITY_BEGIN}\n${buildAvailabilityBody()}\n${AVAILABILITY_END}`

  let existing = ''
  if (existsSync(path)) {
    try {
      existing = readFileSync(path, 'utf-8')
    } catch {
      return
    }
  } else {
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      return
    }
  }

  const updated = AVAILABILITY_BLOCK_RE.test(existing)
    ? existing.replace(AVAILABILITY_BLOCK_RE, block)
    : existing.trim() === ''
      ? block + '\n'
      : existing.trimEnd() + '\n\n' + block + '\n'

  if (updated === existing) return
  atomicWriteFileSync(path, updated)
}

// --- Short-reply rule (kanban #494, owner 2026-10-04) ------------------------
//
// The owner answered "A" to an A/B question and the agent asked back which
// question that was, though its own question sat in its transcript. A short
// reply is only ambiguous if the agent does not look back; the rule makes the
// look-back mandatory before any counter-question.
const SHORT_REPLY_BEGIN = '<!-- BEGIN GENERATED: short-reply-rule (auto-generated, do not edit by hand) -->'
const SHORT_REPLY_END = '<!-- END GENERATED: short-reply-rule -->'
const SHORT_REPLY_BLOCK_RE = new RegExp(
  `${SHORT_REPLY_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${SHORT_REPLY_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
)

export function buildShortReplyBody(): string {
  return [
    '## ROVID VALASZ ELOTT VISSZANEZ A SAJAT UZENETEDRE, ES CSAK UTANA KERDEZZ',
    '',
    'Ha a tulajdonos egy rovid valaszt kuld ("A", "B", "igen", "nem", "jo", "mehet"),',
    'az VALASZ a SAJAT utolso kimeno kerdesedre. ELOSZOR nezd vissza a sajat utolso',
    '10-20 kimeno uzeneted (a session-naplod, vagy a csatorna sajat uzenetei), keresd',
    'meg a nyitott A/B vagy igen/nem kerdest, es azzal dolgozz tovabb. Visszakerdezni',
    'CSAK akkor szabad, ha a visszanezes utan is tobb nyitott kerdes illene a valaszra,',
    'vagy egy sem; ilyenkor mondd meg, MIT talaltal, es mit kerdezel. A "nem latom,',
    'melyik kerdesre valaszol" hiba, nem ovatossag: a sajat uzeneted a naplodban van.',
  ].join('\n')
}

/** Beviszi a rovid-valasz szabalyt egy agens sajat CLAUDE.md-jebe. */
export function ensureShortReplySection(name: string): LandingOutcome {
  if (name === MAIN_AGENT_ID) return 'skipped-main'
  const claudeMdPath = join(agentDir(name), 'CLAUDE.md')
  if (!existsSync(claudeMdPath)) return 'no-file'

  const block = `${SHORT_REPLY_BEGIN}\n${buildShortReplyBody()}\n${SHORT_REPLY_END}`

  let existing: string
  try {
    existing = readFileSync(claudeMdPath, 'utf-8')
  } catch {
    return 'unreadable'
  }

  const updated = SHORT_REPLY_BLOCK_RE.test(existing)
    ? existing.replace(SHORT_REPLY_BLOCK_RE, block)
    : existing.trimEnd() + '\n\n' + block + '\n'

  if (updated === existing) return 'current'
  atomicWriteFileSync(claudeMdPath, updated)
  return 'written'
}

/** Gepszintu valtozat (~/.claude/CLAUDE.md): a fo agens es a worktree-ben
 *  futo agens is ezt olvassa. */
export function ensureGlobalShortReplyRule(): void {
  const dir = join(homedir(), '.claude')
  const path = join(dir, 'CLAUDE.md')
  const block = `${SHORT_REPLY_BEGIN}\n${buildShortReplyBody()}\n${SHORT_REPLY_END}`

  let existing = ''
  if (existsSync(path)) {
    try {
      existing = readFileSync(path, 'utf-8')
    } catch {
      return
    }
  } else {
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      return
    }
  }

  const updated = SHORT_REPLY_BLOCK_RE.test(existing)
    ? existing.replace(SHORT_REPLY_BLOCK_RE, block)
    : existing.trim() === ''
      ? block + '\n'
      : existing.trimEnd() + '\n\n' + block + '\n'

  if (updated === existing) return
  atomicWriteFileSync(path, updated)
}

// --- statusLine: the rate-limit snapshot producer ---------------------------
//
// scripts/hooks/statusline.py is what writes store/rate-limit-status/<agent>.json;
// rate-limit-guard.py (wired from the template) and the Overview keret widget
// only READ that file. Until this existed the statusLine key was set by hand or
// by scripts/install-statusline.sh, which no installer calls -- so on a fresh
// install the guard never saw a number and stayed silent, and the widget showed
// nothing (audit f97acc32, 2026-09-23).
//
// The identity is passed explicitly (--agent / --project-root) instead of
// derived from cwd: an agent working inside a worktree would otherwise report
// under the wrong name, and the settings file this lands in is per-agent anyway.
export function statusLineCommand(name: string): string {
  const script = join(PROJECT_ROOT, 'scripts', 'hooks', 'statusline.py')
  // Same fail-open shape as the python hooks: a missing script prints nothing
  // and exits 0, never a broken status line.
  return `bash -c '[ -f "${script}" ] && exec python3 "${script}" --agent "${name}" --project-root "${PROJECT_ROOT}"; exit 0'`
}

/** A statusLine this module may manage: absent, or already a statusline.py of
 *  ours (any older path/shape). A custom statusline the owner set is left alone. */
function isManagedStatusLine(v: unknown): boolean {
  if (v === undefined || v === null) return true
  if (typeof v !== 'object') return false
  const cmd = (v as { command?: unknown }).command
  return typeof cmd === 'string' && cmd.includes('statusline.py')
}

export function ensureStatusLine(name: string): boolean {
  const settingsPath = agentSettingsPath(name)
  let settings: Record<string, unknown> = {}
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) } catch { return false }
  }
  if (!isManagedStatusLine(settings.statusLine)) return false
  const desired = { type: 'command', command: statusLineCommand(name), padding: 0 }
  if (JSON.stringify(settings.statusLine) === JSON.stringify(desired)) return false
  if (isUnsafeHookCommand(desired.command)) return false
  settings.statusLine = desired
  if (name !== MAIN_AGENT_ID) mkdirSync(join(agentDir(name), '.claude'), { recursive: true })
  else mkdirSync(dirname(settingsPath), { recursive: true })
  atomicWriteFileSync(settingsPath, JSON.stringify(settings, null, 2))
  return true
}
