import { describe, it, expect } from 'vitest'
import {
  accountsFromTokenStore,
  parseAccountList,
  parseProbeOutput,
  suggestAccountId,
  parseSavedAccountId,
  isValidAccountId,
  extractConsentUrl,
  isUsablePaste,
  classifyGoogleFailure,
  googleConsentScreenUrl,
  isValidGoogleProjectId,
} from '../web/google-accounts.js'

// Cover for the dashboard-driven Google setup (Boss, 2026-08-14: "lehet hogy 10
// email lesz csatlakoztatva. mindegyiknek kellene hogy mukodjon").
//
// The fixtures below are MEASURED output of scripts/google-auth.py on this
// install, not invented shapes -- the whole point of a parser test is that it
// fails when the thing it parses changes.
//
// The corrupted-input half is the rule from the ZipArchive lesson: an input
// checker that has only ever seen good input has not been tested. Every parser
// here is fed truncated, reordered and hostile text, because the process it
// reads can be killed mid-line.

describe('parseAccountList', () => {
  // MEASURED, 2026-08-14: `python3 scripts/google-auth.py list` printed exactly
  // this (two leading spaces, two before the marker).
  const REAL = '  lackor2  (alapertelmezett)\n'

  it('reads the real script output', () => {
    expect(parseAccountList(REAL)).toEqual([{ id: 'lackor2', isDefault: true }])
  })

  it('keeps ten accounts and marks exactly one default', () => {
    const ids = ['munka', 'maganl', 'ceg', 'ceg2', 'iskola', 'regi', 'uj', 'teszt', 'apa', 'anya']
    const stdout = ids.map((id, i) => `  ${id}${i === 3 ? '  (alapertelmezett)' : ''}`).join('\n')
    const rows = parseAccountList(stdout)
    expect(rows.map(r => r.id)).toEqual(ids)
    expect(rows.filter(r => r.isDefault).map(r => r.id)).toEqual(['ceg2'])
  })

  it('accepts the accented and English spellings of the default marker', () => {
    expect(parseAccountList('  a  (alapértelmezett)')[0].isDefault).toBe(true)
    expect(parseAccountList('  b  (default)')[0].isDefault).toBe(true)
  })

  it('reports no accounts for the empty-store message', () => {
    expect(parseAccountList('Nincs bekotott Google-fiok.')).toEqual([])
    expect(parseAccountList('')).toEqual([])
  })

  // --- the parser fed damaged input ---
  it('drops diagnostic noise instead of inventing accounts', () => {
    const noisy = [
      'Traceback (most recent call last):',
      '  File "scripts/google-auth.py", line 12',
      '  lackor2  (alapertelmezett)',
      'HIBA: valami',
      '  Warning: token refresh failed',
    ].join('\n')
    // Only the slug-shaped line survives; "File" and "Warning:" are not accounts.
    expect(parseAccountList(noisy)).toEqual([{ id: 'lackor2', isDefault: true }])
  })

  it('drops a line cut in half by a killed process rather than half-reading it', () => {
    // A truncated marker leaves "munka  (alapertel" as the id, which is not a
    // slug -- so the row is dropped. That is the behaviour we want: an account
    // missing from one render is a display glitch, but a half-parsed id would
    // put Disconnect and Make-default buttons next to an account that does not
    // exist, and those buttons act on the id.
    expect(() => parseAccountList('  munka  (alapertel')).not.toThrow()
    expect(parseAccountList('  munka  (alapertel')).toEqual([])
    // A complete line before the cut is still read.
    expect(parseAccountList('  munka\n  ceg  (alapertel')).toEqual([{ id: 'munka', isDefault: false }])
  })

  it('refuses ids that are not slugs, however they are dressed up', () => {
    // A path, a flag and a shell metacharacter must never become an account id:
    // the id is handed to the script as an argument.
    const hostile = ['  ../../etc/passwd', '  --help', '  a; rm -rf /', '  UPPER'].join('\n')
    expect(parseAccountList(hostile)).toEqual([])
  })
})

describe('accountsFromTokenStore', () => {
  // This reads store/google-tokens.json directly instead of spawning
  // `google-auth.py list` -- the dashboard asks for the list on every page
  // render, and an execFileSync there freezes the whole process. The tests
  // below are the price of that: they pin it to the script's OWN rules
  // (cmd_list + _default_account), because a drift here means the page and the
  // agents disagree about which address is in use.

  it('reads keys as accounts and the pointer as the default', () => {
    expect(accountsFromTokenStore({ _default: 'ceg', lackor2: {}, ceg: {} }))
      .toEqual([{ id: 'lackor2', isDefault: false }, { id: 'ceg', isDefault: true }])
  })

  it('makes a lone account the default even with no pointer', () => {
    // The script does this in _default_account(); without it the only account
    // an install has would be drawn as "not the default one".
    expect(accountsFromTokenStore({ lackor2: {} })).toEqual([{ id: 'lackor2', isDefault: true }])
  })

  it('marks nobody when the pointer is missing and there are many', () => {
    // Also the script's rule: with several accounts and no pointer it returns
    // None. Guessing here would put a "default" badge on an arbitrary row.
    const rows = accountsFromTokenStore({ a: {}, b: {}, c: {} })
    expect(rows.every(r => !r.isDefault)).toBe(true)
  })

  it('ignores a pointer to an account that is not there', () => {
    // A dangling _default is what a hand-edited or half-written file leaves.
    const rows = accountsFromTokenStore({ _default: 'torolt', a: {}, b: {} })
    expect(rows.every(r => !r.isDefault)).toBe(true)
  })

  it('agrees with the script on an empty or unusable store', () => {
    expect(accountsFromTokenStore({})).toEqual([])
    expect(accountsFromTokenStore({ _default: 'a' })).toEqual([])
    expect(accountsFromTokenStore(null as unknown as Record<string, unknown>)).toEqual([])
  })

  it('refuses keys that are not slugs, however the file got them', () => {
    // The id goes back out as a process argument and as an HTML attribute.
    const rows = accountsFromTokenStore({ '../../etc/passwd': {}, '-flag': {}, 'a b': {}, jo: {} })
    expect(rows).toEqual([{ id: 'jo', isDefault: true }])
  })

  it('holds ten accounts and marks exactly one', () => {
    const data: Record<string, unknown> = { _default: 'ceg2' }
    for (const id of ['munka', 'maganl', 'ceg', 'ceg2', 'iskola', 'regi', 'uj', 'teszt', 'apa', 'anya']) data[id] = {}
    const rows = accountsFromTokenStore(data)
    expect(rows).toHaveLength(10)
    expect(rows.filter(r => r.isDefault).map(r => r.id)).toEqual(['ceg2'])
  })
})

describe('parseProbeOutput', () => {
  // MEASURED, 2026-08-14: `python3 scripts/google-auth.py test lackor2` printed
  // exactly these four lines. Two details here are what naive parsing gets
  // wrong, and both are real: the line is PREFIXED with "[account] ", and the
  // address is FOLLOWED by " - 1117 uzenet".
  const OK = [
    '[lackor2] Gmail: lackor2@gmail.com - 1117 uzenet',
    'Calendar naptarak: 3',
    'Drive fajlok (minta): 3',
    'OK: mindharom API elerheto.',
  ].join('\n')

  it('reads the address and all three services from the real script output', () => {
    const r = parseProbeOutput(OK, '', 0)
    expect(r.ok).toBe(true)
    // Not "[lackor2]", and not "lackor2@gmail.com - 1117 uzenet".
    expect(r.email).toBe('lackor2@gmail.com')
    expect(r.services).toEqual({ gmail: true, calendar: true, drive: true })
    expect(r.error).toBeNull()
  })

  // The reason the result is per-service at all: with ten addresses, "one of
  // them is broken" tells the operator nothing they can act on.
  it('keeps the working half when one service is revoked', () => {
    const partial = '[munka] Gmail: valaki@gmail.com - 12 uzenet\nCalendar naptarak: 2\nHIBA: Drive: insufficient permissions'
    const r = parseProbeOutput(partial, '', 1)
    expect(r.services).toEqual({ gmail: true, calendar: true, drive: false })
    expect(r.email).toBe('valaki@gmail.com')
    expect(r.error).toBe('HIBA: Drive: insufficient permissions')
  })

  it('counts a zero-calendar account as a WORKING calendar connection', () => {
    // Reaching the API is the signal; an empty calendar list is not a failure.
    expect(parseProbeOutput('Gmail: a@b.hu\nCalendar naptarak: 0', '', 0).services.calendar).toBe(true)
    // Same for an empty Drive -- and the count in the parens is not a count of
    // anything the operator cares about either.
    expect(parseProbeOutput('Gmail: a@b.hu\nDrive fajlok (minta): 0', '', 0).services.drive).toBe(true)
  })

  it('is not fooled by a zero exit code with no Gmail line', () => {
    // Exit 0 alone must not be read as success: a script that printed nothing
    // has told us nothing.
    const r = parseProbeOutput('', '', 0)
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()
  })

  it('prefers the script HIBA line over the last line of a stack trace', () => {
    const messy = 'HIBA: a token lejart\nTraceback (most recent call last):\n  File "x.py"\nRuntimeError: boom'
    expect(parseProbeOutput(messy, '', 1).error).toBe('HIBA: a token lejart')
  })

  it('caps a giant error body instead of putting an HTTP response in the UI', () => {
    const r = parseProbeOutput('', 'HIBA: ' + 'x'.repeat(5000), 1)
    expect(r.error!.length).toBeLessThanOrEqual(300)
  })

  it('never throws on binary garbage', () => {
    expect(() => parseProbeOutput(' �', ' ', 1)).not.toThrow()
  })
  it('classifies the 7-day Testing-status token death as expired', () => {
    // An unverified app's refresh token stops working after a week and the API
    // answers invalid_grant. The row has to offer "sign in again", not print
    // this at the operator.
    const r = parseProbeOutput('', 'HIBA: refresh failed: ("invalid_grant", "Token has been expired or revoked.")', 1)
    expect(r.kind).toBe('expired')
  })

  it('leaves kind null when the probe worked', () => {
    expect(parseProbeOutput(OK, '', 0).kind).toBeNull()
  })

  it('classifies on the full text, not on the capped message', () => {
    // The marker can sit past the 300-character cut of the operator-facing
    // message; classifying the capped string would miss it.
    const r = parseProbeOutput('HIBA: ' + 'x'.repeat(600) + '\ninvalid_grant', '', 1)
    expect(r.error!.length).toBeLessThanOrEqual(300)
    expect(r.kind).toBe('expired')
  })
})

// Boss, 2026-08-14: "probaltam goggle fiokot hozzaadni de nem engedte a google
// [...] Hiba (403): access_denied [...] szoval ezen a folyamaton is vezesd
// vegig a usert hulyebiztosan!"
//
// The OAuth app is in "Testing" publishing status, where Google admits only the
// addresses on its test-user list. Nothing here can fix that and retrying never
// will -- so the ONE thing this classifier has to get right is telling that
// refusal apart from an ordinary failure, in both directions.
describe('classifyGoogleFailure', () => {
  // VERBATIM from what the operator saw and pasted. This is why the whole
  // walkthrough exists, so it is the first fixture.
  const REAL_HU = [
    'Hozzáférés letiltva: A(z) Marveen nem teljesítette a Google ellenőrzési folyamatát',
    'A(z) Marveen nem végezte el a Google ellenőrzési folyamatát. Az alkalmazás jelenleg tesztelés alatt áll,',
    'és csak a fejlesztő által jóváhagyott tesztelők számára hozzáférhető.',
    'Hiba (403): access_denied',
  ].join('\n')

  it('recognises the refusal the operator actually pasted', () => {
    expect(classifyGoogleFailure(REAL_HU)).toBe('test-user')
  })

  it('recognises it with the accents stripped', () => {
    // The console, some terminals, and a copy through a plain-text field all
    // deliver it without accents.
    const stripped = 'Hozzaferes letiltva: A(z) Marveen nem teljesitette a Google ellenorzesi folyamatat'
    expect(classifyGoogleFailure(stripped)).toBe('test-user')
  })

  it('recognises the English wording', () => {
    const en = 'Access blocked: Marveen has not completed the Google verification process\n'
      + 'The app is currently being tested, and can only be accessed by developer-approved testers.\n'
      + 'Error 403: access_denied'
    expect(classifyGoogleFailure(en)).toBe('test-user')
  })

  it('recognises the redirect URL form', () => {
    // What lands in the address bar when consent is refused or cancelled -- and
    // what step 3 of the flow tells the operator to paste.
    expect(classifyGoogleFailure('http://localhost:47921/?state=abc&error=access_denied')).toBe('test-user')
  })

  it('recognises the expired-token form', () => {
    expect(classifyGoogleFailure('invalid_grant: Token has been expired or revoked.')).toBe('expired')
    expect(classifyGoogleFailure('HIBA: a token lejart vagy visszavontak')).toBe('expired')
  })

  it('prefers the refusal over the expiry when both appear', () => {
    expect(classifyGoogleFailure('error=access_denied invalid_grant')).toBe('test-user')
  })

  // --- and it must NOT fire on anything else ---
  it('stays null on unrelated failures', () => {
    // A wrong guess sends a non-programmer into the Google Cloud Console to fix
    // a network outage, which is worse than saying nothing at all.
    expect(classifyGoogleFailure('')).toBeNull()
    expect(classifyGoogleFailure('HIBA: [Errno -3] Temporary failure in name resolution')).toBeNull()
    expect(classifyGoogleFailure('HIBA: nincs token ehhez a fiokhoz: munka')).toBeNull()
    expect(classifyGoogleFailure('Gmail: a@b.hu - 12 uzenet')).toBeNull()
    expect(classifyGoogleFailure(null as unknown as string)).toBeNull()
  })

  it('is not thrown off by a truncated message or by binary noise', () => {
    // The process can be killed mid-line, and half a marker is not a match.
    expect(classifyGoogleFailure('Hiba (403): access_den')).toBeNull()
    expect(() => classifyGoogleFailure(' � access_denied')).not.toThrow()
    expect(classifyGoogleFailure(' � access_denied')).toBe('test-user')
  })
})

describe('googleConsentScreenUrl', () => {
  it('links into the project the OAuth client belongs to', () => {
    expect(googleConsentScreenUrl('marveen-agent'))
      .toBe('https://console.cloud.google.com/auth/audience?project=marveen-agent')
  })

  // The id is read out of store/google-oauth-client.json, which also holds the
  // client secret. Only project_id is ever read -- and only when it LOOKS like
  // a project id, so a junk or hostile value cannot end up inside a link the
  // operator is being told to click.
  it('falls back to the plain console page rather than build a junk link', () => {
    const plain = 'https://console.cloud.google.com/auth/audience'
    expect(googleConsentScreenUrl(null)).toBe(plain)
    expect(googleConsentScreenUrl('')).toBe(plain)
    expect(googleConsentScreenUrl('Nagy-BETUS')).toBe(plain)
    expect(googleConsentScreenUrl('rov')).toBe(plain)
    expect(googleConsentScreenUrl('x'.repeat(40))).toBe(plain)
    expect(googleConsentScreenUrl('evil?foo=bar&x=1')).toBe(plain)
    expect(googleConsentScreenUrl('javascript:alert(1)')).toBe(plain)
  })

  it('accepts the shape this install really has', () => {
    // MEASURED, 2026-08-14: the project_id in store/google-oauth-client.json is
    // 14 characters and slug-shaped (the value itself is not repeated here).
    expect(isValidGoogleProjectId('abcdefgh-12345')).toBe(true)
    expect(isValidGoogleProjectId('a-')).toBe(false)
    expect(isValidGoogleProjectId('vege-')).toBe(false)
  })
})

describe('suggestAccountId', () => {
  it('derives a slug from an address', () => {
    expect(suggestAccountId('Munka.Fiok+cimke@gmail.com')).toBe('munka_fiok_cimke')
  })

  it('accepts a plain nickname', () => {
    expect(suggestAccountId('munka')).toBe('munka')
  })

  // Silently overwriting somebody's refresh token is the worst outcome this
  // feature could have, and with ten accounts a collision is a matter of time.
  it('suffixes rather than overwriting a taken id', () => {
    expect(suggestAccountId('munka', ['munka'])).toBe('munka_2')
    expect(suggestAccountId('munka', ['munka', 'munka_2'])).toBe('munka_3')
  })

  it('always produces a valid id, even from unusable input', () => {
    for (const input of ['', '   ', '@@@', '///', ' ', '@gmail.com']) {
      expect(isValidAccountId(suggestAccountId(input))).toBe(true)
    }
  })

  it('caps a very long address', () => {
    const id = suggestAccountId('a'.repeat(200) + '@gmail.com')
    expect(id.length).toBeLessThanOrEqual(40)
    expect(isValidAccountId(id)).toBe(true)
  })
})

describe('isValidAccountId', () => {
  it('accepts slugs and refuses everything that could escape an argument', () => {
    expect(isValidAccountId('lackor2')).toBe(true)
    expect(isValidAccountId('a_b_9')).toBe(true)
    for (const bad of ['', 'A', 'a-b', '../x', 'a b', 'a;b', '-flag', 'x'.repeat(41)]) {
      expect(isValidAccountId(bad)).toBe(false)
    }
  })
})

describe('extractConsentUrl', () => {
  it('finds the consent link in the middle of the script chatter', () => {
    const out = [
      'Nyisd meg ezt a linket:',
      'https://accounts.google.com/o/oauth2/auth?client_id=x&state=abc',
      'Varakozas a jovahagyasra...',
    ].join('\n')
    expect(extractConsentUrl(out)).toBe('https://accounts.google.com/o/oauth2/auth?client_id=x&state=abc')
  })

  it('ignores other https links so the page cannot send the operator elsewhere', () => {
    expect(extractConsentUrl('see https://example.com/help for details')).toBeNull()
  })

  it('returns null instead of half a URL when there is none', () => {
    expect(extractConsentUrl('')).toBeNull()
    expect(extractConsentUrl('accounts.google.com/o/oauth2/auth')).toBeNull()
  })
})

describe('isUsablePaste', () => {
  it('accepts the whole redirect URL from the address bar', () => {
    expect(isUsablePaste('http://localhost:47921/?state=abc&code=4/0AVG7fiQ...')).toBe(true)
  })

  it('accepts a bare authorization code', () => {
    expect(isUsablePaste('4/0AVG7fiQabcdefghijklmnop')).toBe(true)
  })

  it('refuses what would break a process argument or is plainly not a code', () => {
    for (const bad of ['', '   ', 'nem tudom', 'code', 'x'.repeat(2001), 'a b', 'kod x']) {
      expect(isUsablePaste(bad)).toBe(false)
    }
  })

  it('refuses a multi-line paste (a whole page copied by accident)', () => {
    expect(isUsablePaste('http://localhost/?code=abc\nsomething else')).toBe(false)
  })
})

// Where the token ACTUALLY landed. google-auth.py refuses to overwrite a slot
// that belongs to a different address (a mistyped account name, or the wrong
// row in the Google account chooser) and saves a new account instead -- so the
// key it prints is the only reliable answer to "which account is this now".
describe('parseSavedAccountId', () => {
  it('reads the key out of the script\'s OK line', () => {
    expect(parseSavedAccountId("OK: token mentve -> /home/boss/marveen/store/google-tokens.json (fiok='munka')"))
      .toBe('munka')
  })

  it('reads the key the script chose when it refused to overwrite', () => {
    const out = [
      "(figyelem: a(z) 'munka' fiok cime regi@gmail.com, most viszont uj@gmail.com jelentkezett be",
      " -- nem irtam felul, uj fiokkent mentem: 'uj_2')",
      "OK: token mentve -> store/google-tokens.json (fiok='uj_2')",
    ].join('\n')
    expect(parseSavedAccountId(out)).toBe('uj_2')
  })

  it('finds it anywhere in a longer transcript', () => {
    expect(parseSavedAccountId('elso sor\nmasodik\nOK: token mentve (fiok=\'lackor2\')\nvege')).toBe('lackor2')
  })

  it('is null when the script did not say -- never a guess', () => {
    expect(parseSavedAccountId('')).toBeNull()
    expect(parseSavedAccountId(null as unknown as string)).toBeNull()
    expect(parseSavedAccountId('HIBA: nem jott refresh_token.')).toBeNull()
    expect(parseSavedAccountId('OK: token mentve')).toBeNull()
  })

  it('rejects anything that is not a legal account key', () => {
    // The value is fed back into the UI and into script arguments; a key that
    // isValidAccountId would reject must not survive the parse.
    expect(parseSavedAccountId("(fiok='rossz kulcs')")).toBeNull()
    expect(parseSavedAccountId("(fiok='Nagy')")).toBeNull()
    expect(parseSavedAccountId("(fiok='../../etc/passwd')")).toBeNull()
    expect(parseSavedAccountId("(fiok='')")).toBeNull()
    expect(parseSavedAccountId(`(fiok='${'a'.repeat(41)}')`)).toBeNull()
  })

  it('every key it does return is safe to hand back to the script', () => {
    for (const raw of ['munka', 'uj_2', 'lackor2', 'a'.repeat(40)]) {
      const parsed = parseSavedAccountId(`OK: token mentve (fiok='${raw}')`)
      expect(parsed).toBe(raw)
      expect(isValidAccountId(parsed!)).toBe(true)
    }
  })
})
