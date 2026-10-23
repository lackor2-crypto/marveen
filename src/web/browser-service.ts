// Kartya #165 (31f3e26f): a mar telepitett Playwright elesben. EGY hosszabb
// eletu Chromium-peldany (nem hivasonkent uj), uresjarat utan magatol leall. A
// bejelentkezett munkamenetek (storageState) a Vaultba kerulnek titkositva --
// soha nem az eletfaba, soha nem sima fajlba.
//
// Alapbol BE (kartya 360da728, Boss 2026-09-18): fresh installon is bekapcsolva.
// A felhasznalo a feluletrol tudja kikapcsolni. Ha a Chromium nincs letoltve,
// azt a status kulon mondja, es a felulet gombbal tolti le.

import { existsSync, readFileSync, mkdirSync, readdirSync, statSync, chmodSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { PROJECT_ROOT, STORE_DIR } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { setSecret, getSecret, deleteSecret, listSecrets } from './vault.js'
import { logger } from '../logger.js'
import {
  sessionHealthFromState, looksLikeLoginUrl, isIrreversibleClick,
  sessionSlug, normalizeNavigateUrl, browserEnabledFromConfig,
  SESSION_VAULT_PREFIX, type SessionHealth,
  safeUploadName, safeDownloadName, parseTabIndex, parseDialogPolicy, type DialogPolicy,
  sessionCookiesToKeep,
} from '../browser-logic.js'

const CONFIG_DIR = join(PROJECT_ROOT, 'store', 'browser')
const CONFIG_PATH = join(CONFIG_DIR, 'config.json')
/** #762: a feltoltheto fajlok es a letoltesek helye -- store/ alatt, gepfuggetlenul. */
export const BROWSER_UPLOAD_DIR = join(STORE_DIR, 'browser', 'uploads')
export const BROWSER_DOWNLOAD_DIR = join(STORE_DIR, 'browser', 'downloads')
/** #762 part 2: the persistent Chromium profile (cookies, logins). Plain files, owner-only, under the backup-excluded `browser` folder. */
export const BROWSER_PROFILE_DIR = join(STORE_DIR, 'browser', 'profile')
/** #762: the session cookies (no expiry) of the persistent profile; Chromium itself drops them on restart. Inside the profile folder, so a profile reset removes it too. */
const SESSION_COOKIES_PATH = join(BROWSER_PROFILE_DIR, 'marveen-session-cookies.json')
export const BROWSER_IDLE_MS = 5 * 60 * 1000
const ACTION_TIMEOUT_MS = 20_000
// Kartya ab8406b7: magasabb ablak, hogy a hosszabb parbeszedek (pl. nemet
// Google-consent) gombjai is kiferjenek. Merve: a nemet "Alle akzeptieren"
// y~758 (720-nal alatta), 900/1000-nel befer. A gorgeto-gomb a tobbit hozza.
const BROWSER_VIEWPORT = { width: 1280, height: 1000 }

/** Kartya ab8406b7: egy kattintas NAVIGALHAT is. A puszta
 *  waitForLoadState('domcontentloaded') a navigalo kattintasnal a REGI oldalra
 *  ter vissza azonnal, igy a screenshot a kattintas ELOTTI oldalt mutatna -- a
 *  felhasznalo azt latja, hogy "nem tortent semmi". Ezert adunk eselyt az
 *  esetleges navigacionak elindulni, majd megvarjuk a betoltest (bounded, hogy
 *  egy chates oldal se akaszthassa meg). */
async function settleAfterInteraction(page: Page): Promise<void> {
  await page.waitForTimeout(400)
  await page.waitForLoadState('load', { timeout: 8000 }).catch(() => {})
  await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {})
}

// ---------------------------------------------------------------- config

export function isBrowserEnabled(): boolean {
  // Kartya 360da728: alapbol BE. A dontes a browserEnabledFromConfig tiszta
  // fuggvenyben van (tesztelt); itt csak a fajlt olvassuk be (null = nincs / nem
  // olvashato). A KIFEJEZETTEN kikapcsolt allapotot (enabled:false) tiszteletben
  // tartjuk.
  let raw: string | null = null
  try { raw = readFileSync(CONFIG_PATH, 'utf-8') } catch { raw = null }
  return browserEnabledFromConfig(raw)
}

export async function setBrowserEnabled(enabled: boolean): Promise<void> {
  mkdirSync(CONFIG_DIR, { recursive: true })
  atomicWriteFileSync(CONFIG_PATH, JSON.stringify({ enabled }, null, 2))
  if (!enabled) await stopBrowser()
}

// ------------------------------------------------------------- playwright

type PwModule = typeof import('playwright-core')

async function loadPlaywright(): Promise<{ pw: PwModule | null; error: string | null }> {
  try {
    return { pw: await import('playwright-core'), error: null }
  } catch (err: any) {
    return { pw: null, error: String(err?.message || err) }
  }
}

export interface InstallState { running: boolean; exitCode: number | null; output: string; error: string | null }
const install: InstallState = { running: false, exitCode: null, output: '', error: null }

export function getInstallState(): InstallState { return { ...install } }

/** A Chromium letoltese a Playwright SAJAT CLI-jevel, a futo Node-dal -- nincs
 *  szukseg terminalra vagy globalis npx-re. */
export function startChromiumInstall(): InstallState {
  if (install.running) return getInstallState()
  const cli = join(PROJECT_ROOT, 'node_modules', 'playwright-core', 'cli.js')
  install.running = true; install.exitCode = null; install.output = ''; install.error = null
  if (!existsSync(cli)) {
    install.running = false
    install.error = `playwright-core CLI not found: ${cli}`
    return getInstallState()
  }
  const child = spawn(process.execPath, [cli, 'install', 'chromium'], { cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  const append = (b: Buffer) => { install.output = (install.output + b.toString()).slice(-4000) }
  child.stdout.on('data', append)
  child.stderr.on('data', append)
  child.on('error', (err) => { install.running = false; install.error = err.message })
  child.on('close', (code) => {
    install.running = false
    install.exitCode = code
    if (code !== 0 && !install.error) install.error = install.output.trim().split('\n').slice(-3).join('\n') || `exit ${code}`
  })
  return getInstallState()
}

// ---------------------------------------------------------------- runtime

type Browser = import('playwright-core').Browser
type BrowserContext = import('playwright-core').BrowserContext
type Page = import('playwright-core').Page

interface Runtime {
  /** The browser process is gone (closed, crashed): the next action starts a fresh one. */
  alive: () => boolean
  close: () => Promise<void>
  context: BrowserContext; page: Page; session: string | null
  /** #762 part 2: true when this runtime uses the persistent profile folder (cookies/logins survive restarts). */
  persistent: boolean
  /** #762: JS-parbeszedek (utolso 20) es letoltesek, amiket a kontextus latott. */
  dialogs: Array<{ type: string; message: string; handled: DialogPolicy }>
  downloads: string[]
  dialogPolicy: DialogPolicy
}
let rt: Runtime | null = null
let idleTimer: NodeJS.Timeout | null = null
let lastAction: { at: number; action: string; error: string | null } | null = null

function touchIdle(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    logger.info('browser: idle timeout, closing Chromium')
    void stopBrowser()
  }, BROWSER_IDLE_MS)
  idleTimer.unref()
}

export async function stopBrowser(): Promise<void> {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
  const cur = rt
  rt = null
  if (cur) {
    await saveSessionCookies(cur)
    try { await cur.close() } catch { /* already gone */ }
  }
}

/** #762: remember the login cookies that have no expiry, so a login survives the browser closing (idle timeout, restart). Best effort. */
async function saveSessionCookies(r: Runtime): Promise<void> {
  if (!r.persistent || !r.alive()) return
  try {
    const keep = sessionCookiesToKeep(await r.context.cookies(), Math.floor(Date.now() / 1000))
    if (existsSync(BROWSER_PROFILE_DIR)) atomicWriteFileSync(SESSION_COOKIES_PATH, JSON.stringify(keep), { mode: 0o600 })
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message : String(e) }, 'browser: could not save session cookies')
  }
}

async function restoreSessionCookies(context: BrowserContext): Promise<void> {
  try {
    const saved = JSON.parse(readFileSync(SESSION_COOKIES_PATH, 'utf-8'))
    if (Array.isArray(saved) && saved.length) await context.addCookies(saved)
  } catch { /* none saved yet, or unreadable: start without them */ }
}

export class BrowserError extends Error {
  constructor(message: string, public status = 400, public code = 'error') { super(message) }
}

async function ensureRuntime(session: string | null | undefined): Promise<Runtime> {
  if (!isBrowserEnabled()) throw new BrowserError('browser capability is disabled', 403, 'disabled')
  const wanted = session ? sessionSlug(session) : null
  if (rt && rt.alive() && (session === undefined || rt.session === wanted)) {
    touchIdle()
    return rt
  }
  await stopBrowser()
  const { pw, error } = await loadPlaywright()
  if (!pw) throw new BrowserError(`playwright not available: ${error}`, 500, 'no_playwright')
  if (!existsSync(pw.chromium.executablePath())) throw new BrowserError('Chromium is not downloaded yet', 409, 'no_chromium')
  let storageState: any
  if (wanted) {
    const raw = getSecret(SESSION_VAULT_PREFIX + wanted)
    if (raw == null) throw new BrowserError(`no saved session named "${wanted}"`, 404, 'no_session')
    storageState = JSON.parse(raw)
  }
  // GPU nelkuli szerver/WSL gepen a kepernyokep GPU-val "Unable to capture
  // screenshot" hibaval all meg (merve 2026-09-17); a szoftveres ut mindenhol megy.
  const args = ['--disable-gpu', '--disable-software-rasterizer']
  let context: BrowserContext
  let alive: () => boolean
  let close: () => Promise<void>
  if (wanted) {
    // A named, Vault-encrypted session: a fresh incognito-like context seeded with the saved login.
    const browser = await pw.chromium.launch({ headless: true, args })
    context = await browser.newContext({ viewport: BROWSER_VIEWPORT, ...(storageState ? { storageState } : {}) })
    alive = () => browser.isConnected()
    close = () => browser.close()
  } else {
    // #762 part 2 (Boss chose B): the default browser is a real persistent profile, like a normal browser.
    // Every cookie and login stays between runs. The folder is plain files on disk: owner-only, left out of backups and git.
    mkdirSync(BROWSER_PROFILE_DIR, { recursive: true, mode: 0o700 })
    try { chmodSync(BROWSER_PROFILE_DIR, 0o700) } catch { /* best effort */ }
    try {
      context = await pw.chromium.launchPersistentContext(BROWSER_PROFILE_DIR, { headless: true, args, viewport: BROWSER_VIEWPORT })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/ProcessSingleton|SingletonLock|already in use|profile.*in use/i.test(msg)) throw new BrowserError('the browser profile is in use by another browser process', 409, 'profile_in_use')
      throw e
    }
    await restoreSessionCookies(context)
    let open = true
    context.on('close', () => { open = false })
    alive = () => open
    const owned = context
    close = () => owned.close()
  }
  context.setDefaultTimeout(ACTION_TIMEOUT_MS)
  const page = context.pages()[0] || await context.newPage()
  const next: Runtime = { alive, close, context, page, session: wanted, persistent: !wanted, dialogs: [], downloads: [], dialogPolicy: 'dismiss' }
  // #762: minden uj fulre (popup is) rakotjuk a parbeszed- es letoltes-figyelot.
  const watch = (pg: Page) => {
    pg.on('dialog', (d) => {
      const handled = next.dialogPolicy
      next.dialogs.push({ type: d.type(), message: d.message().slice(0, 500), handled })
      if (next.dialogs.length > 20) next.dialogs.shift()
      void (handled === 'accept' ? d.accept() : d.dismiss()).catch(() => {})
    })
    pg.on('download', (dl) => {
      mkdirSync(BROWSER_DOWNLOAD_DIR, { recursive: true })
      const name = `${Date.now()}-${safeDownloadName(dl.suggestedFilename())}`
      void dl.saveAs(join(BROWSER_DOWNLOAD_DIR, name)).then(() => { next.downloads.push(name) }).catch(() => {})
    })
  }
  context.on('page', watch)
  watch(page)
  rt = next
  touchIdle()
  return rt
}

// ---------------------------------------------------------------- actions

export interface ActionInput {
  action: string
  session?: string | null
  url?: string
  selector?: string
  value?: string
  ms?: number
  confirm?: boolean
  name?: string
  /** Kartya a5e542ac: kepre-kattintas viewport-koordinatai. */
  x?: number
  y?: number
  /** Gorgetes fuggoleges delta (px, + = le, - = fel). */
  dy?: number
}

export interface ActionResult {
  ok: boolean
  action: string
  url?: string
  title?: string
  text?: string
  screenshot?: string
  pdf?: string
  /** A bongeszo visszafordithatatlan lepest tenne -- a hivonak ra kell kerdeznie. */
  needsConfirm?: boolean
  elementText?: string
  /** Mentett munkamenettel belepo-oldalra jutottunk: a munkamenet elszallt. */
  sessionExpired?: boolean
  session?: string | null
  /** click_xy: gepelheto mezore kattintottunk -> a felulet a gepelo-mezot fokuszalja. */
  typable?: boolean
}

export const BROWSER_ACTIONS = ['open', 'navigate', 'click', 'click_xy', 'type', 'key', 'scroll', 'fill', 'wait', 'text', 'screenshot', 'pdf', 'submit', 'save_session', 'tabs', 'tab_new', 'tab_switch', 'tab_close', 'upload', 'downloads', 'dialogs', 'dialog_policy', 'clipboard_write', 'clipboard_read'] as const

async function shot(page: Page): Promise<string> {
  return (await page.screenshot({ type: 'png' })).toString('base64')
}

export async function runBrowserAction(input: ActionInput): Promise<ActionResult> {
  const action = String(input.action || '')
  if (!(BROWSER_ACTIONS as readonly string[]).includes(action)) throw new BrowserError(`unknown action: ${action}`)
  try {
    const r = await ensureRuntime(action === 'open' ? (input.session ?? null) : undefined)
    const page = r.page
    const base = (): ActionResult => ({ ok: true, action, url: page.url(), session: r.session })
    let out: ActionResult
    switch (action) {
      case 'open':
        out = base()
        break
      case 'navigate': {
        const url = normalizeNavigateUrl(input.url || '')
        if (!url) throw new BrowserError('invalid url (only http/https)')
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded' })
        } catch (err) {
          // A sikertelen navigacio utan a lapon meg befut a Chromium sajat
          // chrome-error navigacioja, es a KOVETKEZO goto azzal utkozik
          // ("interrupted by another navigation") -- merve. Friss lap ugyanabban
          // a kontextusban: a sutik (bejelentkezes) megmaradnak.
          const fresh = await r.context.newPage()
          await page.close().catch(() => {})
          r.page = fresh
          throw err
        }
        // A JS-sel renderelt tartalom (pl. cookie-consent overlay) csak a
        // betoltes utan jelenik meg -- kulonben a screenshot ures/reszleges.
        await settleAfterInteraction(page)
        out = { ...base(), title: await page.title(), screenshot: await shot(page) }
        if (r.session && looksLikeLoginUrl(page.url())) out.sessionExpired = true
        break
      }
      case 'click':
      case 'submit': {
        if (!input.selector) throw new BrowserError('selector required')
        const loc = page.locator(input.selector).first()
        const info = await loc.evaluate((el: any) => ({
          text: (el.innerText || el.value || el.getAttribute('aria-label') || '').slice(0, 200),
          type: el.getAttribute('type'),
          tag: el.tagName,
        }))
        const risky = action === 'submit' || isIrreversibleClick(info)
        if (risky && input.confirm !== true) {
          return { ...base(), ok: false, needsConfirm: true, elementText: info.text, screenshot: await shot(page) }
        }
        await loc.click()
        await settleAfterInteraction(page)
        out = { ...base(), url: page.url(), screenshot: await shot(page) }
        break
      }
      case 'click_xy': {
        // Kartya a5e542ac: a felhasznalo a kepernyokepre kattint (nem CSS-
        // kivalasztoval). A viewport-koordinatakon allo elemet megnezzuk, hogy a
        // visszafordithatatlan-kattintas orzo (needsConfirm) ugyanugy vedjen,
        // mint a selector-alapu 'click'-nel.
        const x = Number(input.x), y = Number(input.y)
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new BrowserError('x/y required')
        const info = await page.evaluate(({ px, py }: { px: number; py: number }) => {
          const at = document.elementFromPoint(px, py) as any
          if (!at) return { text: '', type: null, tag: null, typable: false }
          const el = (at.closest && at.closest('button, a, input, textarea, select, [role=button], [type=submit], [contenteditable]')) || at
          const tag = (el.tagName || '').toLowerCase()
          const type = (el.getAttribute && (el.getAttribute('type') || '').toLowerCase()) || ''
          // Kartya ab6640a3: gepelheto-e a kattintott elem? Ha igen, a felulet a
          // gepelo-mezot auto-fokuszalja, hogy a "kattints majd irj" folyamat
          // magatol ertheto legyen.
          const nonText = ['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'range', 'color', 'image', 'hidden']
          const typable = tag === 'textarea' || tag === 'select' ||
            (tag === 'input' && !nonText.includes(type)) || el.isContentEditable === true
          return {
            text: (el.innerText || el.value || (el.getAttribute && el.getAttribute('aria-label')) || '').slice(0, 200),
            type: el.getAttribute ? el.getAttribute('type') : null,
            tag: el.tagName || null,
            typable,
          }
        }, { px: x, py: y })
        if (isIrreversibleClick(info) && input.confirm !== true) {
          return { ...base(), ok: false, needsConfirm: true, elementText: info.text, screenshot: await shot(page) }
        }
        await page.mouse.click(x, y)
        await settleAfterInteraction(page)
        out = { ...base(), url: page.url(), screenshot: await shot(page), typable: info.typable }
        break
      }
      case 'type':
        // A mar fokuszalt mezobe gepel (elotte a felhasznalo a mezore kattintott).
        await page.keyboard.type(String(input.value ?? ''))
        out = { ...base(), screenshot: await shot(page) }
        break
      case 'key': {
        const key = String(input.value ?? '').trim()
        if (!key) throw new BrowserError('key name required')
        await page.keyboard.press(key)
        await settleAfterInteraction(page)
        out = { ...base(), url: page.url(), screenshot: await shot(page) }
        break
      }
      case 'scroll': {
        const dy = Number(input.dy)
        if (!Number.isFinite(dy)) throw new BrowserError('dy required')
        await page.mouse.wheel(0, dy)
        await page.waitForTimeout(150)
        out = { ...base(), screenshot: await shot(page) }
        break
      }
      case 'fill':
        if (!input.selector) throw new BrowserError('selector required')
        await page.locator(input.selector).first().fill(String(input.value ?? ''))
        out = { ...base(), screenshot: await shot(page) }
        break
      case 'wait':
        if (input.selector) await page.locator(input.selector).first().waitFor()
        else await page.waitForTimeout(Math.min(Math.max(Number(input.ms) || 1000, 0), 30_000))
        out = base()
        break
      case 'text':
        out = { ...base(), text: (input.selector
          ? await page.locator(input.selector).first().innerText()
          : await page.locator('body').innerText()).slice(0, 100_000) }
        break
      case 'screenshot':
        out = { ...base(), screenshot: await shot(page) }
        break
      case 'pdf':
        out = { ...base(), pdf: (await page.pdf({ printBackground: true })).toString('base64') }
        break
      case 'save_session': {
        const slug = sessionSlug(input.name || '')
        if (!slug) throw new BrowserError('session name required')
        const state = await r.context.storageState()
        setSecret(SESSION_VAULT_PREFIX + slug, `Böngésző-munkamenet: ${slug}`, JSON.stringify(state), {
          category: 'browser-session', url: page.url(),
        })
        r.session = slug
        out = { ...base(), session: slug }
        break
      }
      case 'tabs':
        out = { ...base(), text: await tabList(r) }
        break
      case 'tab_new': {
        const url = input.url ? normalizeNavigateUrl(input.url) : 'about:blank'
        if (!url) throw new BrowserError('invalid url (only http/https)')
        const fresh = await r.context.newPage()
        r.page = fresh
        if (input.url) await fresh.goto(url, { waitUntil: 'domcontentloaded' })
        await settleAfterInteraction(fresh)
        out = { url: fresh.url(), ok: true, action, session: r.session, text: await tabList(r), screenshot: await shot(fresh) }
        break
      }
      case 'tab_switch': {
        const pages = r.context.pages()
        const i = parseTabIndex(input.value, pages.length)
        if (i === null) throw new BrowserError(`tab index must be 0..${pages.length - 1}`)
        r.page = pages[i]
        await r.page.bringToFront()
        out = { url: r.page.url(), ok: true, action, session: r.session, text: await tabList(r), screenshot: await shot(r.page) }
        break
      }
      case 'tab_close': {
        const pages = r.context.pages()
        const i = input.value === undefined || input.value === '' ? pages.indexOf(page) : parseTabIndex(input.value, pages.length)
        if (i === null || i < 0) throw new BrowserError(`tab index must be 0..${pages.length - 1}`)
        if (pages.length === 1) throw new BrowserError('cannot close the last tab')
        const wasCurrent = pages[i] === r.page
        await pages[i].close()
        const left = r.context.pages()
        if (wasCurrent) r.page = left[Math.min(i, left.length - 1)]
        out = { url: r.page.url(), ok: true, action, session: r.session, text: await tabList(r), screenshot: await shot(r.page) }
        break
      }
      case 'upload': {
        if (!input.selector) throw new BrowserError('selector required (the file input)')
        const name = safeUploadName(input.value || '')
        if (!name) throw new BrowserError('value must be a plain file name inside the browser upload folder')
        const full = join(BROWSER_UPLOAD_DIR, name)
        if (!existsSync(full)) throw new BrowserError(`no such file in the upload folder: ${name}`, 404, 'no_file')
        await page.locator(input.selector).first().setInputFiles(full)
        out = { ...base(), screenshot: await shot(page) }
        break
      }
      case 'downloads':
        out = { ...base(), text: listDownloads() }
        break
      case 'dialogs':
        out = { ...base(), text: JSON.stringify({ policy: r.dialogPolicy, seen: r.dialogs }) }
        break
      case 'dialog_policy': {
        const pol = parseDialogPolicy(input.value)
        if (!pol) throw new BrowserError('value must be "accept" or "dismiss"')
        r.dialogPolicy = pol
        out = { ...base(), text: pol }
        break
      }
      case 'clipboard_write':
      case 'clipboard_read': {
        let origin: string
        try { origin = new URL(page.url()).origin } catch { throw new BrowserError('open a page first (the clipboard needs an origin)') }
        if (origin === 'null') throw new BrowserError('open an http(s) page first (the clipboard needs an origin)')
        await r.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin })
        if (action === 'clipboard_write') {
          await page.evaluate((t: string) => navigator.clipboard.writeText(t), String(input.value ?? ''))
          out = base()
        } else {
          out = { ...base(), text: (await page.evaluate(() => navigator.clipboard.readText())).slice(0, 100_000) }
        }
        break
      }
      default:
        throw new BrowserError(`unknown action: ${action}`)
    }
    lastAction = { at: Date.now(), action, error: null }
    await saveSessionCookies(r)
    return out
  } catch (err: any) {
    // A TENYLEGES Playwright-hibauzenet megy tovabb (timeout / navigation
    // failed / selector not found) -- nem talalgatott ok.
    lastAction = { at: Date.now(), action, error: String(err?.message || err) }
    if (err instanceof BrowserError) throw err
    throw new BrowserError(String(err?.message || err), 422, 'playwright')
  }
}

async function tabList(r: Runtime): Promise<string> {
  const pages = r.context.pages()
  const rows = []
  for (let i = 0; i < pages.length; i++) {
    rows.push({ index: i, current: pages[i] === r.page, url: pages[i].url(), title: await pages[i].title().catch(() => '') })
  }
  return JSON.stringify(rows)
}

function listDownloads(): string {
  try {
    return JSON.stringify(readdirSync(BROWSER_DOWNLOAD_DIR).map(n => ({ name: n, bytes: statSync(join(BROWSER_DOWNLOAD_DIR, n)).size })))
  } catch { return '[]' }
}

// --------------------------------------------------------------- sessions

export interface SessionInfo { name: string; savedAt: string; url?: string; health: SessionHealth | 'unreadable' }

export function listBrowserSessions(nowSec = Math.floor(Date.now() / 1000)): SessionInfo[] {
  return listSecrets()
    .filter(s => s.id.startsWith(SESSION_VAULT_PREFIX))
    .map(s => {
      let health: SessionInfo['health'] = 'unreadable'
      try { health = sessionHealthFromState(JSON.parse(getSecret(s.id) || 'null'), nowSec) } catch { /* unreadable */ }
      return { name: s.id.slice(SESSION_VAULT_PREFIX.length), savedAt: s.updatedAt, url: s.url, health }
    })
}

export function deleteBrowserSession(name: string): boolean {
  const slug = sessionSlug(name)
  return !!slug && deleteSecret(SESSION_VAULT_PREFIX + slug)
}

/** "Log out of everything": stop the browser, then wipe the persistent profile (cookies, logins, cache). */
export async function clearBrowserProfile(): Promise<{ removed: boolean }> {
  await stopBrowser()
  const existed = existsSync(BROWSER_PROFILE_DIR)
  rmSync(BROWSER_PROFILE_DIR, { recursive: true, force: true })
  return { removed: existed }
}

function profileInfo() {
  const exists = existsSync(BROWSER_PROFILE_DIR)
  let savedAt: number | null = null
  try { savedAt = statSync(BROWSER_PROFILE_DIR).mtimeMs } catch { /* none yet */ }
  return { path: BROWSER_PROFILE_DIR, exists, savedAt }
}

// ----------------------------------------------------------------- status

export async function getBrowserStatus() {
  const { pw, error } = await loadPlaywright()
  let chromiumPath: string | null = null
  if (pw) { try { chromiumPath = pw.chromium.executablePath() } catch { /* none */ } }
  let sessions: SessionInfo[] = []
  let sessionsError: string | null = null
  try { sessions = listBrowserSessions() } catch (err: any) { sessionsError = String(err?.message || err) }
  return {
    enabled: isBrowserEnabled(),
    playwright: { available: !!pw, error },
    chromium: { installed: !!chromiumPath && existsSync(chromiumPath), path: chromiumPath },
    install: getInstallState(),
    running: !!rt && rt.alive(),
    url: rt ? rt.page.url() : null,
    session: rt?.session ?? null,
    persistent: rt ? rt.persistent : null,
    profile: profileInfo(),
    idleMinutes: BROWSER_IDLE_MS / 60000,
    lastAction,
    sessions,
    sessionsError,
  }
}
