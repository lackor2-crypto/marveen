import { describe, expect, it } from 'vitest'
import { extractAuthUrl } from '../web/auth-url-extract.js'

// A fixture alakja az ELO panelrol van merve (agent-lackor3, 2026-08-29):
// a Claude Code kiirja a "Browser didn't open?" sort, majd a panel
// szelessegere tordelve az URL-t.
const REAL_URL =
  'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e'
  + '&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback'
  + '&scope=org%3Acreate_api_key+user%3Aprofile&code_challenge=abc123&code_challenge_method=S256'
  + '&state=xyz789'

function wrap(url: string, width: number): string {
  const out: string[] = []
  for (let i = 0; i < url.length; i += width) out.push(url.slice(i, i + width))
  return out.join('\n')
}

const LOGIN_PANE = [
  '',
  '   Login',
  '',
  "   Browser didn't open? Use the url below to sign in (c to copy)",
  '',
  wrap(REAL_URL, 80),
  '',
  '   Paste code here if prompted >',
  '',
].join('\n')

describe('extractAuthUrl', () => {
  it('a tordelt URL-t egyben adja vissza (a csonka URL rosszabb a semminel)', () => {
    const got = extractAuthUrl(LOGIN_PANE)
    expect(got).not.toBeNull()
    expect(got!.url).toBe(REAL_URL)
    // Bizonyitek, hogy tenyleg tobb sorbol allt ossze -- kulonben a teszt
    // akkor is atmenne, ha a tordelest sosem gyakoroltuk volna.
    expect(got!.lineCount).toBeGreaterThan(1)
    // A csonkolas leggyakoribb aldozata a lezaro parameter.
    expect(got!.url).toContain('state=xyz789')
    expect(got!.url).toContain('code_challenge=')
  })

  it('NEM domainre illeszt: egy jovobeli gazdagepen is megtalalja', () => {
    // Ez a regi hiba lenyege volt: harom konkret domain (console.anthropic.com,
    // auth.anthropic.com, claude.ai) -- a szolgaltato atallt claude.com-ra, es
    // a felulet nemán semmit nem mutatott.
    const pane = "   Browser didn't open? Use the url below to sign in\n"
      + 'https://valami-uj-domain.example/oauth/authorize?client_id=1&state=2\n'
    expect(extractAuthUrl(pane)!.url)
      .toBe('https://valami-uj-domain.example/oauth/authorize?client_id=1&state=2')
  })

  it('a scrollbackben feljebb allo REGI URL-t nem szedi fel', () => {
    const pane = [
      '   https://claude.com/cai/oauth/authorize?client_id=REGI&state=REGI',
      '   ... kesobbi munka ...',
      "   Browser didn't open? Use the url below to sign in (c to copy)",
      'https://claude.com/cai/oauth/authorize?client_id=UJ&state=UJ',
      '',
    ].join('\n')
    const got = extractAuthUrl(pane)!
    expect(got.url).toContain('UJ')
    expect(got.url).not.toContain('REGI')
  })

  it('a behuzott / szokozos kovetkezo sort nem ragasztja az URL vegere', () => {
    const pane = [
      "   Browser didn't open? Use the url below to sign in",
      'https://claude.com/cai/oauth/authorize?client_id=1',
      '   Paste code here if prompted >',
    ].join('\n')
    expect(extractAuthUrl(pane)!.url)
      .toBe('https://claude.com/cai/oauth/authorize?client_id=1')
  })

  it('URL nelkuli panelre null -- nem talal ki semmit', () => {
    const pane = '   Welcome back\n   > \n'
    expect(extractAuthUrl(pane)).toBeNull()
  })

  it('ures / hianyzo panelre null (nem dob)', () => {
    expect(extractAuthUrl('')).toBeNull()
    expect(extractAuthUrl(null)).toBeNull()
    expect(extractAuthUrl(undefined)).toBeNull()
  })
})
