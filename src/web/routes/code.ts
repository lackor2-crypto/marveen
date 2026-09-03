// REST surface of the VS Code Claude Code bridge.
//
// Two kinds of caller:
//   * PRODUCERS  -- the owner (dashboard / curl), the Telegram code bot, and
//     Marvin's dispatch skill. They create tasks and read status.
//   * THE WORKER -- the Windows-side executor. It reports discovered sessions,
//     claims one task at a time, heartbeats while `claude.exe` runs, and posts
//     the result back.
//
// Every path here sits behind the normal dashboard auth gate (Authorization:
// Bearer <store/.dashboard-token>) -- no new public surface was opened for the
// worker. On top of that, the worker paths additionally require a LOOPBACK peer:
// the Windows host reaches WSL through localhost forwarding and shows up as
// 127.0.0.1 (measured), so a remote caller with a leaked token still cannot
// impersonate the executor or drain the queue.

import { json, readBody, serveFile } from '../http-helpers.js'
import { parseMultipart } from '../multipart.js'
import { probeWorkspace } from '../code-bridge-workspace.js'
import { generateSkillMd } from '../agent-scaffold.js'
import { parseHumanSkillScope, withSkillScope, seedGlobalSkill, HUMAN_SKILL_SCOPES } from '../skill-scope.js'
import { atomicWriteFileSync } from '../atomic-write.js'
import { logger } from '../../logger.js'
import { expectedWorkerVersion } from '../code-worker-version.js'
import {
  CODE_BRIDGE_ENABLED, CODE_PERMISSION_MODE, PROJECT_ROOT,
  CODE_BOT_TOKEN, CODE_BOT_ALLOWED_CHAT_IDS, CODE_BRIDGE_EXCLUDE,
} from '../../config.js'
import {
  listCodeSessions, getCodeSession, upsertCodeSession, deleteCodeSession,
  dismissCodeWorkspace, undismissCodeWorkspace, isDismissedWorkspace,
  enqueueCodeTask, getCodeTask, getCodeTaskByPrefix, listCodeTasks,
  claimNextCodeTask, heartbeatCodeTask, completeCodeTaskDetailed, cancelCodeTask,
  clearFinishedCodeTasks,
  pruneUnreportedCodeSessions,
  recordCodeCandidates,
  listCodeCandidates,
  aliasFromWorkspacePath, normalizeAlias, isExcludedProject,
  recordCodeWorkerSeen, codeBridgeHealth, WORKER_STALE_MS, listCodeTabs,
  requestCodeTabClose, takeCodeTabCloseRequests, findCodeTabLocation,
  type CodeTaskStatus, type CodeTaskOrigin, type CodeTab,
} from '../code-bridge-store.js'
import { readCodeConversation, statCodeConversation } from '../code-conversation.js'
import { readFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync, copyFileSync, readdirSync, statSync, rmSync } from 'node:fs'
import { join, extname } from 'node:path'
import { getEffectiveSettingValue, setOverride } from '../../settings-store.js'
import { notifyCodeTaskFinished } from '../code-bridge-notify.js'
import { resolveCodeBotIdentity } from '../code-bridge-telegram.js'
import { readBrokerConfig } from '../context-broker-store.js'
import { BROKER_ROLE_IDS } from '../../context-broker.js'
import type { RouteContext } from './types.js'

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/**
 * Which kind of host Marveen itself runs on -- 'wsl', 'windows' or 'unix'.
 *
 * This decides what the install card may print as the token's path, and there
 * is exactly one topology where a `\\wsl.localhost\...` path is right. A
 * fresh install can just as easily be Marveen native on Windows, or Marveen on
 * a Linux host with the worker on a separate PC -- and the page prints what it
 * is told, so guessing wrong hands the new owner a command that cannot work
 * and no hint as to why.
 *
 * `WSL_DISTRO_NAME` is NOT the detector: it is absent under a systemd user
 * service, which is how Marveen actually runs. /proc/version carries the
 * 'microsoft' marker in every WSL2 kernel and survives losing the env.
 */
export function detectHostKind(): 'wsl' | 'windows' | 'unix' {
  if (process.platform === 'win32') return 'windows'
  if (process.platform !== 'linux') return 'unix'
  if (process.env['WSL_DISTRO_NAME'] || process.env['WSL_INTEROP']) return 'wsl'
  try {
    if (/microsoft/i.test(readFileSync('/proc/version', 'utf8'))) return 'wsl'
  } catch {
    // No /proc (a container without it, a BSD): plain unix is the safe answer.
  }
  return 'unix'
}

// ---- identitas + skillek: hol laknak a fajlok -------------------------------
//
// A kod-hid egy UGYNOK a feluleten, de nincs `agents/<nev>` mappaja, ezert a
// sajat holmija ide kerul. Friss telepitesen ez a mappa NINCS meg: minden
// olvaso ag ugy van megirva, hogy a hianya = "meg nincs beallitva", nem hiba.
const CODE_BRIDGE_DIR = join(PROJECT_ROOT, 'store', 'code-bridge')
const AVATAR_EXTS = ['.png', '.jpg', '.jpeg', '.webp']

function avatarCandidates(): string[] {
  return AVATAR_EXTS.map((ext) => join(CODE_BRIDGE_DIR, `avatar${ext}`))
}

function findCodeBridgeAvatar(): string | null {
  for (const p of avatarCandidates()) if (existsSync(p)) return p
  return null
}

/** Mappaneve lesz belole, tehat ugyanaz a szigor kell, mint az ugynok-skillekre:
 *  se `..`, se elvalaszto, se rejtett nev. Ures string = elutasitas. */
function sanitizeCodeSkillName(raw: string): string {
  const name = (raw || '').trim().replace(/\s+/g, '-')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) return ''
  if (name.includes('..')) return ''
  return name
}

/** Egy VS Code-projekt skilljei a MAPPAJABAN laknak (`.claude/skills/`), mert a
 *  headless `claude.exe` is onnan olvassa oket. Nem Marveen `~/.claude/skills`-e:
 *  az egy MASIK gep masik fajlrendszere, oda irt skillt a Windows-oldali Claude
 *  soha nem latna. */
function codeSkillsDir(localWorkspacePath: string): string {
  return join(localWorkspacePath, '.claude', 'skills')
}

function readCodeSkillDescription(dir: string): string {
  try {
    const md = readFileSync(join(dir, 'SKILL.md'), 'utf-8')
    const fm = md.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    const desc = fm?.[1]?.match(/^description:\s*(.+)$/m)?.[1]?.trim()
    if (desc) return desc.replace(/^["']|["']$/g, '')
    // Nincs frontmatter: az elso ertelmes sor is tobb a semminel.
    const line = md.split('\n').find((l) => l.trim() && !l.startsWith('#') && !l.startsWith('---'))
    return (line ?? '').trim()
  } catch {
    return ''
  }
}

function isLoopback(remote: string | undefined): boolean {
  return Boolean(remote && LOOPBACK.has(remote))
}

/** A malformed percent-escape ("%", "%zz") makes decodeURIComponent THROW, and
 *  an uncaught throw in a route turns a bad URL into a 500 "Szerver hiba". The
 *  raw segment is the honest fallback: it simply will not match any id. */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

async function parseJsonBody<T>(ctx: RouteContext): Promise<T | null> {
  try {
    const body = await readBody(ctx.req, { maxBytes: 2 * 1024 * 1024 })
    if (body.length === 0) return {} as T
    return JSON.parse(body.toString()) as T
  } catch {
    return null
  }
}

/** Ket utvonal ugyanarra a mappara mutat-e. A worker `C:\\Projects\\X`-et
 *  jelent, a begepelt szoveg viszont lehet `c:\\projects\\x\\` -- a Windows
 *  mindkettot ugyanannak latja, tehat mi sem kuldhetjuk a felhasznalot UUID-t
 *  vadaszni egyetlen zaro visszaper miatt. */
function sameWorkspace(a: string, b: string): boolean {
  const norm = (x: string) => x.trim().replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()
  return norm(a) !== '' && norm(a) === norm(b)
}

export async function tryHandleCode(ctx: RouteContext): Promise<boolean> {
  const { res, path, method, url } = ctx
  if (!path.startsWith('/api/code/')) return false

  // The health/config/installer surface answers even when the bridge is OFF --
  // that is exactly when the owner needs to see WHY nothing happens and switch it
  // back on. Gating these too would mean the only way back from a switch flipped
  // in the UI is hand-editing a file, which is the failure this whole page exists
  // to remove. Everything that actually MOVES a task stays behind the gate.
  // Az avatar a kartya IKONJA: kikapcsolt hid mellett is latszik a kartya,
  // tehat az ikonjanak is latszania kell -- kulonben a kikapcsolas ugy nezne
  // ki, mintha az ugynok identitasa is elveszett volna.
  const alwaysOn = path === '/api/code/health' || path === '/api/code/config'
    || path === '/api/code/worker-script' || path === '/api/code/avatar'
  if (!CODE_BRIDGE_ENABLED && !alwaysOn) {
    json(res, { error: 'code bridge disabled (CODE_BRIDGE_ENABLED=0)' }, 503)
    return true
  }

  // ---- projects / session map -------------------------------------------

  // ---- health / config / installer --------------------------------------
  //
  // Everything below exists so the bridge can be OPERATED from the dashboard
  // alone. Before these, a fresh install had no way to see whether the executor
  // was alive, no way to set the bot token without hand-editing .env, and no
  // way to get the worker onto Windows without a terminal.

  if (path === '/api/code/health' && method === 'GET') {
    const health = codeBridgeHealth()
    // Where the worker will read the dashboard token from, AS THE WORKER'S OWN
    // MACHINE SEES IT -- or `null` when no such path exists, which is the case
    // whenever the worker is on a DIFFERENT machine than Marveen. A null here
    // is not a failure: it tells the page to print the `-Token` form instead of
    // a path that would resolve to nothing on the executor's side.
    //
    // WSL_DISTRO_NAME is absent under a systemd user service, so 'Ubuntu' is the
    // fallback -- wrong only on a renamed distro, where the owner can still edit
    // the printed path by hand.
    const distro = (process.env['WSL_DISTRO_NAME'] ?? '').trim() || 'Ubuntu'
    const hostKind = detectHostKind()
    const winRoot = PROJECT_ROOT.replace(/\//g, '\\')
    const tokenPath =
      hostKind === 'wsl' ? `\\\\wsl.localhost\\${distro}${winRoot}\\store\\.dashboard-token`
      : hostKind === 'windows' ? `${winRoot}\\store\\.dashboard-token`
      : null
    // Hany mappat TALALT MAR a vegrehajto, amibol meg nem lett projekt. Enelkul
    // a nulla-projektes kartya csak azt tudja mondani, hogy "nyiss meg egy
    // projektet VS Code-ban" -- ami annak a tulajdonosnak, akinek az egyetlen
    // workspace-e kizarva var a listaban, pont a rossz iranyba mutat.
    const knownWorkspaces = listCodeSessions()
    let candFree = 0
    let candExcluded = 0
    // Boss, 2026-08-23: "a vscode os kartyarol eltunt minden miert ?" -- egy
    // levett mappa utan a kartya ugyanazt mondta, mint egy FRISS telepites
    // ("meg egyik sincs felveve"), holott a ket allapot nem ugyanaz. A nulla
    // ket dolgot jelent, ezert a levett mappakat KULON szamoljuk, es a felulet
    // ki is mondja, hogy nem hianyzik, hanem le van veve.
    let candDismissed = 0
    for (const c of listCodeCandidates()) {
      if (knownWorkspaces.some((k) => sameWorkspace(k.workspacePath, c.workspacePath))) continue
      if (isDismissedWorkspace(c.workspacePath)) candDismissed++
      else if (isExcludedProject(normalizeAlias(aliasFromWorkspacePath(c.workspacePath)))) candExcluded++
      else candFree++
    }
    json(res, {
      ...health,
      candidates: { free: candFree, excluded: candExcluded, dismissed: candDismissed },
      // Van-e sajat ikonja a hidnak. Merve (letezik-e a fajl), nem feltetelezve:
      // `false` mellett a kartya a monogramot rajzolja, ami friss telepitesen a
      // helyes alapertelmezes.
      avatar: findCodeBridgeAvatar() !== null,
      staleAfterMs: WORKER_STALE_MS,
      enabled: CODE_BRIDGE_ENABLED,
      // ★ A MENTETT ertek, a futo mellett. A ketto eltérhet: a hid a
      // beallitast INDULASKOR olvassa be, tehat egy "Leallitas" utan a mentett
      // mar 0, a futo meg 1. Enelkul a kartya a kattintas utan is azt mutatta,
      // hogy "Fut" -- a felhasznalo szamara ez ugy nezett ki, mintha a gomb
      // nem mukodne (Boss, 2026-08-23: "rakattintottam a leallitas gombra. de
      // nem allt le"). A kulonbseget a KARTYAN KIVUL is ki kell mondani.
      savedEnabled: String(getEffectiveSettingValue('CODE_BRIDGE_ENABLED')) === '1',
      permissionMode: CODE_PERMISSION_MODE,
      // The token itself is NEVER returned -- only whether one is configured.
      botConfigured: CODE_BOT_TOKEN.length > 0,
      // A kartya NEVE. `reason` valasztja szet a "nincs bot beallitva"-t a
      // "van, de nem tudtam lekerdezni"-tol; a masodikat a felulet kimondja.
      codeBot: await resolveCodeBotIdentity(),
      allowedChatIds: CODE_BOT_ALLOWED_CHAT_IDS,
      excluded: CODE_BRIDGE_EXCLUDE,
      // `tokenFile` is the path on THIS machine (always true, whatever the
      // topology) so a remote-worker install can be told which file to open.
      installHint: { tokenPath, distro, hostKind, tokenFile: `${PROJECT_ROOT}/store/.dashboard-token` },
    })
    return true
  }

  // The five settings the bridge runs on. A secret is reported as a boolean
  // ("is one set"), never echoed back -- a page that redisplays a bot token
  // puts it in the browser history, the DOM and every screenshot.
  if (path === '/api/code/config' && method === 'GET') {
    json(res, {
      CODE_BRIDGE_ENABLED: String(getEffectiveSettingValue('CODE_BRIDGE_ENABLED')),
      CODE_PERMISSION_MODE: String(getEffectiveSettingValue('CODE_PERMISSION_MODE')),
      CODE_BOT_ALLOWED_CHAT_IDS: String(getEffectiveSettingValue('CODE_BOT_ALLOWED_CHAT_IDS')),
      CODE_BRIDGE_EXCLUDE: String(getEffectiveSettingValue('CODE_BRIDGE_EXCLUDE')),
      botConfigured: String(getEffectiveSettingValue('CODE_BOT_TOKEN')).length > 0,
      // Stored values differ from LIVE ones until the dashboard restarts; the
      // page uses this to show the "restart needed" badge honestly instead of
      // pretending a saved setting already took effect.
      live: {
        enabled: CODE_BRIDGE_ENABLED,
        permissionMode: CODE_PERMISSION_MODE,
        botConfigured: CODE_BOT_TOKEN.length > 0,
        allowedChatIds: CODE_BOT_ALLOWED_CHAT_IDS,
        excluded: CODE_BRIDGE_EXCLUDE,
      },
    })
    return true
  }

  if (path === '/api/code/config' && method === 'POST') {
    const body = await parseJsonBody<Record<string, unknown>>(ctx)
    if (!body) { json(res, { error: 'invalid JSON' }, 400); return true }
    const ALLOWED = [
      'CODE_BRIDGE_ENABLED', 'CODE_PERMISSION_MODE', 'CODE_BOT_TOKEN',
      'CODE_BOT_ALLOWED_CHAT_IDS', 'CODE_BRIDGE_EXCLUDE',
    ]
    const saved = []
    for (const key of ALLOWED) {
      if (!(key in body)) continue
      const raw = body[key]
      // An untouched secret field posts back empty; that must not silently WIPE
      // a configured token. Clearing is deliberate: send null.
      if (key === 'CODE_BOT_TOKEN' && raw === '') continue
      const out = setOverride(key, raw === null ? '' : raw)
      if (!out.ok) { json(res, { error: key + ': ' + out.error }, 400); return true }
      saved.push(key)
    }
    if (saved.length === 0) { json(res, { error: 'no known settings in body' }, 400); return true }
    logger.info({ saved }, 'code-bridge: config updated from dashboard')
    // Every one of these is a boot-time const in config.ts, so the page has to
    // say so rather than let the owner believe it already took effect.
    json(res, { saved, restartRequired: true })
    return true
  }

  // Hands the worker's own source to the browser, so Windows can be set up by
  // downloading two files from this page -- no repo checkout, no UNC path to
  // type, no terminal. Served from PROJECT_ROOT and hard-restricted to the two
  // known basenames: a path parameter here would be an arbitrary file read
  // behind the dashboard token.
  if (path === '/api/code/worker-script' && method === 'GET') {
    const which = url.searchParams.get('file') === 'cmd' ? 'cmd' : 'ps1'
    const name = which === 'cmd' ? 'marvin-code-worker.cmd' : 'marvin-code-worker.ps1'
    try {
      const text = readFileSync(join(PROJECT_ROOT, 'scripts', 'windows', name), 'utf8')
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': 'attachment; filename="' + name + '"',
        'Cache-Control': 'no-store',
      })
      res.end(text)
    } catch (err) {
      logger.warn({ err, name }, 'code-bridge: worker script unreadable')
      json(res, { error: 'worker script not found in this install' }, 404)
    }
    return true
  }

  // ---- IDENTITAS: a kartya ikonja ---------------------------------------
  //
  // Boss, 2026-08-23: "attekintesben lehessen ugy pld az ikont kepet
  // valtoztatni". Ugyanaz a ket ut, mint barmelyik ugynok-kartyan: galeriabol
  // valasztas vagy sajat kep feltoltese -- vegig a FELULETROL, terminal nelkul.
  if (path === '/api/code/avatar') {
    if (method === 'GET') {
      const found = findCodeBridgeAvatar()
      // A 404 itt NEM hiba: azt jelenti, hogy meg nincs beallitva kep, es a
      // felulet a monogramot rajzolja. Friss telepitesen ez a normalis allapot.
      if (!found) { json(res, { error: 'no avatar set' }, 404); return true }
      serveFile(ctx.req, res, found, { cacheSeconds: 3600 })
      return true
    }

    if (method === 'DELETE') {
      for (const p of avatarCandidates()) { try { unlinkSync(p) } catch { /* nem volt ott */ } }
      json(res, { ok: true })
      return true
    }

    if (method === 'POST') {
      const contentType = ctx.req.headers['content-type'] || ''
      const body = await readBody(ctx.req, { maxBytes: 4 * 1024 * 1024 })
      // A regi kepeket takaritani KELL (kulonben egy .png utan feltoltott .jpg
      // mellett a regi .png maradna "az" avatar), de CSAK akkor, amikor mar van
      // mit a helyere tenni. Elobb torolni annyit jelentene, hogy egy elhasalt
      // feltoltes (nincs fajl a kerelemben, nem letezo galeria-kep) elveszi a
      // meglevo ikont is -- a felhasznalo egy sikertelen muvelet utan MEG
      // rosszabb allapotban lenne, mint elotte.
      const replaceAvatar = (write: (target: string) => void, ext: string): void => {
        mkdirSync(CODE_BRIDGE_DIR, { recursive: true })
        for (const p of avatarCandidates()) { try { unlinkSync(p) } catch { /* nem volt ott */ } }
        write(join(CODE_BRIDGE_DIR, `avatar${ext}`))
      }

      if (contentType.includes('application/json')) {
        let galleryAvatar = ''
        try { galleryAvatar = String((JSON.parse(body.toString()) as { galleryAvatar?: string }).galleryAvatar ?? '') } catch { /* lentebb elbukik */ }
        if (!galleryAvatar) { json(res, { error: 'no avatar specified' }, 400); return true }
        if (galleryAvatar.includes('..') || galleryAvatar.includes('/') || galleryAvatar.includes('\\')) {
          json(res, { error: 'invalid avatar name' }, 400); return true
        }
        const srcPath = join(PROJECT_ROOT, 'web', 'avatars', galleryAvatar)
        if (!existsSync(srcPath)) { json(res, { error: 'avatar not found' }, 404); return true }
        const ext = AVATAR_EXTS.includes(extname(galleryAvatar).toLowerCase()) ? extname(galleryAvatar).toLowerCase() : '.png'
        replaceAvatar((target) => copyFileSync(srcPath, target), ext)
        json(res, { ok: true })
        return true
      }

      const { file } = parseMultipart(body, contentType)
      if (!file) { json(res, { error: 'no file uploaded' }, 400); return true }
      const ext = AVATAR_EXTS.includes(extname(file.name).toLowerCase()) ? extname(file.name).toLowerCase() : '.png'
      replaceAvatar((target) => writeFileSync(target, file.data), ext)
      json(res, { ok: true })
      return true
    }
  }

  // ---- SKILLEK ----------------------------------------------------------
  //
  // Boss, 2026-08-23: "skilleket is lehet ehhez irni. ugye miert ne lhetne."
  //
  // Egy VS Code-projekt skilljei a projekt SAJAT mappajaban laknak
  // (`<workspace>/.claude/skills/<nev>/SKILL.md`), mert a feladatot vegrehajto
  // headless `claude.exe` is onnan olvassa oket. Marveen `~/.claude/skills`-e
  // ide nem jo: az egy masik gep masik fajlrendszere.
  //
  // ★ EZERT VAN MINDEN VALASZBAN `reachable` + `reason`. A dashboard a WSL-ben
  // ul, a mappa a Windowson; ha nem latunk oda, a nulla skill NEM azt jelenti,
  // hogy nincs egy sem. A kettot a felulet KULON mondja ki, es az okot a
  // tenyleges hibauzenetbol veszi -- nem talalgatja.
  if (path === '/api/code/skills') {
    const project = normalizeAlias(url.searchParams.get('project') ?? '')
    const readProject = (alias: string): { session: ReturnType<typeof getCodeSession>; probe: ReturnType<typeof probeWorkspace> | null } => {
      const session = getCodeSession(alias)
      return { session, probe: session ? probeWorkspace(session.workspacePath) : null }
    }

    if (method === 'GET') {
      if (!project) { json(res, { error: 'project query parameter is required' }, 400); return true }
      const { session, probe } = readProject(project)
      if (!session || !probe) { json(res, { error: 'unknown project: ' + project }, 404); return true }
      if (!probe.reachable) {
        json(res, { project, ...probe, skills: [] })
        return true
      }
      const dir = codeSkillsDir(probe.localPath!)
      let skills: Array<{ name: string; description: string; hasSkillMd: boolean }> = []
      try {
        skills = readdirSync(dir)
          .filter((f) => { try { return statSync(join(dir, f)).isDirectory() } catch { return false } })
          .map((f) => ({
            name: f,
            description: readCodeSkillDescription(join(dir, f)),
            hasSkillMd: existsSync(join(dir, f, 'SKILL.md')),
          }))
      } catch (err) {
        // A mappa hianya a normalis kezdoallapot (meg egy skill sincs); barmi
        // MAS olvasasi hiba viszont "nem latok oda", es ki kell mondani.
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'ENOENT') {
          json(res, { project, ...probe, reachable: false, reason: err instanceof Error ? err.message : String(err), skills: [] })
          return true
        }
      }
      json(res, { project, ...probe, skillsDir: dir, skills })
      return true
    }

    if (method === 'POST') {
      const body = await parseJsonBody<{ project?: string; name?: string; description?: string; skillScope?: string }>(ctx)
      if (!body) { json(res, { error: 'invalid JSON' }, 400); return true }
      const alias = normalizeAlias(String(body.project ?? ''))
      const skillName = sanitizeCodeSkillName(String(body.name ?? ''))
      const description = String(body.description ?? '').trim()
      if (!alias) { json(res, { error: 'project is required' }, 400); return true }
      if (!skillName) { json(res, { error: 'invalid skill name' }, 400); return true }
      if (!description) { json(res, { error: 'skill description is required' }, 400); return true }
      // Scope nelkul itt sincs skill -- a kapu minden letrehozo uton ugyanaz.
      const skillScope = parseHumanSkillScope(body.skillScope)
      if (!skillScope) {
        json(res, { error: 'skillScope is required', allowed: HUMAN_SKILL_SCOPES, code: 'skill_scope_required' }, 400)
        return true
      }

      const { session, probe } = readProject(alias)
      if (!session || !probe) { json(res, { error: 'unknown project: ' + alias }, 404); return true }
      // Nem irunk vakon: ha nem latunk a mappara, azt mondjuk meg, es nem azt,
      // hogy "sikerult". A `reason` a tenyleges hibauzenet.
      if (!probe.reachable) { json(res, { error: probe.reason, ...probe }, 409); return true }

      const skillDir = join(codeSkillsDir(probe.localPath!), skillName)
      if (existsSync(skillDir)) { json(res, { error: 'skill already exists' }, 409); return true }
      mkdirSync(skillDir, { recursive: true })
      let seeded = false
      try {
        const skillMd = withSkillScope(await generateSkillMd(skillName, description), skillScope, skillName)
        atomicWriteFileSync(join(skillDir, 'SKILL.md'), skillMd)
        // Egy kod-projektben szuletett altalanos skill is beeg a Marveenbe:
        // "menet kozben is ha egy olyan altalanos skill jon letre azt is mind
        // be kell egetni" (Boss, 2026-08-30).
        seeded = seedGlobalSkill(skillName, skillMd, skillScope).seeded
      } catch (err) {
        rmSync(skillDir, { recursive: true, force: true })
        logger.warn({ err, alias, skillName }, 'code-bridge: skill generation failed')
        json(res, { error: err instanceof Error ? err.message : String(err) }, 500)
        return true
      }
      logger.info({ alias, skillName, skillDir, skillScope, seeded }, 'code-bridge: skill created')
      json(res, { ok: true, name: skillName, skillDir, skillScope, seeded })
      return true
    }

    if (method === 'DELETE') {
      const skillName = sanitizeCodeSkillName(url.searchParams.get('name') ?? '')
      if (!project) { json(res, { error: 'project query parameter is required' }, 400); return true }
      if (!skillName) { json(res, { error: 'invalid skill name' }, 400); return true }
      const { session, probe } = readProject(project)
      if (!session || !probe) { json(res, { error: 'unknown project: ' + project }, 404); return true }
      if (!probe.reachable) { json(res, { error: probe.reason, ...probe }, 409); return true }
      const skillDir = join(codeSkillsDir(probe.localPath!), skillName)
      if (!existsSync(skillDir)) { json(res, { error: 'skill not found' }, 404); return true }
      rmSync(skillDir, { recursive: true, force: true })
      logger.info({ project, skillName }, 'code-bridge: skill deleted')
      json(res, { ok: true })
      return true
    }
  }

  // Mit lat a worker EZEN a gepen. Harom allapot, mert harom kulon teendo:
  // a mar regisztralt sor nem kell megegyszer, a kizart csak a kizaras
  // feloldasa utan vehető fel, az uj pedig egy kattintassal.
  if (path === '/api/code/candidates' && method === 'GET') {
    const known = listCodeSessions()
    const all = listCodeCandidates()
    // Ez a lista MAPPAKROL szol ("tallozas"), nem beszelgetesekrol: mappankent
    // egy sor. A worker 2026-08-23 ota minden chat fulet jelent, ezert itt a
    // legfrissebbre (`primary`) kell szurni -- kulonben ugyanaz a mappa
    // haromszor allna a listaban, haromszor felajanlott "Felvetel" gombbal.
    // A tobbi ful a `/api/code/tabs`-on erheto el.
    const candidates = all.filter((c) => c.primary).map((c) => {
      const registered = known.find((k) => k.workspacePath.toLowerCase() === c.workspacePath.toLowerCase())
      const alias = normalizeAlias(aliasFromWorkspacePath(c.workspacePath))
      return {
        workspacePath: c.workspacePath,
        sessionId: c.sessionId,
        mtime: c.mtime,
        host: c.host,
        reportedAt: c.reportedAt,
        alias: registered ? registered.project : alias,
        // NEGY allapot, mert negy kulon teendo. A "levett" (dismissed) eddig
        // "uj"-kent ment ki, holott a felhasznalo TUDATOSAN vette le -- igy a
        // felulet ujra es ujra felajanlotta felvetelre ugyanazt a mappat.
        state: registered
          ? 'registered'
          : isExcludedProject(alias)
            ? 'excluded'
            : isDismissedWorkspace(c.workspacePath)
              ? 'dismissed'
              : 'new',
        // A mappa legfrissebb beszelgetesenek felirata (a VS Code fulcimke), es
        // hogy HANY beszelgetes tartozik a mappahoz -- a tobbi a `/tabs`-on.
        title: c.title,
        tabCount: all.filter((x) => x.workspacePath.toLowerCase() === c.workspacePath.toLowerCase()).length,
      }
    })
    // ★ A NULLA KET DOLGOT JELENTHET. Az ures lista lehet "a worker megnezte a
    //   gepet, es tenyleg nincs nyitva Claude Code", vagy "a worker ota nem
    //   jelentkezett, tehat NEM LATOK ODA" -- utobbi tipikusan a vezerlopult
    //   ujrainditasa utan, amikor a jeloltek (memoriaban tartott lista) elszallnak
    //   es a kovetkezo jelentesig ures. A kettot a felulet nem talalhatja ki a
    //   darabszambol, ezert megmondjuk: megkerdezzuk magat a forrast (jelentkezik-e
    //   a worker, es mikor jelentkezett utoljara).
    const health = codeBridgeHealth()
    json(res, {
      candidates,
      /** Latunk-e egyaltalan a Windows-gepre. `false` mellett a nulla NEM jelent
       *  ures gepet -- csak annyit, hogy nincs friss jelentesunk. */
      workerOnline: health.workerOnline,
      lastSeenAt: health.lastSeenAt ?? null,
      /** Erkezett-e mar barmilyen jelentes a vezerlopult indulasa ota. */
      reported: all.length > 0,
    })
    return true
  }

  // Egy VS Code ablakban tobb Claude Code chat ful lehet, es mindegyik KULON
  // beszelgetes ugyanabban a mappaban. Ez a vegpont mondja meg, mi van nyitva --
  // cimmel, nem UUID-vel --, hogy se a tulajnak, se Marvinnak ne kelljen nevet
  // kitalalnia es megjegyeznie: kilistazza a fuleket, es a valasztott ful
  // azonositoja megy a `POST /api/code/tasks` `sessionId` mezojebe.
  if (path === '/api/code/tabs' && method === 'GET') {
    // A csoportositas a store-ban lakik (`listCodeTabs`), hogy a Telegram `/tabs`
    // es ez a vegpont BIZTOSAN ugyanazt a listat mondja.
    json(res, listCodeTabs())
    return true
  }

  // EGY BESZELGETES TARTALMA, olvashatoan.
  //
  // Boss, 2026-08-28: "miert csk mondja hogy megvan de nem mutatja meg?" -- a
  // kartya eddig kiirta a beszelgetes nevet es a kontextus-tokenszamat, de a
  // tartalmahoz nem volt ut. Ez az a vegpont.
  //
  // A NULLA KET DOLGOT JELENTHET, ezert a valasz MINDIG mondja meg, miert
  // ures: `no-session` (ilyet nem jelentett senki), `no-path` (regi worker,
  // meg nem kuldi a napló utjat), vagy maga a rendszer hibauzenete. A
  // felulet ezekbol kulon-kulon mondatot csinal -- tippelt okot egyik sem tud.
  if (path === '/api/code/conversation' && method === 'GET') {
    const sessionId = (url.searchParams.get('session') ?? '').trim()
    if (!sessionId) { json(res, { error: 'session is required' }, 400); return true }
    const limitRaw = Number(url.searchParams.get('limit'))
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 2000) : 400
    const offsetRaw = Number(url.searchParams.get('offset'))
    const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0

    // KONNYU MOD (`meta=1`): CSAK az allapot, tartalom nelkul.
    //
    // Ezt kerdezi az elo kovetes 2-3 masodpercenkent. Egy `statSync` fut, a
    // naplo egyetlen bajtja sem olvasodik be -- enelkul a kovetes minden
    // korben vegigolvasna egy akar tobb tiz MB-os naplot (ebben a mappaban
    // 156 MB-os is van), es a "friss chat" funkcio maga tenne
    // hasznalhatatlanna a szervert.
    const metaOnly = url.searchParams.get('meta') === '1'

    // A `project` es a `workerOnline` az UTASITAS-KULDESHEZ kell (a beviteli
    // sor a nezet aljan). Ugyanabbol a bejarasbol jonnek, mint maga a ful,
    // tehat nem kerul egy kerdessel sem tobbe -- es nem is csuszhatnak szet
    // attol, amit a nezet epp mutat.
    const loc = findCodeTabLocation(sessionId)
    if (!loc) {
      json(res, {
        sessionId, entries: [], total: 0, offset: 0, hasOlder: false,
        title: null, live: null, transcriptPath: null, mtime: null, meta: metaOnly,
        // A `branchCount` a hibas uton is KIMEGY, nem marad hianyzo mezo: a
        // felulet a hianyzot ugyanugy "nulla elagazas"-nak olvasna, mint a
        // valodi nullat -- pedig itt nem tudunk rola, nem azt tudjuk, hogy nincs.
        branchCount: 0,
        // A kuldo sor ebbol tudja, hogy nincs hova kuldeni. A `null` itt nem
        // "nincs bekotve", hanem "ilyen fulrol nem tudunk" -- a ket mondat mas.
        project: null, workerOnline: null,
        // Nem "ures a beszelgetes": ilyen sessiont EGYETLEN worker sem jelentett.
        reason: 'no-session',
      })
      return true
    }
    const tab = loc.tab
    if (metaOnly) {
      json(res, {
        sessionId, title: tab.title, live: tab.live,
        contextTokens: tab.contextTokens, model: tab.model, meta: true,
        project: loc.project, workerOnline: loc.workerOnline,
        ...statCodeConversation(tab.transcriptPath, sessionId),
      })
      return true
    }
    const conv = readCodeConversation(tab.transcriptPath, sessionId, { limit, offset })
    json(res, {
      sessionId,
      title: tab.title,
      live: tab.live,
      contextTokens: tab.contextTokens,
      model: tab.model,
      project: loc.project,
      workerOnline: loc.workerOnline,
      ...conv,
    })
    return true
  }

  if (path === '/api/code/projects' && method === 'GET') {
    // A szerepek (tervezo / megvalosito / ellenorzo) ITT mennek ki, nem csak a
    // feluleten: enelkul Marvin nem tudna, mit szabad ennek a vegrehajtonak
    // kiosztani -- a jelolonegyzet magaban csak dekoracio lenne.
    //
    // Az ures tomb ket dolgot jelenthet, ezert nem csak `roles` megy: a
    // `rolesAssigned` mondja meg, hogy egyaltalan van-e barhol kiosztott szerep
    // a flottaban. Ha nincs, akkor a szerep-nelkuliseg nem korlatozas (a
    // kontextus-keszito donti el feladatonkent); ha van, de ezen a kartyan
    // nincs, akkor ez a vegrehajto SZANDEKOSAN nem kap olyan munkat.
    const roleCfg = readBrokerConfig().roles
    const anyAssigned = BROKER_ROLE_IDS.some((id) => Boolean(roleCfg[id]))
    // Kontextus-meret (Boss, 2026-08-23: "kiiratni hogy jelenleg mennyi a
    // token amit hasznlal"). A regisztralt beszelgetes SAJAT merese megy ki --
    // ha nem latunk ra (regi worker, meg nincs assistant-valasz), akkor `null`,
    // amit a felulet "nem tudom"-kent mond el, nem nullakent.
    const tabs = listCodeTabs()
    const tokensBySession = new Map<string, number>()
    const modelBySession = new Map<string, string>()
    for (const g of tabs.projects) {
      for (const tb of g.tabs) {
        if (tb.contextTokens !== null) tokensBySession.set(tb.sessionId, tb.contextTokens)
        if (tb.model !== null) modelBySession.set(tb.sessionId, tb.model)
      }
    }
    // Boss, 2026-08-23: "nem lenne celszeru oda kitenni a elo chateket? es egy
    // jelolonegyzetet eleje tenni? amelyik be van jelolve az az aktualis elo."
    // -- a kartyan is valaszthato legyen, melyik beszelgetesbe megy a munka.
    // Csak azok a fulek mennek ki, amiket a worker NYITOTTKENT mert; a lista
    // uressege ket dolgot jelenthet, ezert megy ki a `tabsReason` is.
    const tabsByWorkspace = new Map<string, typeof tabs.projects[number]>()
    for (const g of tabs.projects) tabsByWorkspace.set(g.workspacePath.toLowerCase(), g)
    // Ugyanaz a sor-alak a futo es a nem futo beszelgetesekhez: a felulet
    // ugyanazt tudja roluk megmutatni, csak mas helyen es mas jelolessel.
    const tabRow = (tb: CodeTab, currentSessionId: string): {
      sessionId: string; shortId: string; title: string | null; live: boolean | null
      lastActivity: number | null
      current: boolean; contextTokens: number | null; model: string | null
      pid: number | null; mtime: number | null; hasTranscript: boolean
    } => ({
      sessionId: tb.sessionId,
      shortId: tb.shortId,
      title: tb.title,
      live: tb.live,
      // A naplo VALODI utolso idobelyege. A felulet EZT irja ki es EZ szerint
      // rendez -- nem a `mtime` szerint, ami tomeges fajlmuvelet utan
      // veletlenszeru sorrendet adott (lasd `CodeCandidate.lastActivity`).
      // `null` = nem latunk oda (regi worker) -- olyankor a felulet a `mtime`-ra
      // esik vissza, es meg is mondja, hogy az csak kozelites.
      lastActivity: tb.lastActivity,
      current: tb.sessionId === currentSessionId,
      contextTokens: tb.contextTokens,
      model: tb.model,
      // A bezaras-gombhoz: van-e egyaltalan mit leallitani. `null` = nem
      // latunk oda (regi worker) -- olyankor a gomb sem jelenik meg.
      pid: tb.pid,
      // Mikor irt utoljara a beszelgetes. Ebbol latszik a "fule mar nincs
      // sehol, a folyamat meg el" eset: elo ful, de orak ota nema.
      mtime: tb.mtime,
      // Meg tudjuk-e nyitni a TARTALMAT. Maga az ut nem megy ki a felületre
      // (a bongeszonek semmit nem mondana, es fajlrendszer-reszlet), de azt
      // tudnia kell, hogy van-e ertelme a gombnak: regi worker mellett nincs.
      hasTranscript: typeof tb.transcriptPath === 'string' && tb.transcriptPath.length > 0,
    })
    const projects = listCodeSessions().map((p) => ({
      ...p,
      tabs: (tabsByWorkspace.get(p.workspacePath.toLowerCase())?.tabs ?? []).map((tb) => tabRow(tb, p.sessionId)),
      // A mappa TOBBI beszelgetese: nyitva lehetnek a VS Code panelen, de a
      // folyamatuk mar nem fut (Boss, 2026-08-28: "a kartyan csak eg chat van
      // megjelenitve, most, de a vscode ban van vagy 3 beszelgetes"). A fo
      // listaba nem valok -- oda a cimezheto, futo beszelgetesek mennek --, de
      // a tartalmuk ugyanugy megnyithato.
      closedTabs: (tabsByWorkspace.get(p.workspacePath.toLowerCase())?.closedTabs ?? []).map((tb) => tabRow(tb, p.sessionId)),
      roleHolder: `vscode:${p.project}`,
      roles: BROKER_ROLE_IDS.filter((id) => roleCfg[id] === `vscode:${p.project}`),
      contextTokens: tokensBySession.get(p.sessionId) ?? null,
      // A modell NEM fix: azt mutatjuk, amivel a beszelgetes eppen valaszolt
      // (Boss, 2026-08-23: "ne fix legyen hanem dinamikus attol fuggoen hogy
      // mi van kivalasztva a vscodban"). `null` = nem latunk oda -- kitalalt
      // modellnevet nem irunk ki.
      model: modelBySession.get(p.sessionId) ?? null,
    }))
    // `tabsReason`: a felulet enelkul nem tudna megkulonboztetni a "nincs
    // tobb nyitott beszelgetes"-t a "nem futott meg a Windows-munkas"-tol.
    json(res, { projects, permissionMode: CODE_PERMISSION_MODE, rolesAssigned: anyAssigned, tabsReason: tabs.reason })
    return true
  }

  if (path === '/api/code/projects' && method === 'POST') {
    const body = await parseJsonBody<{ project?: string; workspacePath?: string; sessionId?: string; title?: string; pinned?: boolean }>(ctx)
    if (!body) { json(res, { error: 'invalid JSON' }, 400); return true }
    // A session-azonositot a worker MAR ISMERI: ha erre a mappara jelentett
    // sessiont, akkor senkinek nem kell UUID-t begepelnie -- sem a feluleten,
    // sem a REST-en at. Ezt kerdezte a Boss: "es mit irjak a UUID hez?
    // kotelezo? nem?" -- a valasz: csak akkor, ha a vegrehajto nem latja a
    // mappat (masik gep, zart VS Code), mert olyankor tenyleg sehonnan nem
    // tudhato.
    const workspacePath = (body.workspacePath ?? '').trim()
    const sessionId =
      (body.sessionId ?? '').trim() ||
      listCodeCandidates().find((c) => sameWorkspace(c.workspacePath, workspacePath))?.sessionId ||
      ''
    if (!body.project || !workspacePath || !sessionId) {
      json(res, {
        error: !sessionId && body.project && workspacePath
          ? 'sessionId is required: the worker has not reported a session for this workspace'
          : 'project, workspacePath and sessionId are required',
      }, 400)
      return true
    }
    // Mapping an excluded alias would create a row that discovery deletes on its
    // next pass and that no task can use -- say so instead of accepting it.
    if (isExcludedProject(body.project)) {
      json(res, { error: `project "${body.project}" is excluded from the code bridge (CODE_BRIDGE_EXCLUDE)` }, 400)
      return true
    }
    try {
      // A kezi bekotes VISSZAVONJA a korabbi levetelt -- kulonben a tulaj a
      // sajat feluleterol nem tudna visszahozni, amit egyszer letorolt.
      undismissCodeWorkspace(workspacePath)
      // An explicit map from the owner is a pin by default: it exists precisely
      // to stop discovery from moving the alias somewhere else.
      const session = upsertCodeSession({
        project: body.project,
        workspacePath,
        sessionId,
        title: body.title ?? null,
        pinned: body.pinned ?? true,
      })
      json(res, session)
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : String(err) }, 400)
    }
    return true
  }

  const projectMatch = /^\/api\/code\/projects\/([^/]+)$/.exec(path)
  if (projectMatch && method === 'DELETE') {
    const alias = safeDecode(projectMatch[1]!)
    // A mappa utjat MEG A TORLES ELOTT kell kiolvasni: utana mar nincs honnan.
    const row = listCodeSessions().find((s) => s.project === alias)
    // Csak a torles keves lenne: a felderites egy percen belul ujra bekotne
    // ugyanazt a mappat, es a gomb ugy nezne ki, mintha nem tortent volna semmi.
    // A `forget=0` a regi viselkedes (csak a sor torlese).
    const forget = url.searchParams.get('forget') !== '0'
    if (forget && row) dismissCodeWorkspace(row.workspacePath, alias)
    const ok = deleteCodeSession(alias)
    json(res, { deleted: ok, forgotten: forget && row !== undefined, workspacePath: row?.workspacePath ?? null }, ok ? 200 : 404)
    return true
  }

  // Worker discovery report. Sessions are keyed by workspace; the alias is the
  // folder name unless the owner already mapped one for that workspace.
  if (path === '/api/code/sessions' && method === 'POST') {
    if (!isLoopback(ctx.req.socket.remoteAddress)) { json(res, { error: 'loopback only' }, 403); return true }
    type ReportedSession = {
      workspacePath?: string
      sessionId?: string
      title?: string
      mtime?: number
      project?: string
      /** A mappa legfrissebb beszelgetese. A tobbi ful is BEJON (hogy latszodjon
       *  es cimezheto legyen), de projektkent csak a primary regisztralodik --
       *  kulonben egy mappa 10 fule 10 alias ala akarna beulni ugyanazon a neven. */
      primary?: boolean
      /** FUT-E a beszelgetes folyamata (elo PID a ~/.claude/sessions alapjan).
       *  Regi worker nem kuldi -> ott `undefined`, ami "nem latunk oda". */
      live?: boolean | null
      /** A naplo VALODI utolso idobelyege, unix ms-ben -- NEM a fajl mtime-ja.
       *  Regi worker nem kuldi -> `undefined`, ami "nem latunk oda". */
      lastActivity?: number | null
      contextTokens?: number
      /** Melyik modell felel a beszelgetesben (a transcript utolso soraból). */
      model?: string
      /** A napló TELJES utja a Claude Code gepen. Ebbol tudja a vezerlopult
       *  megnyitni a beszelgetes tartalmat. Regi worker nem kuldi -> nincs
       *  gomb, mert nem lenne mit megnyitni (nem pedig ures beszelgetes). */
      transcriptPath?: string
    }
    const body = await parseJsonBody<{ host?: string; workerVersion?: string; sessions?: ReportedSession | ReportedSession[] }>(ctx)
    // A single session may arrive as a bare object rather than a one-element
    // array: PowerShell's ConvertTo-Json flattens `@(x)` to `x`. Rejecting that
    // would break exactly the machines with one project -- the smallest, most
    // likely install.
    const reported: ReportedSession[] | null = Array.isArray(body?.sessions)
      ? body.sessions
      : body?.sessions && typeof body.sessions === 'object'
        ? [body.sessions]
        : null
    if (!body || !reported) { json(res, { error: 'sessions[] required' }, 400); return true }

    // Stamped BEFORE the loop: a worker that reports zero sessions (every
    // workspace filtered out, or none open) is still a LIVE worker, and the
    // difference between "the executor is gone" and "it runs but finds nothing"
    // is the whole diagnosis. Stamping only on success would have reported the
    // running-but-empty worker of 2026-08-20 as dead.
    // A verziot a felderitesi kor hozza. Regi peldany nem kuld semmit -> `null`
    // marad, es a Attekintes onellenorzese pont ezt teszi szova.
    recordCodeWorkerSeen(body.host ?? 'windows', 'discovery', reported.length, Date.now(), body.workerVersion ?? null)
    // A NYERS lista is eltevodik, mielott a kizaras vagy a regisztracio szurne:
    // a felulet ebbol tud valaszthato listat kinalni ahelyett, hogy utvonalat
    // es UUID-t kellene begepelni.
    recordCodeCandidates(body.host ?? 'windows', reported)

    const known = listCodeSessions()
    const registered: string[] = []
    /** Az athelyezett projektek, hogy a naplo megmondja, MI tortent es MIERT. */
    const athelyezve: { project: string; rol: string; ra: string }[] = []

    // MELYIK BESZELGETES VAN TENYLEG NYITVA A VS CODE-BAN.
    //
    // Ket kulon dolgot kell tudni, es a kettot nem szabad osszemosni:
    //  - `nyitottak`: amit a worker ELO PID-del latott (mert);
    //  - `latunkOda`: kuldott-e egyaltalan barmilyen `live` merest. Regi
    //    worker nem kuld, es olyankor `nyitottak` URES lenne -- amibol
    //    "minden ful zarva"-t olvasni sulyos tevedes volna, es minden
    //    kituzott projektet athelyezne. A nulla itt is ket dolgot jelenthet.
    const nyitottak = new Set(
      reported.filter((r) => r.live === true && r.sessionId).map((r) => r.sessionId as string),
    )
    const latunkOda = reported.some((r) => typeof r.live === "boolean")
    // Egy REGI worker egyetlen `primary` mezot sem kuld: olyankor MINDEN sor
    // projektnek szamit, ahogy 2026-08-23 elott. Ha viszont a worker jeloli az
    // elsodleges fulet, csak azt regisztraljuk -- a tobbi ful jeloltkent mar
    // benne van a listaban, cimezni pedig session-azonositoval lehet rajuk.
    const reportsPrimary = reported.some((s) => typeof s.primary === 'boolean')
    for (const s of reported) {
      if (!s.workspacePath || !s.sessionId) continue
      if (reportsPrimary && s.primary !== true) continue
      const explicit = known.find((k) => k.workspacePath.toLowerCase() === s.workspacePath!.toLowerCase())
      const alias = normalizeAlias(s.project ?? explicit?.project ?? aliasFromWorkspacePath(s.workspacePath))
      if (!alias) continue
      // Fenced off by the owner: don't register it, and clean up a row that was
      // registered before the exclusion was set -- otherwise the alias would
      // stay dispatchable until someone noticed.
      if (isExcludedProject(alias)) {
        deleteCodeSession(alias)
        continue
      }
      // A tulaj levette ezt a mappat a feluletrol. A fulek jeloltkent tovabbra
      // is latszanak (igy vissza tudja hozni), projektkent viszont nem kotjuk
      // be ujra.
      if (isDismissedWorkspace(s.workspacePath)) continue
      // ELAVULT-E A BEKOTES?
      //
      // A kituzott sor alapbol erinthetetlen. Egyetlen kivetel van, es azt
      // MERNI kell, nem felteteleznii: a bekotott beszelgetes mar nincs nyitva
      // a VS Code-ban, ES a most jelentett helyette nyitva VAN. Ez pontosan az
      // az eset, amikor a feladat egy bezart beszelgetesbe menne.
      //
      // Mind a harom feltetel kell. Ha nem latunk oda (`latunkOda === false`),
      // a tu MARAD: a "nem tudom" nem ok az atallitasra. Ha egyik ful sem
      // nyitott, szinten marad -- nincs hova atallni, es a talalgatas
      // rosszabb a semminel.
      const meglevo = getCodeSession(alias)
      const elavultBekotes =
        !!meglevo &&
        meglevo.pinned &&
        latunkOda &&
        !nyitottak.has(meglevo.sessionId) &&
        s.live === true &&
        meglevo.sessionId !== s.sessionId
      try {
        const row = upsertCodeSession(
          {
            project: alias,
            workspacePath: s.workspacePath,
            sessionId: s.sessionId,
            title: s.title ?? null,
            host: body.host ?? null,
            transcriptMtime: s.mtime ?? null,
          },
          { fromDiscovery: true, repointStale: elavultBekotes },
        )
        if (elavultBekotes && meglevo) {
          athelyezve.push({ project: row.project, rol: meglevo.sessionId, ra: row.sessionId })
        }
        registered.push(row.project)
      } catch (err) {
        logger.warn({ err, workspace: s.workspacePath }, 'code-bridge: session report rejected')
      }
    }
    // A jelentes a hitelesek listaja erre a gepre: ami kimaradt belole, annak
    // a workspace-e mar nincs meg (a worker eleve nem jelenti a nem letezot).
    if (athelyezve.length > 0) {
      logger.info(
        { host: body.host, athelyezve },
        'code-bridge: a bekotott beszelgetes mar nem volt nyitva -- atallitva a nyitott fulre',
      )
    }
    const pruned = pruneUnreportedCodeSessions(body.host ?? 'windows', registered)
    if (pruned.length > 0) logger.info({ host: body.host, pruned }, 'code-bridge: dropped sessions no longer reported')
    // A valasz VISZI a bezaras-kereseket: a worker nem tud bejovo hivast
    // fogadni (nincs nyitott portja), a jelentes viszont percenkent megy.
    // Igy a "Bezaras" gomb egy jelentesi korön belul hat.
    json(res, {
      registered,
      pruned,
      projects: listCodeSessions(),
      closeSessions: takeCodeTabCloseRequests(),
    })
    return true
  }

  // Egy beszelgetes BEZARASA. Nem torol transcriptet: a futo Claude Code
  // folyamatot allitja le, azt, amelyiknek a fulet a VS Code-ban mar nem talalod
  // (Boss, 2026-08-23: "nem tudom bezarni. mert nem latok ott semmit").
  //
  // A leallitast a WORKER vegzi, mert a folyamat a Windows-oldalon fut; ide csak
  // a szandek kerul be, es a worker kovetkezo jelentesenel megy at. Ezert a
  // valasz nem azt allitja, hogy "kesz", hanem azt, hogy atvettuk -- a
  // tenylegesen bezarult ful a kovetkezo jelentesbol tunik el a listarol.
  if (path.startsWith('/api/code/tabs/') && path.endsWith('/close') && method === 'POST') {
    const sessionId = decodeURIComponent(path.slice('/api/code/tabs/'.length, -'/close'.length))
    if (!sessionId) { json(res, { error: 'sessionId required' }, 400); return true }
    const tab = listCodeTabs().projects.flatMap((p) => p.tabs).find((t) => t.sessionId === sessionId)
    if (!tab) { json(res, { error: 'unknown session' }, 404); return true }
    // A NULLA ket dolgot jelenthet: ha nincs PID, akkor NEM azt mondjuk, hogy
    // nincs mit bezarni, hanem hogy nem latunk oda -- kulonben a felhasznalo
    // azt hinne, mar nem fut.
    if (tab.pid === null) { json(res, { error: 'no-pid' }, 409); return true }
    const health = codeBridgeHealth()
    if (!health.workerOnline) { json(res, { error: 'worker-offline' }, 409); return true }
    requestCodeTabClose(sessionId)
    json(res, { accepted: true, sessionId, pid: tab.pid })
    return true
  }

  // ---- tasks -------------------------------------------------------------

  if (path === '/api/code/tasks' && method === 'POST') {
    const body = await parseJsonBody<{
      project?: string
      prompt?: string
      origin?: string
      requestedBy?: string
      chatId?: string
      /** Opcionalis: EGY konkret chat ful a projekt mappajabol (a `/api/code/tabs`
       *  listajabol). Elhagyva minden a regi marad: a projekt legfrissebb
       *  beszelgetese kapja a feladatot. */
      sessionId?: string
    }>(ctx)
    if (!body) { json(res, { error: 'invalid JSON' }, 400); return true }
    if (!body.project || !body.prompt) { json(res, { error: 'project and prompt are required' }, 400); return true }
    const origin = (['telegram', 'agent', 'dashboard', 'api'] as const).includes(body.origin as CodeTaskOrigin)
      ? (body.origin as CodeTaskOrigin)
      : 'api'
    const out = enqueueCodeTask({
      project: body.project,
      prompt: body.prompt,
      origin,
      requestedBy: body.requestedBy ?? null,
      chatId: body.chatId ?? null,
      sessionId: body.sessionId ?? null,
    })
    if ('error' in out) { json(res, out, 400); return true }
    logger.info({ task: out.task.id, project: out.task.project, origin }, 'code-bridge: task queued')
    json(res, out.task, 201)
    return true
  }

  if (path === '/api/code/tasks' && method === 'GET') {
    const project = url.searchParams.get('project') ?? undefined
    const status = (url.searchParams.get('status') ?? undefined) as CodeTaskStatus | undefined
    const limit = Number(url.searchParams.get('limit') ?? '20')
    json(res, { tasks: listCodeTasks({ project, status, limit: Number.isFinite(limit) ? limit : 20 }) })
    return true
  }

  // History housekeeping. Without this the only way to clear a page full of
  // throwaway test rounds is hand-editing SQLite -- which a fresh install has
  // no business needing.
  if (path === '/api/code/tasks' && method === 'DELETE') {
    json(res, { removed: clearFinishedCodeTasks() })
    return true
  }

  // Claim is a POST: it mutates (running + lease + attempt count).
  if (path === '/api/code/tasks/claim' && method === 'POST') {
    if (!isLoopback(ctx.req.socket.remoteAddress)) { json(res, { error: 'loopback only' }, 403); return true }
    const body = await parseJsonBody<{ host?: string }>(ctx)
    if (!body) { json(res, { error: 'invalid JSON' }, 400); return true }
    const host = (body.host ?? '').trim() || 'unknown-worker'
    recordCodeWorkerSeen(host, 'claim')
    const task = claimNextCodeTask(host)
    // A VART verzio minden valaszban ott van, mert a worker maga nem tudhatja,
    // hogy elavult: a sajat verziojat eddig csak KULDTE. Enelkul a csere
    // egyetlen szereploje a tulajdonos volt -- kezzel, terminalbol (Boss,
    // 2026-08-26: "miert kell ezt a usernek eljatszania?").
    //
    // null = ebben a telepitesben nincs meg a szkript, tehat nem tudjuk, mi
    // a friss. Ilyenkor a mezot KI IS HAGYJUK: egy null vagy egy ures string
    // a worker oldalan "nem egyezik"-nek latszana, es vegtelen
    // frissitesi korbe kergetne. A "nem latok oda" nem "elavult".
    const expect = expectedWorkerVersion()
    const extra = expect === null ? {} : { expectedWorkerVersion: expect }
    if (!task) { json(res, { task: null, ...extra }); return true }
    logger.info({ task: task.id, project: task.project, session: task.sessionId, host }, 'code-bridge: task claimed')
    json(res, { task, permissionMode: CODE_PERMISSION_MODE, ...extra })
    return true
  }

  const taskMatch = /^\/api\/code\/tasks\/([^/]+)(?:\/(heartbeat|result|cancel))?$/.exec(path)
  if (taskMatch) {
    const rawId = safeDecode(taskMatch[1]!)
    const action = taskMatch[2]
    const task = getCodeTask(rawId) ?? getCodeTaskByPrefix(rawId)
    if (!task) { json(res, { error: 'task not found' }, 404); return true }

    if (!action && method === 'GET') { json(res, task); return true }

    if (action === 'heartbeat' && method === 'POST') {
      if (!isLoopback(ctx.req.socket.remoteAddress)) { json(res, { error: 'loopback only' }, 403); return true }
      const body = await parseJsonBody<{ host?: string }>(ctx)
      const hbHost = (body?.host ?? '').trim() || 'unknown-worker'
      recordCodeWorkerSeen(hbHost, 'heartbeat')
      const ok = heartbeatCodeTask(task.id, hbHost)
      json(res, { ok }, ok ? 200 : 409)
      return true
    }

    if (action === 'result' && method === 'POST') {
      if (!isLoopback(ctx.req.socket.remoteAddress)) { json(res, { error: 'loopback only' }, 403); return true }
      const body = await parseJsonBody<{
        ok?: boolean; result?: string; error?: string; costUsd?: number; durationMs?: number; numTurns?: number; host?: string
        /** A futas VEGEN ervenyes beszelgetes-azonosito (a CLI sajat jelentese).
         *  Regi worker nem kuldi -- olyankor nem allitunk at semmit. */
        resultSessionId?: string
      }>(ctx)
      if (!body) { json(res, { error: 'invalid JSON' }, 400); return true }
      // Reporting a result IS a sign of life -- and the one worker call that
      // proves the executor got all the way through a job. Stamped here so the
      // presence table matches what recordCodeWorkerSeen's own contract says.
      const resHost = (body.host ?? '').trim() || null
      if (resHost) recordCodeWorkerSeen(resHost, 'result')
      const { task: updated, outcome } = completeCodeTaskDetailed(task.id, {
        ok: body.ok !== false && !body.error,
        result: body.result ?? null,
        error: body.error ?? null,
        costUsd: typeof body.costUsd === 'number' ? body.costUsd : null,
        durationMs: typeof body.durationMs === 'number' ? body.durationMs : null,
        numTurns: typeof body.numTurns === 'number' ? body.numTurns : null,
      }, Date.now(), resHost)
      if (!updated) { json(res, { error: 'task not found' }, 404); return true }
      if (outcome !== 'accepted') {
        // A result for a task that was cancelled, already finished, or handed to
        // another host. It is stored where it can do no harm, but announcing it
        // would tell the owner a decision they made was undone.
        logger.warn({ task: updated.id, outcome, status: updated.status }, 'code-bridge: late result not applied')
        json(res, { ...updated, lateResult: outcome })
        return true
      }
      // A `/clear` UJ, URES BESZELGETEST NYIT -- es eddig senki nem allt at ra.
      //
      // Merve 2026-08-26: a `-p --resume <id> "/clear"` hibatlanul lefutott, uj
      // beszelgetest nyitott, a projekt viszont a REGIN maradt, mert az uj
      // transcript ~1,8 KB, a worker mappa-bejarasa pedig 2 KB alatt mindent
      // kiszur (abortalt futasnak latszik). A kovetkezo feladat igy megint a regi
      // beszelgetesbe ment: a gomb sikert jelentett, es semmit nem ert el.
      //
      // A CLI viszont MEGMONDJA, hol vegzodott a futas. Folytatasnal ez ugyanaz
      // az azonosito (merve), tehat a lenti feltetel csak valodi valtasnal tuzel
      // -- nem talalgatunk, es a rendes feladatok nem mozgatjak a bekotest.
      //
      // A tu (`pinned`) nem serul: ez nem felderites, a mappa nem valtozik, csak
      // a beszelgetes -- ugyanaz, amit a tulaj a gombbal keresen kert.
      const endedIn = (body.resultSessionId ?? '').trim()
      if (endedIn && updated.sessionId && endedIn !== updated.sessionId) {
        const cur = getCodeSession(updated.project)
        if (!cur) {
          // A NULLA KET DOLGOT JELENTHET: nincs bekotott sor -> nincs mit
          // atallitani, es TALALGATNI sem szabad, hol van a mappa.
          logger.warn({ task: updated.id, project: updated.project, endedIn }, 'code-bridge: session switched but the project has no bound row -- not repointed')
        } else {
          upsertCodeSession({
            project: updated.project,
            workspacePath: cur.workspacePath,
            sessionId: endedIn,
            host: cur.host,
          })
          logger.info({ task: updated.id, project: updated.project, from: updated.sessionId, to: endedIn }, 'code-bridge: project repointed to the conversation the run ended in')
        }
      }
      logger.info({ task: updated.id, status: updated.status }, 'code-bridge: task finished')
      // Not awaited: the worker must be free to pick up the next task even if
      // Telegram is slow or down, and the result is already durable.
      void notifyCodeTaskFinished(updated)
      json(res, updated)
      return true
    }

    if (action === 'cancel' && method === 'POST') {
      // The CLI has no remote stop: `claude.exe` is already mid-run on Windows
      // and nothing here can interrupt it. Flipping the row to 'cancelled'
      // would only make the dashboard lie -- and then the real result would
      // arrive for a task the owner believes was called off. The Telegram bot
      // has always answered this way; the REST surface now says the same thing.
      if (task.status === 'running') {
        json(res, { error: 'task is already running -- the CLI cannot be stopped remotely', task }, 409)
        return true
      }
      const updated = cancelCodeTask(task.id)
      json(res, updated)
      return true
    }
  }

  // Convenience for the dashboard/CLI: the latest task of a project.
  const latestMatch = /^\/api\/code\/latest\/([^/]+)$/.exec(path)
  if (latestMatch && method === 'GET') {
    const project = safeDecode(latestMatch[1]!)
    const session = getCodeSession(project)
    const tasks = listCodeTasks({ project, limit: 1 })
    json(res, { session, task: tasks[0] ?? null })
    return true
  }

  return false
}
