// #725/#726 (Boss TG 4003): the first press of the e-mail draft button did not put the draft into the Drafts folder, the
// second did. Both steps of the save (finding the folder, the compose call) must survive a moment's failure.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { saveDraftToFolder, FOLDER_LOOKUP_ATTEMPTS, type DraftSaveDeps } from '../web/email-draft-save.js'

const msg = { to: 'a@x.hu', cc: '', subject: 'Betreff', body: 'Text', files: ['/tmp/a.pdf'] }

function deps(over: Partial<DraftSaveDeps> = {}): DraftSaveDeps & { calls: string[][]; warns: string[]; saved: string[] } {
  const calls: string[][] = []
  const warns: string[] = []
  const saved: string[] = []
  return {
    isKnownAccount: () => true,
    accountEmail: () => 'me@x.hu',
    resolveFolders: async () => ({ drafts: '[Gmail]/Drafts' }),
    fallbackFolder: '[Gmail]/Piszkozatok',
    compose: async (args) => { calls.push(args); return { ok: true, text: '' } },
    onSaved: (id, f) => { saved.push(`${id}:${f}`) },
    warn: (t) => { warns.push(t) },
    sleep: async () => {},
    calls, warns, saved,
    ...over,
  }
}

describe('workbench mailbox draft save', () => {
  it('saves into the account\'s own Drafts folder on the first press', async () => {
    const d = deps()
    const r = await saveDraftToFolder(d, 'acc', msg)
    expect(r).toEqual({ ok: true, mailbox: '[Gmail]/Drafts' })
    expect(d.calls).toHaveLength(1)
    expect(d.calls[0]).toContain('--save')
    expect(d.calls[0][d.calls[0].indexOf('--save') + 1]).toBe('[Gmail]/Drafts')
    expect(d.saved).toEqual(['acc:[Gmail]/Drafts'])
  })

  it('a failed folder lookup is retried, not turned into the guessed fallback name', async () => {
    let n = 0
    const resolveFolders = vi.fn(async () => (++n < 3 ? null : { drafts: '[Gmail]/Drafts' }))
    const d = deps({ resolveFolders })
    const r = await saveDraftToFolder(d, 'acc', msg)
    expect(resolveFolders).toHaveBeenCalledTimes(3)
    expect(r.mailbox).toBe('[Gmail]/Drafts')
    expect(d.warns).toEqual([])
  })

  it('a lookup that throws counts as a failed lookup and is retried', async () => {
    let n = 0
    const d = deps({ resolveFolders: async () => { if (++n === 1) throw new Error('boom'); return { drafts: 'Drafts' } } })
    expect((await saveDraftToFolder(d, 'acc', msg)).mailbox).toBe('Drafts')
  })

  it('uses the fallback (and says so) only after every lookup attempt failed', async () => {
    const resolveFolders = vi.fn(async () => null)
    const d = deps({ resolveFolders })
    const r = await saveDraftToFolder(d, 'acc', msg)
    expect(resolveFolders).toHaveBeenCalledTimes(FOLDER_LOOKUP_ATTEMPTS)
    expect(r.mailbox).toBe('[Gmail]/Piszkozatok')
    expect(d.warns[0]).toContain('could not be looked up')
  })

  it('an authoritative answer without a Drafts folder goes to the fallback at once, no retry', async () => {
    const resolveFolders = vi.fn(async () => ({}))
    const d = deps({ resolveFolders })
    const r = await saveDraftToFolder(d, 'acc', msg)
    expect(resolveFolders).toHaveBeenCalledTimes(1)
    expect(r.mailbox).toBe('[Gmail]/Piszkozatok')
    expect(d.warns[0]).toContain('is not flagged')
  })

  it('a failed compose is reported with the real error and logged, and nothing is marked saved', async () => {
    const d = deps({ compose: async () => ({ ok: false, text: 'Resource temporarily unavailable (os error 11)' }) })
    const r = await saveDraftToFolder(d, 'acc', msg)
    expect(r).toEqual({ ok: false, detail: 'Resource temporarily unavailable (os error 11)' })
    expect(d.warns.join('\n')).toContain('os error 11')
    expect(d.saved).toEqual([])
  })

  it('an unknown account is refused before any lookup or compose', async () => {
    const resolveFolders = vi.fn(async () => ({ drafts: 'D' }))
    const d = deps({ isKnownAccount: () => false, resolveFolders })
    expect(await saveDraftToFolder(d, 'nope', msg)).toEqual({ ok: false, detail: 'unknown account' })
    expect(resolveFolders).not.toHaveBeenCalled()
    expect(d.calls).toEqual([])
  })

  it('the route\'s compose goes through himalayaRead (the transient-error retry), not himalayaOnce', () => {
    const route = readFileSync(join(__dirname, '..', 'web', 'routes', 'email.ts'), 'utf8')
    const port = route.slice(route.indexOf('registerMailboxDraftPort({'), route.indexOf('// #741: the workbench asks the Sent mailbox'))
    expect(port).toContain('saveDraftToFolder(')
    expect(port).toContain('await himalayaRead(args)')
    expect(port).not.toContain('himalayaOnce(')
  })
})
