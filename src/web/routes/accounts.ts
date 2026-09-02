// Boss 2026-08-07 (voice): nothing in the dashboard told a user which
// accounts/credentials Marveen actually has -- Claude Code auth, Telegram,
// Google, GitHub, OpenRouter, Groq are each wired up through their own,
// separate mechanism (install-time prompt, OAuth file, gh CLI, Vault) and a
// fresh install (or Boss himself) had no single place to see "what's
// connected, what isn't, how do I connect the rest". This is that single
// place -- a read-only status list, GET-only, new isolated file so it never
// touches the existing per-mechanism setup flows.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT, TELEGRAM_BOT_TOKEN } from '../../config.js'
import { getSecret } from '../vault.js'
import { json, readBody } from '../http-helpers.js'
import { startLogin, loginStatus, submitCode, cancelLogin, readIdentity, logoutAccount, listAccounts, identityAudit } from '../claude-auth-runner.js'
import { pinExpectedEmail } from '../claude-plans.js'
import { hardRestartMarveenChannels } from '../channel-monitor.js'
import { defaultLoginDependents, unaffectedByDefaultLogin, agentsUsingLogin } from '../default-login-dependents.js'
import { gitAccountsWithToken } from '../../git-accounts.js'
import { GLM_VAULT_KEY } from '../glm-models.js'
import type { RouteContext } from './types.js'

// Google went multi-account the same way (kanban b0c697ce, 2026-08-10):
// store/google-tokens.json keyed by account name, with a "_default" pointer
// that isn't itself an account -- excluded here same as githubAccountNames()
// excludes nothing extra (GitHub's file has no such marker key).
export function googleAccountNames(): { accounts: string[]; default: string | null } {
  const p = join(PROJECT_ROOT, 'store', 'google-tokens.json')
  if (!existsSync(p)) {
    // Pre-migration installs (or a fresh one that never ran google-auth.py
    // token/test yet, so the auto-migration hasn't fired) still have the
    // legacy single-file token -- report it as one unnamed-but-configured
    // account rather than showing "not configured" for a working setup.
    const legacy = join(PROJECT_ROOT, 'store', 'google-token.json')
    return { accounts: existsSync(legacy) ? ['lackor2'] : [], default: existsSync(legacy) ? 'lackor2' : null }
  }
  try {
    const data = JSON.parse(readFileSync(p, 'utf-8'))
    if (!data || typeof data !== 'object') return { accounts: [], default: null }
    const accounts = Object.keys(data).filter(k => k !== '_default')
    return { accounts, default: typeof data._default === 'string' ? data._default : null }
  } catch {
    return { accounts: [], default: null }
  }
}

export async function tryHandleAccounts(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  // --- Claude Code account switch (kanban #52) ------------------------------
  // Everything under /api/accounts/claude is behind the same /api/ auth gate as
  // the rest (auth-gate.ts: every /api/ path requires a principal), which is the
  // only reason it is safe to expose a login here at all.
  //
  // Nothing on this path ever logs the authorize URL or the pasted code: the URL
  // carries the PKCE challenge and state, the code is a one-time secret, and a
  // dashboard log is not the place for either.

  if (path === '/api/accounts/claude' && method === 'GET') {
    // Kik allnak meg valojaban a gep sajat bejelentkezese nelkul, es kik nem.
    // A felulet ebbol irja a mondatot, tehat nem tud elavulni attol, hogy
    // valaki uj fiokot kot be vagy modellt valt (Boss, 2026-08-21: "ez hamis
    // allitas. mert most is tudok veled dolgozni!").
    // KI VAN EBBEN A SLOTBAN. Az utkozes-lista (ket nevesitett elofizetes
    // ugyanazon a Claude-fiokon) es a `blind` szam egyutt jar: ha nem lattunk
    // oda minden fiokba, a lista HIANYOS lehet, es a lap ezt ki is mondja --
    // egy ures utkozes-lista nem azonos azzal, hogy nincs baj.
    const audit = identityAudit()
    json(res, {
      ...loginStatus(),
      dependents: defaultLoginDependents().length,
      unaffected: unaffectedByDefaultLogin().length,
      identityCollisions: audit.collisions,
      identityBlind: audit.blind,
    })
    return true
  }

  // "Mostantol EZ a cim tartozzon ehhez az elofizeteshez." Csak kifejezett
  // felhasznaloi dontesre fut: a bejelentkezes maga SOSE irja felul csendben,
  // amit egyszer rogzitettunk -- pont az a hiba lenne, amit ez oriz.
  if (path === '/api/accounts/claude/pin-email' && method === 'POST') {
    let body: { planId?: unknown; email?: unknown } = {}
    try { body = JSON.parse((await readBody(req)).toString() || '{}') } catch { /* defaults */ }
    const planId = typeof body.planId === 'string' ? body.planId.trim() : ''
    const email = typeof body.email === 'string' ? body.email.trim() : ''
    if (!planId || !email) {
      json(res, { ok: false, error: 'Hiányzik az előfizetés azonosítója vagy a cím.' }, 400)
      return true
    }
    const r = pinExpectedEmail(planId, email, { force: true })
    if (r.ok) listAccounts(true)
    json(res, r.ok ? { ok: true } : { ok: false, error: r.error }, r.ok ? 200 : 500)
    return true
  }

  if (path === '/api/accounts/claude/login' && method === 'POST') {
    let body: { label?: unknown; email?: unknown; useConsole?: unknown; target?: unknown; force?: unknown; planId?: unknown } = {}
    try { body = JSON.parse((await readBody(req)).toString() || '{}') } catch { /* defaults */ }
    // target 'default' repairs the install's OWN login (~/.claude) instead of
    // adding a parallel account -- the wizard's step and the Overview's red row
    // both land here (Boss, 2026-08-21: the step used to link to claude.ai,
    // which on a signed-in browser just opens the chat and authenticates
    // nothing on this machine).
    const result = startLogin({
      label: typeof body.label === 'string' ? body.label : undefined,
      email: typeof body.email === 'string' ? body.email.trim() : undefined,
      useConsole: body.useConsole === true,
      target: body.target === 'default' ? 'default' : 'new',
      force: body.force === true,
      // Re-login into an account that is already registered but signed out --
      // the repair path the page needs so a logged-out account does not turn
      // into a second one under a "-2" name.
      planId: typeof body.planId === 'string' ? body.planId : undefined,
    })
    json(
      res,
      result.ok
        ? { ok: true, planId: result.planId, isDefault: result.isDefault === true }
        : { ok: false, error: result.error, errorKey: result.errorKey, errorParams: result.errorParams },
      result.ok ? 200 : 400,
    )
    return true
  }

  // After the install's own login comes back, the main agent is still the
  // process that failed with the dead credential -- it does not re-read the
  // file on its own. Restarting its pane is the difference between "logged in"
  // and "working again", so the page fires this the moment the flow reports
  // done, and the operator is not left with one more thing to know about.
  if (path === '/api/accounts/claude/login/finish' && method === 'POST') {
    const r = hardRestartMarveenChannels()
    json(res, r.ok ? { ok: true } : { ok: false, error: r.error }, r.ok ? 200 : 500)
    return true
  }

  // WHO does this sign out? Asked before the button is pressed, never after.
  // Boss, 2026-08-29 wanted to sign an account out and bring it back from the
  // page; a logout with no preview would be the same class of surprise as a
  // delete with no list of what is about to go.
  if (path === '/api/accounts/claude/logout-preview' && method === 'GET') {
    const raw = (ctx.url.searchParams.get('planId') ?? '').trim()
    const planId = raw === '' ? null : raw
    const row = planId === null
      ? listAccounts().find(r => r.isDefault)
      : listAccounts().find(r => r.id === planId)
    if (!row) { json(res, { ok: false, error: 'Ezt a fiókot nem találom a listában.' }, 404); return true }
    json(res, {
      ok: true,
      planId,
      isDefault: row.isDefault,
      loggedIn: row.identity.loggedIn,
      email: row.identity.email ?? null,
      // Names, not a count: "két ügynök" tells the operator nothing about
      // whether the one they care about is in there.
      agents: agentsUsingLogin(row.configDir),
    })
    return true
  }

  if (path === '/api/accounts/claude/logout' && method === 'POST') {
    let body: { planId?: unknown } = {}
    try { body = JSON.parse((await readBody(req)).toString() || '{}') } catch { /* defaults */ }
    const planId = typeof body.planId === 'string' && body.planId.trim() !== '' ? body.planId.trim() : null
    const result = logoutAccount(planId)
    json(res, result.ok ? { ok: true, email: result.email ?? null } : { ok: false, error: result.error }, result.ok ? 200 : 400)
    return true
  }

  if (path === '/api/accounts/claude/login/code' && method === 'POST') {
    let body: { code?: unknown } = {}
    try { body = JSON.parse((await readBody(req)).toString() || '{}') } catch { /* defaults */ }
    if (typeof body.code !== 'string') { json(res, { ok: false, error: 'code required' }, 400); return true }
    const result = submitCode(body.code)
    json(res, result.ok ? { ok: true } : { ok: false, error: result.error }, result.ok ? 200 : 400)
    return true
  }

  if (path === '/api/accounts/claude/login/cancel' && method === 'POST') {
    cancelLogin()
    json(res, { ok: true })
    return true
  }

  if (path === '/api/accounts' && method === 'GET') {
    // git-accounts.ts owns the real store (store/.git-tokens.json, plus
    // gh-CLI-borrowed logins) -- this used to read a different, dead file
    // (store/.github-tokens.json) that nothing ever wrote, so this row always
    // showed "not configured" no matter how many GitHub accounts were set up
    // on the Storages page.
    const githubAccounts = gitAccountsWithToken()
    const google = googleAccountNames()
    json(res, {
      core: [
        // Which login, not just "yes there is one": the whole point of #52 is
        // that Boss can see and change the account from here.
        { id: 'claude-code', configured: true, identity: readIdentity() },
        { id: 'telegram', configured: TELEGRAM_BOT_TOKEN.trim() !== '' },
      ],
      optional: [
        { id: 'google', configured: google.accounts.length > 0, accounts: google.accounts, defaultAccount: google.default },
        { id: 'github', configured: githubAccounts.length > 0, accounts: githubAccounts },
        { id: 'openrouter', configured: getSecret('openrouter-fleet-key') !== null },
        { id: 'groq-stt', configured: getSecret('groq-stt-key') !== null },
        // GLM (Z.ai) is a paid coding SUBSCRIPTION, so it belongs on this page
        // next to the Claude logins rather than buried in a model dropdown:
        // it is an account the operator pays for, and this is where accounts
        // are seen and set up.
        { id: 'zai', configured: getSecret(GLM_VAULT_KEY) !== null },
      ],
    })
    return true
  }

  return false
}
