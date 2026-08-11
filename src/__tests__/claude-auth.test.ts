import { describe, it, expect } from 'vitest'
import {
  extractAuthUrl,
  readLoginPane,
  parseAuthStatus,
  isLoginComplete,
  planIdFromLabel,
  buildPlanEntry,
  UNKNOWN_IDENTITY,
} from '../claude-auth.js'

// The fixture is the REAL output, captured from `claude auth login --claudeai`
// under a PTY with an isolated CLAUDE_CONFIG_DIR (2026-08-12). Keeping the true
// shape -- OSC-8 hyperlink, the URL repeated as target and label, the paste
// prompt -- is the whole value of these tests: a hand-written approximation
// would not have caught the duplication.
const URL_ONE =
  'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e' +
  '&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback' +
  '&scope=org%3Acreate_api_key+user%3Aprofile&code_challenge=0tXlEJ2-B_9au3khE-8tqKr3cB5iPOtaq_2khLAwz4I' +
  '&code_challenge_method=S256&state=YYY0HShCCd-CJo7NW6j6qKZy6Id2XV-RyE6uJk6XLk8'

const REAL_PANE =
  'Opening browser to sign in…\r\n' +
  'If the browser didn\'t open, visit: ' +
  `]8;;${URL_ONE}${URL_ONE}]8;;` +
  '\r\nPaste code here if prompted > '

describe('extractAuthUrl', () => {
  it('returns ONE url from a pane that carries it twice (hyperlink + label)', () => {
    const url = extractAuthUrl(REAL_PANE)
    expect(url).toBe(URL_ONE)
    // The bug this guards: naive matching concatenates both copies.
    expect(url!.indexOf('https://', 1)).toBe(-1)
  })

  it('still finds the url when the terminal dropped the hyperlink escape', () => {
    const plain = `If the browser didn't open, visit: ${URL_ONE}\nPaste code here if prompted > `
    expect(extractAuthUrl(plain)).toBe(URL_ONE)
  })

  it('is null before the url has rendered', () => {
    expect(extractAuthUrl('Opening browser to sign in…')).toBeNull()
  })
})

describe('readLoginPane', () => {
  it('reports awaiting-code once the url and the prompt are both up', () => {
    const s = readLoginPane(REAL_PANE, false)
    expect(s.phase).toBe('awaiting-code')
    expect(s.url).toBe(URL_ONE)
  })

  it('reports working after the code went in, even though the prompt is still on screen', () => {
    // The pane does not change when the code is submitted -- only the runner
    // knows, which is why codeSubmitted is an argument and not a text match.
    expect(readLoginPane(REAL_PANE, true).phase).toBe('working')
  })

  it('reports starting before anything recognisable appears', () => {
    expect(readLoginPane('Opening browser to sign in…', false).phase).toBe('starting')
  })

  it('surfaces an error line from the pane', () => {
    const s = readLoginPane(REAL_PANE + '\r\nError: invalid code\r\n', false)
    expect(s.phase).toBe('failed')
    expect(s.error).toMatch(/invalid code/i)
  })
})

describe('parseAuthStatus', () => {
  it('parses the real status payload', () => {
    const id = parseAuthStatus(JSON.stringify({
      loggedIn: true, authMethod: 'claude.ai', email: 'a@b.hu',
      orgName: "a@b.hu's Organization", subscriptionType: 'pro',
    }))
    expect(id.loggedIn).toBe(true)
    expect(id.email).toBe('a@b.hu')
    expect(id.subscriptionType).toBe('pro')
  })

  it('treats junk as logged-out instead of throwing', () => {
    expect(parseAuthStatus('not json')).toEqual(UNKNOWN_IDENTITY)
    expect(parseAuthStatus('null')).toEqual(UNKNOWN_IDENTITY)
  })
})

describe('isLoginComplete', () => {
  const acct = (email: string | null, loggedIn = true) => ({ ...UNKNOWN_IDENTITY, loggedIn, email })

  it('is true once the fresh directory reports an account', () => {
    expect(isLoginComplete(acct('new@x.hu'))).toBe(true)
  })

  it('is false while the directory is still empty', () => {
    expect(isLoginComplete(acct(null, false))).toBe(false)
  })

  it('is false for a logged-in flag with no account behind it', () => {
    expect(isLoginComplete(acct(null, true))).toBe(false)
  })
})

describe('planIdFromLabel', () => {
  it('turns a human label into a registry-safe id', () => {
    expect(planIdFromLabel('Munkahelyi fiok')).toBe('munkahelyi-fiok')
  })

  it('strips accents rather than dropping the whole word', () => {
    // "Munkahelyi fiók" must not become "munkahelyi-fi-k".
    expect(planIdFromLabel('Céges fiók')).toBe('ceges-fiok')
  })

  it('never collides with an id already in the registry', () => {
    expect(planIdFromLabel('Lackor3', ['lackor3'])).toBe('lackor3-2')
    expect(planIdFromLabel('Lackor3', ['lackor3', 'lackor3-2'])).toBe('lackor3-3')
  })

  it('falls back to something usable for a label with nothing safe in it', () => {
    expect(planIdFromLabel('###')).toBe('fiok')
  })
})

describe('buildPlanEntry', () => {
  it('defaults to personal and channels-OFF', () => {
    // A team seat that quietly starts answering Telegram is the mistake this
    // conservative default avoids; the operator can widen it afterwards.
    const e = buildPlanEntry('ceges', 'Ceges', '/x/ceges')
    expect(e.planType).toBe('personal')
    expect(e.channelsAllowed).toBe(false)
    expect(e.id).toBe('ceges')
  })

  it('falls back to the id when the label is blank', () => {
    expect(buildPlanEntry('ceges', '   ', '/x/ceges').label).toBe('ceges')
  })
})
