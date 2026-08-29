// The Accounts page as ONE panel, one card per account.
//
// Boss, 2026-08-14: "A fiokok alatt, gyakorlatilag van 3 panel es mind a 3
// ugyanazt mutatja. nem ertem hogy az elsoben felsorolod a gmail fiokokat es a
// masodikban is. es a harmadikban pedig szinten [...] nem lehetne ezeket egy
// panelre tenni? mindennel egyutt? levalasztas ellenorzes stb egy panal egy
// helyen mutatna? kell ez hogy szetszorni sok fele?"
//
// The three panels knew three DIFFERENT things about the same address (is it
// signed in / does its mail-Drive-calendar work / are its Claude Code connectors
// authorized), which is why they existed -- but the operator had to hold all
// three lists in their head to see that it is ONE account. Now three payloads
// flow into _accHubMerge() and one card per identity comes out.
//
// What is guarded here is what breaks SILENTLY in that merge:
//   - an account quietly disappearing (merged onto the wrong card, or dropped
//     because its key was empty) -- the merge is checked for record invariance,
//     not just for the happy path;
//   - the buttons losing their delegation root or their data-id, which turns a
//     working page into a page where nothing happens on click;
//   - the connector flow losing the card it reads the account name from.
//
// web/app.js is a classic script with no module boundary, so the pure helper is
// brace-matched out of the source and evaluated (the idiom from
// messages-view-display-name.test.ts).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WEB = join(__dirname, '..', '..', 'web')
const app = readFileSync(join(WEB, 'app.js'), 'utf8')
const html = readFileSync(join(WEB, 'index.html'), 'utf8')
const css = readFileSync(join(WEB, 'style.css'), 'utf8')

function extractFn(src: string, name: string): string {
  const start = src.search(new RegExp(`(?:async )?function ${name}\\(`))
  if (start < 0) throw new Error(`${name}() not found in web/app.js`)
  let depth = 0
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1)
  }
  throw new Error(`${name}() is not brace-balanced`)
}

interface Card {
  key: string
  title: string
  email: string
  isDefault: boolean
  claude: { id: string }[]
  google: { id: string }[]
  mcp: { accountId: string | null }[]
}
type Merge = (c: unknown[], g: unknown[], m: unknown[]) => Card[]

const merge = new Function(
  `${extractFn(app, '_hubEmailKey')}\n${extractFn(app, '_accHubMerge')}\nreturn _accHubMerge`,
)() as Merge

const gAcct = (id: string, over: Record<string, unknown> = {}) => ({
  id, email: null, isDefault: false, services: {}, checkedAt: null, error: null, kind: null, ...over,
})
const cAcct = (id: string, over: Record<string, unknown> = {}) => ({
  id, label: id, isDefault: false, identity: { loggedIn: false, email: null }, ...over,
})
const mAcct = (accountId: string | null, over: Record<string, unknown> = {}) => ({
  accountId, label: null, agents: [], servers: [], error: null, ...over,
})

describe('_accHubMerge: one card per identity', () => {
  it('the same address from all three sources lands on ONE card', () => {
    // This IS the report: three panels, one account.
    const cards = merge(
      [cAcct('lackor2', { isDefault: true, identity: { loggedIn: true, email: 'Boss@Gmail.com ' } })],
      [gAcct('boss', { email: 'boss@gmail.com', isDefault: true })],
      [mAcct(null)],
    )
    expect(cards).toHaveLength(1)
    expect(cards[0].claude).toHaveLength(1)
    expect(cards[0].google).toHaveLength(1)
    expect(cards[0].mcp).toHaveLength(1)
    // Case and stray whitespace are how the same address arrives from two
    // different APIs -- matching on the raw string would split the card in two.
    expect(cards[0].email.toLowerCase()).toBe('boss@gmail.com')
  })

  it('ten addresses stay ten cards', () => {
    // "lehet hogy 10 email lesz csatlakoztatva. mindegyiknek kellene hogy
    // mukodjon." -- merging is by address, so ten addresses must not fold.
    const ten = Array.from({ length: 10 }, (_, i) => gAcct(`a${i}`, { email: `a${i}@gmail.com` }))
    expect(merge([], ten, [])).toHaveLength(10)
  })

  it('accounts with no address yet do not collapse onto one card', () => {
    // An account nobody has checked has email === null. Keyed on the empty
    // string, all of them would become a single card and nine addresses would
    // vanish from the page.
    const cards = merge(
      [cAcct('c1'), cAcct('c2')],
      [gAcct('munka'), gAcct('otthon')],
      [],
    )
    expect(cards).toHaveLength(4)
    expect(new Set(cards.map(c => c.key)).size).toBe(4)
  })

  it('a kijelentkezett fiok NEM koltozik at egy sajat kartyara', () => {
    // Boss, 2026-08-29 (kepernyokeppel): kijelentkezes utan az "Usalackor" es
    // "Lackor3" kulon kartyakent jelent meg a lap aljan, a sajat
    // "Bejelentkezes" gombjaval -- kozben a Google-kartyajuk ugyanarrol a
    // fiokrol fentebb allt. "minek ezeket itt lentebb is ujra odatenni? igy
    // atlathatatlan az egesz."
    //
    // Ok: az e-mail cimet csak a BEJELENTKEZETT fioktol tudjuk, tehat a
    // kartya kulcsa a bejelentkezes allapotatol fuggott. Ugyanaz a fiok, ket
    // helyen, aszerint hogy epp be van-e lepve.
    const loggedIn = merge(
      [cAcct('usalackor', { identity: { loggedIn: true, email: 'usalackor@gmail.com' } })],
      [gAcct('usalackor', { email: 'usalackor@gmail.com' })],
      [],
    )
    expect(loggedIn).toHaveLength(1)

    // Ugyanaz a fiok kijelentkezve: nincs e-mail, de a NEVE ugyanaz.
    const loggedOut = merge(
      [cAcct('usalackor')],
      [gAcct('usalackor', { email: 'usalackor@gmail.com' })],
      [],
    )
    expect(loggedOut).toHaveLength(1)
    expect(loggedOut[0].email.toLowerCase()).toBe('usalackor@gmail.com')
    expect(loggedOut[0].claude).toHaveLength(1)
    expect(loggedOut[0].google).toHaveLength(1)
  })

  it('a nev-egyezes PONTOS: idegen nevu fiok nem olvad ossze', () => {
    // A visszaesés a masik iranyba is hiba volna: ket kulon fiok egy kartyan.
    // A "nem talalom" nem ugyanaz, mint a "biztosan ugyanaz".
    const cards = merge(
      [cAcct('valaki-mas')],
      [gAcct('usalackor', { email: 'usalackor@gmail.com' })],
      [],
    )
    expect(cards).toHaveLength(2)
  })

  it('connectors land on the Claude account they belong to', () => {
    const cards = merge(
      [
        cAcct('lackor2', { isDefault: true, identity: { loggedIn: true, email: 'boss@gmail.com' } }),
        cAcct('lackor3', { identity: { loggedIn: true, email: 'north@gmail.com' } }),
      ],
      [],
      [mAcct('lackor3', { servers: [{ name: 'drive', status: 'connected' }] })],
    )
    const north = cards.find(c => c.email === 'north@gmail.com')!
    expect(north.mcp).toHaveLength(1)
    expect(cards.find(c => c.email === 'boss@gmail.com')!.mcp).toHaveLength(0)
  })

  it('the account-less connector set goes to the DEFAULT Claude account', () => {
    // accountId === null means "the default config directory" -- with no owner
    // it would draw a nameless card next to the real one.
    const cards = merge(
      [
        cAcct('lackor3', { identity: { loggedIn: true, email: 'north@gmail.com' } }),
        cAcct('lackor2', { isDefault: true, identity: { loggedIn: true, email: 'boss@gmail.com' } }),
      ],
      [],
      [mAcct(null)],
    )
    expect(cards).toHaveLength(2)
    expect(cards.find(c => c.email === 'boss@gmail.com')!.mcp).toHaveLength(1)
  })

  it('a connector set nobody claims still gets a card of its own', () => {
    // Losing it silently would mean a broken connector nobody can see, let
    // alone fix.
    const cards = merge([], [], [mAcct(null), mAcct('ghost', { label: 'ghost' })])
    expect(cards).toHaveLength(2)
    expect(cards.flatMap(c => c.mcp)).toHaveLength(2)
  })

  it('the default account is drawn first', () => {
    const cards = merge(
      [],
      [gAcct('a', { email: 'a@gmail.com' }), gAcct('b', { email: 'b@gmail.com', isDefault: true })],
      [],
    )
    expect(cards[0].email).toBe('b@gmail.com')
  })

  it('every input record comes out exactly once (nothing dropped, nothing doubled)', () => {
    // The invariance check: a merge is only correct if the set of records is
    // preserved. Counting cards would pass while an account silently vanished.
    const claude = [
      cAcct('lackor2', { isDefault: true, identity: { loggedIn: true, email: 'boss@gmail.com' } }),
      cAcct('lackor3', { identity: { loggedIn: true, email: 'north@gmail.com' } }),
      cAcct('nameless'),
    ]
    const google = [
      gAcct('boss', { email: 'boss@gmail.com' }),
      gAcct('munka', { email: 'munka@ceg.hu' }),
      gAcct('unchecked'),
    ]
    const mcp = [mAcct(null), mAcct('lackor3'), mAcct('ghost')]
    const cards = merge(claude, google, mcp)
    expect(cards.flatMap(c => c.claude).map(a => a.id).sort()).toEqual(['lackor2', 'lackor3', 'nameless'])
    expect(cards.flatMap(c => c.google).map(a => a.id).sort()).toEqual(['boss', 'munka', 'unchecked'])
    expect(cards.flatMap(c => c.mcp).map(a => a.accountId).sort()).toEqual([null, 'ghost', 'lackor3'].sort())
    // boss@gmail.com carries all three; nothing else does.
    const boss = cards.find(c => c.email === 'boss@gmail.com')!
    expect([boss.claude.length, boss.google.length, boss.mcp.length]).toEqual([1, 1, 1])
  })

  it('survives empty and missing lists', () => {
    expect(merge([], [], [])).toEqual([])
    expect((merge as unknown as () => Card[])()).toEqual([])
  })
})

describe('the page is one panel', () => {
  const page = html.slice(html.indexOf('id="accountsPage"'), html.indexOf('id="vaultPage"'))

  it('there is exactly ONE accounts-section left', () => {
    // The whole point of the report: three panels became one.
    expect(page.match(/class="accounts-section"/g) || []).toHaveLength(1)
    expect(page).toContain('id="accountsHubSection"')
  })

  it('the three old lists are gone from the markup AND from the code', () => {
    for (const id of ['gconnList', 'mconnList', 'claudeAuthList']) {
      expect(html.includes(`id="${id}"`), `index.html still has #${id}`).toBe(false)
      expect(app.includes(id), `app.js still writes to #${id}`).toBe(false)
    }
  })

  it('the page\'s own two old lists are gone too, with their row builder', () => {
    // These were the "core" and "optional" lists at the top of the page: they
    // named the same services the panel below names, so they were emptied and
    // then removed outright. Their builder went with them, or it is dead code
    // that will quietly grow a second list back.
    for (const id of ['accountsCoreList', 'accountsOptionalList']) {
      expect(html.includes(`id="${id}"`), `index.html still has #${id}`).toBe(false)
      expect(app.includes(id), `app.js still writes to #${id}`).toBe(false)
    }
    // Named in a comment is fine (that is the archaeology); defined or called
    // is not -- that is dead code that can grow a second list back.
    expect(app, 'the retired row builder is defined again').not.toMatch(/function\s+_renderAccountItem\b/)
    expect(app, 'the retired row builder is called again').not.toMatch(/_renderAccountItem\s*\(/)
    // Again: the name may appear in a comment, but not as a live selector.
    expect(css, 'style rule for rows nobody emits').not.toMatch(/\.accounts-(item-clickable|list)\s*[,:{[]/)
  })

  it('the page loader only fetches and asks the panel to draw', () => {
    const fn = extractFn(app, 'loadAccountsPage')
    expect(fn, 'the loader draws rows of its own again').not.toContain('.innerHTML')
    expect(fn).toContain("fetch('/api/accounts')")
    // The panel is fed from that very same payload -- both halves must still run.
    expect(fn).toContain('renderClaudeAccountPanel(')
    expect(fn).toContain('renderConnectionsPanel()')
  })

  it('the card list and the separate key list both exist', () => {
    expect(page).toContain('id="accountsHubList"')
    // Keys are NOT accounts: a pasted string has nothing to disconnect, so it
    // must not be drawn as a person's card.
    expect(page).toContain('id="accountsKeyList"')
    expect(app).toMatch(/getElementById\('accountsKeyList'\)/)
  })

  it('the three flows keep their own containers, because the wiring keys off them', () => {
    for (const id of ['claudeAccountPanel', 'googleConnSection', 'mcpConnSection']) {
      expect(page, `#${id} is what dataset.wired is set on`).toContain(`id="${id}"`)
    }
    // ...and everything the flows talk to is still on the page.
    for (const id of ['gconnNoClient', 'gconnFlow', 'mconnFlow', 'claudeAuthFlow', 'mconnState']) {
      expect(page, `#${id}`).toContain(`id="${id}"`)
    }
  })
})

describe('the buttons still reach their handlers', () => {
  it('both delegated click handlers are bound to the card list', () => {
    // The rows are re-rendered on every poll; the listener must sit on the
    // container that survives, and that container is the card list now.
    const bound = app.match(/getElementById\('accountsHubList'\)\.addEventListener\('click'/g) || []
    expect(bound, 'the Google half and the connector half each need one').toHaveLength(2)
  })

  it('every Google action is emitted with the account id it acts on', () => {
    const part = extractFn(app, '_accHubGooglePart')
    for (const act of ['probe', 'reauth', 'default', 'remove']) {
      expect(part, `data-gact="${act}"`).toContain(`data-gact="${act}" data-id="\${id}"`)
    }
    // With ten cards on screen, an action that read a global "current account"
    // would act on the wrong one.
    expect(part).not.toMatch(/_gconnLastName|_driveAccount/)
  })

  it('the connector button carries its account and its server', () => {
    const server = extractFn(app, '_accHubMcpServerHtml')
    expect(server).toContain('data-mact="login"')
    expect(server).toMatch(/data-account="\$\{escapeAttr\(/)
    expect(server).toMatch(/data-server="\$\{escapeAttr\(s\.name\)\}"/)
  })

  it('the card is what the connector flow reads the account name out of', () => {
    // The flow title says "authorize Drive for WHICH account" by walking up to
    // .conn-account and reading .conn-account-name. Rename either and the
    // title silently goes blank.
    const card = extractFn(app, '_accHubCardHtml')
    expect(card).toContain('class="conn-account acc-card"')
    expect(card).toContain('class="conn-account-name"')
    expect(app).toContain(".closest('.conn-account')?.querySelector('.conn-account-name')")
  })

  it('the auto-probe liveness guard points at an element that exists', () => {
    // It stops probing when its element is gone. Pointed at a deleted id it
    // would stop instantly -- and ten accounts would sit at "not checked yet"
    // forever, which is exactly what the auto-probe was written to prevent.
    const probe = extractFn(app, '_gconnAutoProbe')
    const guard = /if \(!document\.getElementById\('([^']+)'\)\) return/.exec(probe)
    expect(guard, 'the guard is gone from _gconnAutoProbe').not.toBeNull()
    expect(html).toContain(`id="${guard![1]}"`)
  })
})

describe('the three loaders only drop data and ask for a redraw', () => {
  // Each answers at its own pace (a ten-address Google probe takes minutes), so
  // none may draw over another's half of the card.
  it('none of the three renders rows of its own any more', () => {
    for (const name of ['_claudeAuthRenderList', '_gconnRenderList', '_mconnRenderStatus']) {
      const fn = extractFn(app, name)
      expect(fn, `${name} still writes its own list`).not.toContain('.innerHTML')
      expect(fn, `${name} does not redraw the panel`).toContain('renderAccountsHub()')
    }
  })

  it('the Google loader keeps the two side effects that are not about drawing', () => {
    const fn = extractFn(app, '_gconnRenderList')
    // Used to decide whether a typed value is an existing account (reuse its
    // token slot) or a new name.
    expect(fn).toMatch(/_gconnKnownIds\s*=\s*new Set\(\(accounts \|\| \[\]\)\.map\(a => a\.id\)\)/)
    // The "you have no OAuth client yet" warning is the one thing that must
    // show even when there is not a single account to draw.
    expect(fn).toContain("getElementById('gconnNoClient')")
  })

  it('the connector loader keeps saying out loud that it is checking', () => {
    const fn = extractFn(app, '_mconnRenderStatus')
    expect(fn).toContain("_connSetState('mconnState'")
    expect(fn).toContain('mconn.checking')
  })

  it('"still loading" and "nothing connected" are two different sentences', () => {
    const fn = extractFn(app, 'renderAccountsHub')
    expect(fn).toContain('acchub.loading')
    expect(fn).toContain('acchub.empty')
  })
})

describe('the key list does not say the same addresses over again', () => {
  // /api/accounts hands Google back among the "services" too, with its accounts
  // listed one by one -- exactly the addresses the cards above already show.
  // That was the complaint this rebuild answers, so the key list drops it.
  it('Google is filtered out of the key list', () => {
    const fn = extractFn(app, '_accHubRenderKeys')
    expect(fn).toMatch(/_claudeAuthKeyServices[\s\S]*?\.filter\(\s*k\s*=>\s*k\.id\s*!==\s*'google'\s*\)/)
  })

  it('the key list is still drawn, and drawn from the services', () => {
    const fn = extractFn(app, '_accHubRenderKeys')
    expect(fn).toContain("getElementById('accountsKeyList')")
    expect(fn).toContain('.innerHTML')
    // Telegram, GitHub and the rest have no card, so they must survive the filter.
    expect(fn).not.toMatch(/k\.id\s*===\s*'(telegram|github)'/)
  })

  it('the key list is redrawn whenever the panel is', () => {
    expect(extractFn(app, 'renderAccountsHub')).toContain('_accHubRenderKeys()')
  })
})

describe('the new classes obey the [hidden] contract', () => {
  it('every hub class with a display of its own can still be hidden', () => {
    // A class `display` outranks the UA's [hidden]{display:none} -- the trap
    // hidden-attribute-css-contract.test.ts exists for.
    expect(css).toMatch(/\.acc-hub\s*\{[^}]*display:\s*flex/)
    for (const cls of ['.acc-hub', '.acc-card', '.acc-part', '.acc-block']) {
      expect(css, `${cls}[hidden]`).toContain(`${cls}[hidden]`)
    }
  })
})
