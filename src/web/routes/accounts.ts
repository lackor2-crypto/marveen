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
import { getSecret, listSecrets, vaultFileState } from '../vault.js'
import { json, readBody } from '../http-helpers.js'
import { startLogin, loginStatus, submitCode, cancelLogin, readIdentity, logoutAccount, listAccounts, identityAudit } from '../claude-auth-runner.js'
import { pinExpectedEmail } from '../claude-plans.js'
import { hardRestartMarveenChannels } from '../channel-monitor.js'
import { defaultLoginDependents, unaffectedByDefaultLogin, agentsUsingLogin } from '../default-login-dependents.js'
import { gitAccountsWithToken } from '../../git-accounts.js'
import { keyServiceImpact, KEY_SERVICE_CATALOG } from '../key-service-dependents.js'
import { keyServiceView, nextSlotId } from '../key-service-slots.js'
import { setActiveSlotFor } from '../key-service-active.js'
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

  // Ugyanez a kérdés a KULCSOS szolgáltatásokra.
  //
  // Boss, 2026-09-02: "mi az, hogy nem lehet kijelentkeztetni egy fiókot? meg
  // bejelentkeztetni". A kulcs kivétele visszafordíthatatlan (a régi érték nem
  // jön vissza), tehát ugyanaz jár neki, mint a Claude-kijelentkezésnek: előtte
  // LÁTSZANIA kell, mit állít meg. Maga a törlés a meglévő DELETE /api/vault/:id
  // úton megy -- egy titkot egy helyen törlünk, nem kettőn.
  if (path === '/api/accounts/key/impact' && method === 'GET') {
    const vaultId = (ctx.url.searchParams.get('vaultId') ?? '').trim()
    if (vaultId === '') { json(res, { ok: false, error: 'Hiányzik a vaultId.' }, 400); return true }
    const impact = keyServiceImpact(vaultId)
    json(res, {
      ok: true,
      ...impact,
      // Külön mező, mert a "nincs bekötve" és a "be van kötve, de senki nem
      // használja" két különböző mondat -- a lista hosszából egyik sem derül ki.
      configured: getSecret(vaultId) !== null,
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

  // --- KULCS-FÉRŐHELYEK: több előfizetés EGY szolgáltatáshoz ----------------
  //
  // Boss, 2026-09-02: "akár felvihetne később egy legújabb GLM előfizetést is.
  // másodikat. nem? tehát akkor miért tűnne el onnan a listából?"
  //
  // Eddig egy szolgáltatás egy trezor-nevet ismert, tehát a második kulcs
  // FELÜLÍRTA volna az elsőt -- a lehetőség tényleg megszűnt, amint éltél vele.
  // Mostantól férőhelyek vannak (`zai-coding-key`, `zai-coding-key.2`, ...),
  // ez a végpont pedig megmutatja, mi hol van, és melyik az aktív.
  //
  // Titok SOHA nem megy ki innen: csak azonosítók, címkék és időbélyegek.
  if (path === '/api/key-services' && method === 'GET') {
    const state = vaultFileState()
    // A NULLA KÉT DOLGOT JELENTHET. Olvashatatlan trezornál a `listSecrets()`
    // ÜRES listát ad -- ami pontosan úgy néz ki, mint egy friss telepítés.
    // Ezért magától a fájltól kérdezzük meg, és a felület kimondja, ha nem
    // láttunk oda: nem "0 kulcsod van", hanem "nem tudtam megnézni".
    const secrets = state === 'ok' ? listSecrets() : []
    const takenIds = secrets.map(s => s.id)
    json(res, {
      ok: true,
      vaultReadable: state !== 'unreadable',
      services: KEY_SERVICE_CATALOG.map(svc => {
        const view = keyServiceView(svc.vaultId, state === 'unreadable' ? null : secrets)
        return {
          id: svc.id,
          vaultId: svc.vaultId,
          slots: view.slots,
          count: view.count,
          activeSlotId: view.activeSlotId,
          activeMissing: view.activeMissing,
          // Ide megy a KÖVETKEZŐ kulcs. A gomb enélkül az alap-nevet küldené,
          // és felülírná az elsőt -- pontosan azt, ami miatt ez az egész
          // átalakítás kellett.
          nextSlotId: state === 'unreadable' ? null : nextSlotId(svc.vaultId, takenIds),
        }
      }),
    })
    return true
  }

  // Melyik férőhely legyen az AKTÍV -- vagyis melyik előfizetést költse a flotta.
  //
  // Visszafordítható (bármikor visszaváltható), ezért nincs előnézet-kényszer;
  // de a válasz megmondja, kit érint, mert a következő indulásuktól ők fognak
  // más kulcsot használni.
  if (path === '/api/key-services/active' && method === 'POST') {
    let body: { serviceId?: unknown; slotId?: unknown } = {}
    try { body = JSON.parse((await readBody(req)).toString() || '{}') } catch { /* defaults */ }
    const serviceId = typeof body.serviceId === 'string' ? body.serviceId.trim() : ''
    const svc = KEY_SERVICE_CATALOG.find(s => s.vaultId === serviceId || s.id === serviceId)
    if (!svc) {
      json(res, { ok: false, errorKey: 'acchub.key_active_err_unknown', error: 'Ismeretlen kulcs-szolgáltatás.' }, 400)
      return true
    }
    // `null` = "ne legyen kijelölés": ilyenkor az alap-hely lép életbe, pont
    // úgy, mint egy friss telepítésen. Ez a visszaút, nem hiba.
    const slotId = body.slotId === null || body.slotId === undefined
      ? null
      : (typeof body.slotId === 'string' ? body.slotId.trim() : '')
    if (slotId === '') {
      json(res, { ok: false, errorKey: 'acchub.key_active_err_noslot', error: 'Hiányzik a slotId.' }, 400)
      return true
    }
    if (vaultFileState() === 'unreadable') {
      // Nem tudjuk ellenőrizni, létezik-e a hely. Egy nem létező helyre mutató
      // kijelölés néma hiba lenne (más előfizetés pénzét költené), ezért inkább
      // nem írunk semmit, és megmondjuk, miért.
      json(res, { ok: false, errorKey: 'acchub.key_active_err_vault', error: 'A trezor most nem olvasható, ezért nem tudom ellenőrizni a kulcs-helyet. Nyisd meg a Trezor oldalt.' }, 409)
      return true
    }
    if (slotId !== null) {
      const view = keyServiceView(svc.vaultId)
      const slot = view.slots.find(s => s.slotId === slotId)
      if (!slot) {
        json(res, { ok: false, errorKey: 'acchub.key_active_err_missing', error: 'Ez a kulcs-hely nincs meg a trezorban.' }, 404)
        return true
      }
      if (slot.boundOn) {
        // Egy MÁSIK kártya mezője: a `getSecret` a kijelölt kártya SAJÁT
        // értékét olvasná, nem a mezőt -- vagyis némán mást adna vissza.
        json(res, { ok: false, errorKey: 'acchub.key_active_err_bound', error: 'Ez a kulcs egy másik kártya mezője, azt nem lehet aktívvá tenni. Vedd fel külön kulcsként.' }, 400)
        return true
      }
    }
    setActiveSlotFor(svc.vaultId, slotId)
    const after = keyServiceView(svc.vaultId)
    const impact = keyServiceImpact(svc.vaultId)
    json(res, {
      ok: true,
      serviceId: svc.vaultId,
      activeSlotId: after.activeSlotId,
      // Kit érint: a következő indulásuktól ezek az ügynökök (és funkciók) a
      // most választott kulcsot használják.
      agents: impact.agents,
      featureKeys: impact.featureKeys,
      // Ha nem láttunk bele minden ügynökbe, azt is kimondjuk -- az üres lista
      // különben "senkit nem érint"-nek olvasódna.
      blind: impact.blind,
      rosterOk: impact.rosterOk,
    })
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
    // A NULLA KÉT DOLGOT JELENTHET: olvashatatlan trezornál a `listSecrets()`
    // ÜRES listát ad, ami pontosan úgy néz ki, mint egy friss telepítés. Ezért
    // magától a fájltól kérdezzük meg, és romlott trezornál `count: null` megy
    // ki -- nem "0 kulcsod van".
    const vaultState = vaultFileState()
    const keySecrets = vaultState === 'ok' ? listSecrets() : []
    const takenIds = keySecrets.map(s => s.id)
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
        // A kulcsos szolgáltatások EGYETLEN listából jönnek
        // (KEY_SERVICE_CATALOG), hogy a Fiókok oldal, a "További lehetőségeid"
        // és a férőhely-kezelő ne tudjon szétcsúszni. A GLM (Z.ai) és a
        // DeepSeek is fizetett kódoló ELŐFIZETÉS, tehát a helyük itt van, a
        // Claude-bejelentkezések mellett, nem egy modell-legördülő mélyén.
        //
        // A `configured` ugyanaz a kérdés, amit az egész rendszer feltesz
        // (`getSecret(id) !== null`); a `count`/`slots` azt mondja meg, HÁNY
        // kulcs van, és a `nextSlotId`, hogy hova kerül a következő.
        ...KEY_SERVICE_CATALOG.map(svc => {
          const view = keyServiceView(svc.vaultId, vaultState === 'unreadable' ? null : keySecrets)
          return {
            id: svc.id,
            vaultId: svc.vaultId,
            configured: getSecret(svc.vaultId) !== null,
            count: view.count,
            slots: view.slots,
            activeSlotId: view.activeSlotId,
            activeMissing: view.activeMissing,
            nextSlotId: vaultState === 'unreadable' ? null : nextSlotId(svc.vaultId, takenIds),
          }
        }),
      ],
    })
    return true
  }

  return false
}
