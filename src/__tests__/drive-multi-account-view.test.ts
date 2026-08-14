// Drive "Osszes fiok" (all accounts) column view -- Boss 2026-08-14:
// "az oldalt mondjuk harmadolom, egyik harmadban a Lackor 2, a masikban USA
// Lackor, a harmadikban Freebell es Cheaper".
//
// Two things can go wrong here and both are silent:
//
//   1. A row action reading the page-wide `_driveAccount` / `_driveFolderStack`
//      instead of its own column's. With three columns open that renames or
//      TRASHES a file in whichever Drive the dropdown happened to point at --
//      the user sees the right file name in the confirm dialog and the wrong
//      Drive loses the file.
//   2. One expired token taking the whole page down. With ten addresses
//      connected, "one bad account kills the page" is the likeliest failure,
//      so a column's error must stay inside that column.
//
// House idiom: read web/app.js as a string, and where a helper is pure, pull it
// out of the source and run the REAL shipped code (see
// messages-view-display-name.test.ts).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WEB = join(__dirname, '..', '..', 'web')
const src = readFileSync(join(WEB, 'app.js'), 'utf8')
const html = readFileSync(join(WEB, 'index.html'), 'utf8')
const css = readFileSync(join(WEB, 'style.css'), 'utf8')
const hu = readFileSync(join(WEB, 'lang', 'hu.js'), 'utf8')
const en = readFileSync(join(WEB, 'lang', 'en.js'), 'utf8')

/** Brace-match a top-level `[async ]function name(...) {...}` out of app.js. */
function extractFn(name: string): string {
  const re = new RegExp(`(async\\s+)?function ${name}\\s*\\([^)]*\\)\\s*\\{`)
  const m = re.exec(src)
  if (!m) throw new Error(`${name}() missing from web/app.js`)
  let depth = 0
  for (let j = src.indexOf('{', m.index); j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}' && --depth === 0) return src.slice(m.index, j + 1)
  }
  throw new Error(`${name}() is unbalanced in web/app.js`)
}

describe('_drivePool: bounded parallelism across columns', () => {
  // Ten columns firing ten fetches means ten python token calls on the server
  // at once -- not faster, just heavier. The cap is only worth having if it
  // actually holds and if nothing is dropped on the floor.
  function pool() {
    const body = `${extractFn('_drivePool')}\nreturn _drivePool`
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    return new Function(body)() as (
      items: unknown[], limit: number, worker: (x: unknown) => Promise<void>
    ) => Promise<void>
  }

  it('runs every item exactly once and never exceeds the limit', async () => {
    const items = Array.from({ length: 10 }, (_, i) => `fiok${i}`)
    const seen: string[] = []
    let live = 0
    let peak = 0
    await pool()(items, 4, async (a) => {
      live++
      peak = Math.max(peak, live)
      await new Promise((r) => setTimeout(r, 5))
      seen.push(a as string)
      live--
    })
    expect(seen.sort()).toEqual([...items].sort())
    expect(peak).toBeLessThanOrEqual(4)
    expect(peak).toBe(4) // and it does use the budget -- not accidentally serial
  })

  it('resolves on an empty list instead of hanging the render', async () => {
    // Every account hidden by the chips is a real state; a pool that never
    // settles would leave the page mid-render forever.
    let called = false
    await pool()([], 4, async () => { called = true })
    expect(called).toBe(false)
  })

  it('with fewer items than the limit it still finishes', async () => {
    const done: unknown[] = []
    await pool()(['a', 'b'], 4, async (x) => { done.push(x) })
    expect(done.sort()).toEqual(['a', 'b'])
  })
})

describe('every column keeps its OWN folder stack', () => {
  it('walking into a folder in one column leaves the others at their own place', () => {
    const body = `
      const _driveStacks = {}
      function t() { return 'Drive' }
      ${extractFn('_driveStack')}
      return { _driveStack, _driveStacks }
    `
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const m = new Function(body)() as {
      _driveStack: (a: string) => Array<{ id: string }>
      _driveStacks: Record<string, Array<{ id: string }>>
    }
    m._driveStack('lackor2').push({ id: 'szamlak' })
    expect(m._driveStack('lackor2').map((f) => f.id)).toEqual(['root', 'szamlak'])
    // The whole point of the column view: usalackor is still at its root.
    expect(m._driveStack('usalackor').map((f) => f.id)).toEqual(['root'])
  })
})

describe('row actions act on their own column, not on the dropdown', () => {
  const bind = extractFn('bindDriveRowActions')

  it('takes the account and stack as arguments', () => {
    expect(/function bindDriveRowActions\(list, account, stack, reload\)/.test(src)).toBe(true)
  })

  it('never reaches for the page-wide globals inside the body', () => {
    // This is the wrong-Drive bug in one assertion.
    expect(bind).not.toMatch(/_driveAccount\b/)
    expect(bind).not.toMatch(/_driveFolderStack\b/)
    expect(bind).not.toMatch(/currentDriveFolder\(/)
  })

  it('sends that account on every mutating call', () => {
    for (const ep of ['rename', 'move', 'trash']) {
      const call = new RegExp(`/api/drive/${ep}'[\\s\\S]{0,300}?account`).test(bind)
      expect(call, `${ep} must carry the column's account`).toBe(true)
    }
  })

  it('names the account in the trash confirmation', () => {
    // "Toroljem a szerzodes.pdf-et?" is not enough information to say yes to
    // when three Drives are on screen.
    expect(bind).toMatch(/drive\.confirm\.trash_account['"],\s*\{\s*name,\s*account\s*\}/)
  })

  it('is used by BOTH views, so the single-account page cannot drift apart', () => {
    expect(src).toMatch(/bindDriveRowActions\(list, _driveAccount, _driveFolderStack, loadDriveFolder\)/)
    expect(src).toMatch(/bindDriveRowActions\(list, account, stack, \(\) => loadDriveColumn\(account\)\)/)
  })
})

describe('one broken account does not break the page', () => {
  const load = extractFn('loadDriveColumn')

  it('a column failure is rendered inside that column', () => {
    expect(load).toMatch(/drive-col-error/)
    // renderDriveError() writes the page-wide banner and would blame the whole
    // Drive page for one expired token.
    expect(load).not.toMatch(/renderDriveError\(/)
  })

  it('the column list is fetched for its own account', () => {
    expect(load).toMatch(/account=\$\{encodeURIComponent\(account\)\}/)
  })

  it('an empty folder says so instead of looking like a load failure', () => {
    expect(load).toMatch(/drive-col-empty/)
  })
})

describe('which columns are visible', () => {
  it('the last visible account cannot be switched off', () => {
    // An empty page is not an answer to "where is this file".
    expect(src).toMatch(/_driveShownAccounts\(\)\.length === 0.*_driveHidden\.delete\(acc\)/s)
  })

  it('the choice survives a reload, per browser', () => {
    expect(src).toMatch(/const DRIVE_LS_MODE = 'marveen\.drive\.allmode'/)
    expect(src).toMatch(/const DRIVE_LS_HIDDEN = 'marveen\.drive\.hidden'/)
    expect(src).toMatch(/localStorage\.getItem\(DRIVE_LS_MODE\) === '1'/)
  })

  it('a disconnected account cannot stay hidden forever, nor hide everything', () => {
    expect(src).toMatch(/_driveHidden = new Set\(\[\.\.\._driveHidden\]\.filter\(a => accounts\.includes\(a\)\)\)/)
    expect(src).toMatch(/accounts\.length && _driveShownAccounts\(\)\.length === 0.*_driveHidden = new Set\(\)/)
  })

  it('switching back to one account rebuilds the page, not just the file list', () => {
    // The all-accounts view returns from loadDrivePage() early, so the account
    // dropdown is still empty and _driveAccount is ''. If the page opened in
    // column mode (the choice is remembered), calling loadDriveFolder() here
    // would fetch with account= and show a load error instead of the Drive.
    const toggle = /getElementById\('driveAllToggle'\)\?\.addEventListener\('click',[\s\S]*?\n\}\)/.exec(src)
    expect(toggle, 'the driveAllToggle click handler').toBeTruthy()
    expect(toggle![0]).toMatch(/else loadDrivePage\(\)/)
    expect(toggle![0]).not.toMatch(/else loadDriveFolder\(\)/)
  })

  it('the toggle is hidden with a single account -- and CSS lets it be hidden', () => {
    expect(src).toMatch(/toggle\.hidden = accounts\.length < 2/)
    expect(src).toMatch(/if \(accounts\.length < 2\) _driveAllMode = false/)
    // hidden-attribute-css-contract.test.ts only scans the MARKUP for `hidden`;
    // this button gets it from JS, so the [hidden] override needs its own guard.
    expect(html).toMatch(/id="driveAllToggle"/)
    expect(html).toMatch(/id="driveAllToggle"[^>]*class="[^"]*btn-compact|class="[^"]*btn-compact[^"]*"[^>]*id="driveAllToggle"/)
    expect(css).toMatch(/\.btn-compact\[hidden\]\s*\{[^}]*display:\s*none/)
  })
})

describe('the markup the column view needs', () => {
  it('ships the containers hidden, with the CSS that makes `hidden` real', () => {
    expect(html).toMatch(/<div class="drive-multi" id="driveMulti" hidden>/)
    expect(html).toMatch(/<div class="drive-multi-bar" id="driveMultiBar" hidden>/)
    expect(css).toMatch(/\.drive-multi\[hidden\]\s*\{[^}]*display:\s*none/)
    expect(css).toMatch(/\.drive-multi-bar\[hidden\]\s*\{[^}]*display:\s*none/)
  })

  it('columns are a responsive grid, not a fixed third', () => {
    // "harmadolom" is three accounts; ten must not produce 10 unreadable slivers.
    expect(css).toMatch(/\.drive-multi\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(/)
  })

  it('one shared file input carries the target account', () => {
    expect(html).toMatch(/id="driveMultiUploadInput"/)
    expect(src).toMatch(/input\.dataset\.account = account/)
    expect(src).toMatch(/const account = ev\.target\.dataset\.account/)
    // Without this a second upload would reuse the previous column's account.
    expect(src).toMatch(/ev\.target\.value = ''/)
  })
})

describe('translations', () => {
  const keys = ['drive.all_accounts_btn', 'drive.single_account_btn', 'drive.columns_label', 'drive.refresh_btn', 'drive.confirm.trash_account']

  it('both languages define every new key', () => {
    for (const k of keys) {
      expect(hu.includes(`'${k}'`), `hu.js: ${k}`).toBe(true)
      expect(en.includes(`'${k}'`), `en.js: ${k}`).toBe(true)
    }
  })

  it('the trash question names both the file and the account in both languages', () => {
    for (const [name, lang] of [['hu', hu], ['en', en]] as const) {
      const line = lang.split('\n').find((l) => l.includes("'drive.confirm.trash_account'")) || ''
      expect(line.includes('{name}'), `${name}: {name}`).toBe(true)
      expect(line.includes('{account}'), `${name}: {account}`).toBe(true)
    }
  })

  it('the old account-less trash question is gone everywhere', () => {
    // Left behind it would be a dead key in both dictionaries and an invitation
    // to call it again.
    expect(hu).not.toMatch(/'drive\.confirm\.trash'/)
    expect(en).not.toMatch(/'drive\.confirm\.trash'/)
    expect(src).not.toMatch(/'drive\.confirm\.trash'/)
  })
})
