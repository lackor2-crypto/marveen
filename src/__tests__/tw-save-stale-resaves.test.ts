import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const JS = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
const HU = readFileSync(join(__dirname, '..', '..', 'web', 'lang', 'hu.js'), 'utf8')
const EN = readFileSync(join(__dirname, '..', '..', 'web', 'lang', 'en.js'), 'utf8')

// #840 (Boss TG 4458/4471/4484): the saved German version (77M) lacked the signature picture and the empty lines. The
// original had changed after it was translated, the column showed the OLD translation, and "Fordítás mentése" did
// nothing at all (only sections whose translation is current are written). Pressing Save on an old translation now
// translates the old chapters again (the run saves by itself at its end) and says so.
describe('Save on an old translation re-translates and saves (#840)', () => {
  const i = JS.indexOf('function twSave(')
  const body = JS.slice(i, i + 3200)

  it('twSave finds the chapters whose translation is old and runs the translation for them', () => {
    expect(body).toContain('var staleSecs = ')
    expect(body).toContain('pv.sig !== twSig(sec)')
    expect(body).toContain('if (auto !== true && staleSecs.length && !archived())')
    expect(body).toContain('twRun()')
  })

  it('the re-run happens before the "nothing to save" dead end, and the run ends with an automatic save', () => {
    expect(body.indexOf('twRun()')).toBeLessThan(body.indexOf("t('workbench.tw.nothing_current')"))
    const j = JS.indexOf('function twRun(')
    expect(JS.slice(j, j + 3200)).toContain('twSave(true)')
  })

  it('the note that says why is in both languages', () => {
    expect(body).toContain("t('workbench.tw.resave_stale'")
    expect(HU).toContain('"workbench.tw.resave_stale"')
    expect(EN).toContain('"workbench.tw.resave_stale"')
  })
})
