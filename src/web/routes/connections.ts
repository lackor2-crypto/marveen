// The "what is Marveen connected to, and how do I connect the rest" API.
//
// Boss, 2026-08-14, after being told to run `claude mcp login` in an Ubuntu
// terminal: "de ezzel csak az a problemem hogy ezt hogy fogja megcsinalni egy
// user aki komuves? nem ert semmihez sem? [...] a marveen feluletet mondjuk
// tudja kezelni de mast nem. szoval ezt a marveen ban kellene megoldani."
// And, the same day: "ugy tervezd meg hogy lehet hogy 10 email lesz
// csatlakoztatva. mindegyiknek kellene hogy mukodjon."
//
// Two halves, deliberately on one path, because from the operator's side they
// answer one question:
//
//   /api/connections/google  -- Marveen's OWN Google logins. Genuinely
//     multi-account: ten addresses can be live at once, each keeping Gmail,
//     Calendar and Drive. This is where the ten-address requirement lives.
//
//   /api/connections/mcp     -- the Claude Code connectors, per Claude account.
//     Measured limit: one Google identity per connector per Claude account, and
//     a second one CANNOT be added under a different name (the endpoint refuses
//     dynamic client registration). See ../mcp-connectors.ts.
//
// Everything under /api/ is behind the dashboard auth gate; that is the only
// reason it is safe to expose a sign-in from here. No handler on this path ever
// logs an authorize URL, a pasted redirect or a token.
import { json, readBody } from '../http-helpers.js'
import {
  listGoogleAccounts,
  listGoogleAccountsProbed,
  googleOauthClientPresent,
  googleOauthProjectId,
  startGoogleAuth,
  googleAuthStatus,
  submitGooglePaste,
  cancelGoogleAuth,
  probeGoogleAccount,
  setDefaultGoogleAccount,
  removeGoogleAccount,
  invalidateGoogleProbe,
} from '../google-auth-runner.js'
import { suggestAccountId } from '../google-accounts.js'
import { runGoogleLiveCheckOnce, markGoogleLiveOk } from '../google-live-check.js'
import { credentialExpiries, worstExpiryStatus } from '../credential-expiry.js'
import { systemHealth, worstHealthStatus } from '../system-health.js'
import {
  mcpStatus,
  refreshMcpStatus,
  startMcpLogin,
  mcpLoginStatus,
  submitMcpPaste,
  finishMcpLogin,
} from '../mcp-runner.js'
import type { RouteContext } from './types.js'

async function body(req: RouteContext['req']): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse((await readBody(req)).toString() || '{}')
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

export async function tryHandleConnections(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  // --- Google: Marveen's own multi-account logins ---------------------------

  if (path === '/api/connections/google' && method === 'GET') {
    // `probe=1` is the explicit "check them all now" the refresh button sends.
    // Off by default: with ten accounts that is forty API calls, and a page
    // render is not a reason to make them.
    const withProbe = url.searchParams.get('probe') === '1'
    const force = url.searchParams.get('force') === '1'
    json(res, {
      clientPresent: googleOauthClientPresent(),
      // The Cloud Console project name, so the "Google refused you" walkthrough
      // can link straight at the test-user list. A name, not a credential --
      // the client id and secret in that same file are never read.
      projectId: googleOauthProjectId(),
      accounts: withProbe ? await listGoogleAccountsProbed(force) : listGoogleAccounts(),
    })
    return true
  }

  // One account, checked on its own -- both the per-row "check this one" button
  // and the page's own background sweep of accounts it has never seen. The
  // button forces a fresh answer (that is what the operator asked for); the
  // sweep sends force:false and takes whatever the 5-minute cache holds, so
  // re-opening the page costs nothing.
  if (path === '/api/connections/google/probe' && method === 'POST') {
    const b = await body(req)
    const id = str(b.id).trim()
    if (!id) { json(res, { ok: false, error: 'id required' }, 400); return true }
    json(res, { ok: true, result: await probeGoogleAccount(id, b.force !== false) })
    return true
  }

  if (path === '/api/connections/google/login' && method === 'GET') {
    const st = googleAuthStatus()
    // A jelszavas-beillesztes NELKULI ut (a bongeszo visszairanyitasa a helyi
    // portra) itt jelenti be a sikert -- es sehol maserre nincs kapaszkodo.
    // Ha nem konyvelnenk el, a friss fiok a kovetkezo oras meresig "halott"
    // maradna a lapon, es a vegigvezeto ujra felajanlana.
    if (st.phase === 'done' && st.accountId) markGoogleLiveOk(st.accountId)
    json(res, st)
    return true
  }

  if (path === '/api/connections/google/login' && method === 'POST') {
    const b = await body(req)
    // The operator types an address or a nickname; the id is derived the same
    // way the script derives one, and de-duplicated against what exists. With
    // ten accounts a name collision is a matter of time, and silently
    // overwriting somebody's token would be the worst possible outcome.
    const taken = listGoogleAccounts().map(a => a.id)
    const wanted = str(b.id).trim() || str(b.name).trim()
    if (!wanted) { json(res, { ok: false, error: 'Adj nevet vagy e-mail címet.' }, 400); return true }
    const id = suggestAccountId(wanted, str(b.id).trim() ? [] : taken)
    // Uj fioknal a kezelo beirt cime a tipp: a tarolobol meg nincs mit
    // elovenni. Meglevo fioknal a szkript a sajat mentett cimet hasznalja.
    const hint = wanted.includes('@') ? wanted : ''
    // `force === true` SZIGORUAN: a felulet gombja fuggveny-nyilat kap, mert egy
    // atadott click-Event igaz-szeru, es minden elso kattintas kiloné valaki mas
    // futo bejelentkeztetesét (a script fix loopback-portot foglal).
    const result = startGoogleAuth(id, { force: b.force === true, hint })
    json(res, result.ok
      ? { ok: true, id }
      // A foglaltsag GEPI mezokent utazik, hogy az oldal megnevezhesse a masik
      // fiokot es felajanlhassa a "szakitsd meg azt" kiutat -- magyar mondatot
      // visszafejteni a bongeszoben nem lehet.
      : { ok: false, error: result.error, code: result.code ?? null, busyAccountId: result.busyAccountId ?? null },
      result.ok ? 200 : 400)
    return true
  }

  if (path === '/api/connections/google/login/paste' && method === 'POST') {
    const b = await body(req)
    const result = await submitGooglePaste(str(b.value))
    if (result.ok && result.accountId) markGoogleLiveOk(result.accountId)
    // `blocked` travels with the failure so the page can open the walkthrough
    // in the same beat, rather than waiting for the next status poll.
    json(res, result.ok ? { ok: true, savedAs: result.savedAs ?? null }
      : { ok: false, error: result.error, blocked: result.blocked ?? null },
      result.ok ? 200 : 400)
    return true
  }

  if (path === '/api/connections/google/login/cancel' && method === 'POST') {
    cancelGoogleAuth()
    json(res, { ok: true })
    return true
  }

  // "Futtasd le most." Az onellenorzes sora ezt hivja, ha az elo Google-kor
  // meg sosem futott le, vagy megallt: a felhasznalonak nem kell megvarnia a
  // kovetkezo orat, es nem kell terminalhoz nyulnia. A valasz a friss kor --
  // ugyanaz, amit a hatterfutas irt volna ki.
  if (path === '/api/connections/google/live-check' && method === 'POST') {
    try {
      json(res, { ok: true, result: await runGoogleLiveCheckOnce() })
    } catch (err) {
      json(res, { ok: false, error: String((err as Error)?.message || err) }, 500)
    }
    return true
  }

  if (path === '/api/connections/google/default' && method === 'POST') {
    const b = await body(req)
    const result = setDefaultGoogleAccount(str(b.id).trim())
    json(res, result.ok ? { ok: true } : { ok: false, error: result.error }, result.ok ? 200 : 400)
    return true
  }

  if (path === '/api/connections/google/remove' && method === 'POST') {
    const b = await body(req)
    const result = removeGoogleAccount(str(b.id).trim())
    json(res, result.ok ? { ok: true } : { ok: false, error: result.error }, result.ok ? 200 : 400)
    return true
  }

  // --- Claude Code connectors, per Claude account ---------------------------

  if (path === '/api/connections/mcp' && method === 'GET') {
    // Served from cache and never blocking: one probe health-checks every
    // connector on every account (measured 8-20s each), so the page gets what
    // is known plus a `refreshing` flag, and polls.
    json(res, mcpStatus(url.searchParams.get('force') === '1'))
    return true
  }

  if (path === '/api/connections/mcp/refresh' && method === 'POST') {
    void refreshMcpStatus()
    json(res, { ok: true })
    return true
  }

  if (path === '/api/connections/mcp/login' && method === 'GET') {
    json(res, mcpLoginStatus())
    return true
  }

  if (path === '/api/connections/mcp/login' && method === 'POST') {
    const b = await body(req)
    const accountId = typeof b.accountId === 'string' && b.accountId ? b.accountId : null
    const server = str(b.server)
    if (!server) { json(res, { ok: false, error: 'server required' }, 400); return true }
    const result = startMcpLogin(accountId, server)
    json(res, result.ok ? { ok: true } : { ok: false, error: result.error }, result.ok ? 200 : 400)
    return true
  }

  if (path === '/api/connections/mcp/login/paste' && method === 'POST') {
    const b = await body(req)
    const result = submitMcpPaste(str(b.value))
    json(res, result.ok ? { ok: true } : { ok: false, error: result.error }, result.ok ? 200 : 400)
    return true
  }

  if (path === '/api/connections/mcp/login/finish' && method === 'POST') {
    finishMcpLogin()
    // The connector only appears to a Claude Code started AFTER the
    // authorization, so the cached "not connected" is now known-stale.
    void refreshMcpStatus()
    json(res, { ok: true })
    return true
  }

  // --- both halves at once, for the Overview card ---------------------------

  if (path === '/api/connections/summary' && method === 'GET') {
    const google = listGoogleAccounts()
    const mcp = mcpStatus()
    // A Google account whose last probe FAILED is the loud one: it means an
    // address that used to work has stopped. An unchecked account is not a
    // problem, it is just unchecked, and must not be counted as broken.
    const googleBroken = google.filter(a => a.checkedAt !== null && a.error !== null).length
    // The clock half. `broken` above is what a live probe already SAW fail;
    // this is what WILL fail on a date, and it is the only half that can warn
    // while there is still time to act. Both are needed: measured 2026-08-19,
    // every probe was green while the token the mail sender actually reads had
    // been dead for two days.
    const expiry = credentialExpiries()
    const expiryWorst = worstExpiryStatus(expiry)
    // The third half: what is neither probed nor on a clock, but rots. Boss,
    // 2026-08-19: "barmi ami elromolhat arra tegyunk ellenorzest." Measured the
    // same hour: the automatic backup had been running successfully for weeks
    // while carrying none of the credentials a restore needs.
    const health = systemHealth()
    const healthWorst = worstHealthStatus(health)
    json(res, {
      google: {
        total: google.length,
        broken: googleBroken,
        clientPresent: googleOauthClientPresent(),
      },
      mcp: {
        needsLogin: mcp.needsLogin, broken: mcp.broken, connected: mcp.connected,
        // Sent but never counted: a channel plugin the probe cannot launch is
        // not a fault (see isAgentManagedChannel), and the Overview must not
        // raise an alarm about a Telegram the operator uses every day.
        agentManaged: mcp.agentManaged,
        refreshing: mcp.refreshing,
      },
      // What expires and when, healthy items included -- Boss, 2026-08-19:
      // "ha nincs semmi baj akkor azt is irja ki". The card states the good
      // case out loud, so an empty card never has to be interpreted.
      // A Cloud Console projekt NEVE (nem hitelesito adat), hogy a
      // vegigvezeto pontosan arra a projektre tudjon linkelni, amelyiket
      // elesiteni kell -- ne kelljen a usernek projektet keresgelnie.
      projectId: googleOauthProjectId(),
      expiry: {
        worst: expiryWorst,
        soonest: expiry.length ? expiry[expiry.length - 1].daysLeft : null,
        items: expiry.map(e => ({
          id: e.id, label: e.label, status: e.status, daysLeft: e.daysLeft,
          expiresAt: e.expiresAt,
        })),
      },
      health: { worst: healthWorst, items: health },
      // Worst thing worth saying, so the card can colour itself without the
      // browser re-deriving the rule. A connector that merely needs a sign-in
      // is a missed capability, not a broken install -- alarm colours spent on
      // convenience teach the operator to ignore alarm colours. An EXPIRED
      // credential ranks with a failed probe: it is the same outage, just
      // caught by the clock instead of by a call.
      // A backup that would not restore ranks with a dead credential: both are
      // outages you only find out about at the worst possible moment.
      tier: (googleBroken > 0 || expiryWorst === 'expired' || healthWorst === 'bad') ? 'recommended'
        : mcp.needsLogin > 0 ? 'recommended'
          : (google.length === 0 && googleOauthClientPresent()) ? 'extra'
            : (mcp.broken > 0 || expiryWorst === 'soon' || healthWorst === 'warn') ? 'extra'
              // 'ok' is a real, rendered state now, not a reason to hide: the
              // card stays on the Overview and says everything works.
              : 'ok',
    })
    return true
  }

  if (path === '/api/connections/invalidate' && method === 'POST') {
    invalidateGoogleProbe()
    json(res, { ok: true })
    return true
  }

  return false
}
