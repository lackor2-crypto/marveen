// #725 (Boss TG 4003): the first press of the e-mail draft button did not put the draft into the Drafts folder, the second did.
// The save now retries the known transient IMAP error like the reads do. Source-level pin.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const route = readFileSync(join(__dirname, '..', 'web', 'routes', 'email.ts'), 'utf8')
const port = route.slice(route.indexOf('registerMailboxDraftPort({'), route.indexOf('// === Iroda "Beallitasok"'))

describe('workbench mailbox draft save retries transient IMAP errors', () => {
  it('the compose --save call goes through himalayaRead, not himalayaOnce', () => {
    expect(port).toContain("'--save', drafts")
    expect(port).toContain('await himalayaRead(args)')
    expect(port).not.toContain('himalayaOnce(args)')
  })
})
