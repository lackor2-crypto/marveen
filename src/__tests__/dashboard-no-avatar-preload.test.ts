import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// #891 (second cause): every dashboard load fetched all 20 avatar PNGs (~0.7-1.1 MB each, 17 MB in total) for the
// hidden avatar-picker modals. They queued ahead of /api/auth/status and the first page calls on the browser's
// per-host connection limit, so the window stayed empty after F5. The grids are built only when their modal opens,
// and every avatar <img> is lazy.
const root = path.resolve(__dirname, '..', '..')
const app = fs.readFileSync(path.join(root, 'web', 'app.js'), 'utf8')

describe('avatar pictures do not load with the dashboard (#891)', () => {
  it('the boot sequence does not build the avatar grid', () => {
    const boot = app.match(/const bootExtras = \(\) => \{([^}]*)\}/)
    expect(boot).not.toBeNull()
    expect(boot![1]).not.toContain('populateAvatarGrid')
  })
  it('every avatar <img> is built through the lazy helper, never as a bare eager tag', () => {
    expect(app).toContain('function avatarImgHtml(')
    const helper = app.match(/function avatarImgHtml\([\s\S]*?\n\}/)![0]
    expect(helper).toContain('loading="lazy"')
    expect(helper).toContain('decoding="async"')
    const outsideHelper = app.replace(helper, '')
    const eager = outsideHelper.match(/<img src=["'`]\/avatars\//g) ?? []
    expect(eager).toEqual([])
  })
  it('the create wizard still builds its grid when it opens', () => {
    expect(app).toMatch(/if \(!document\.querySelector\('#avatarGrid \.avatar-grid-item'\)\) populateAvatarGrid\(\)/)
  })
})
