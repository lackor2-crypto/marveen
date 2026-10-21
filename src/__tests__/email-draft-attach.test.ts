// #635 (Boss TG 2981): a draft in the Drafts mailbox could only be read and its attachments downloaded; nothing
// let the owner edit it, attach a file or send it. Source-level pins of the fix.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..', '..')
const app = readFileSync(join(root, 'web', 'app.js'), 'utf8')
const html = readFileSync(join(root, 'web', 'index.html'), 'utf8')
const route = readFileSync(join(root, 'src', 'web', 'routes', 'email.ts'), 'utf8')
const compose = route.slice(route.indexOf("path === '/api/email/compose'"), route.indexOf("path === '/api/email/read'"))

describe('email draft editing and attaching (#635)', () => {
  it('the Drafts mailbox gets an "edit and send" button that opens the compose window with the draft', () => {
    expect(app).toContain("emailRoleOfMailboxName(mailbox) === 'drafts'")
    expect(app).not.toContain("emailMailboxRole(mailbox)")
    expect(app).toContain('emailShowComposeFromDraft(id, envelope, mailbox, msg)')
    expect(app).toContain("_emailComposeDraft = {")
  })

  it('the compose window has a file picker and lists the draft attachments with a keep tick', () => {
    expect(html).toContain('id="emailComposeNewFiles"')
    expect(html).toContain('id="emailComposeNewAttachBtn"')
    expect(app).toContain('data-email-draft-att')
  })

  it('send carries the picked files and the draft to keep/remove', () => {
    expect(app).toContain('uploads.length ? { uploads } : {}')
    expect(app).toContain('draft: { mailbox: draft.mailbox, id: draft.id, keep: keepIds, remove: true }')
  })

  it('the server attaches uploads and kept draft attachments, caps the size, and moves the sent draft to Trash', () => {
    expect(compose).toContain('data.uploads')
    expect(compose).toContain("'attachment', 'download'")
    expect(compose).toContain('EMAIL_ATTACH_LIMIT')
    expect(compose).toContain("'message', 'move', String(data.draft.id)")
    expect(compose).toContain("for (const p of extraPaths) args.push('--attach', p)")
  })

  it('ids that reach himalaya are validated, and the temp dir is always removed', () => {
    expect(compose).toContain("json(res, { error: 'bad draft id' }, 400)")
    expect(compose).toContain('rmSync(work, { recursive: true, force: true })')
  })

  it('a new draft can be saved from the compose window (#636): no send, Drafts mailbox, no recipient needed', () => {
    expect(html).toContain('id="emailComposeNewDraftSaveBtn"')
    expect(app).toContain('asDraft ? { save_draft: true } : {}')
    expect(compose).toContain("asDraft ? 'drafts' : 'sent'")
    expect(compose).toContain("if (!asDraft) args.push('--send')")
    expect(compose).toContain("if (data.to?.trim()) args.push('-t', data.to.trim())")
  })

  it('closing a changed, unsent letter keeps it as a draft, like Gmail (Boss TG 2995)', () => {
    expect(app).toContain('async function emailComposeNewClose()')
    expect(app).toContain('emailComposeSnapshot() !== _emailComposeBase')
    expect(app).toContain("getElementById('emailComposeNewClose')?.addEventListener('click', emailComposeNewClose)")
    expect(app).toContain("getElementById('emailComposeNewCancelBtn')?.addEventListener('click', emailComposeNewClose)")
  })
})
