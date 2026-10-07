import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')

describe('Workbench tree root + layers (TG 2399/2402)', () => {
  it('the project is the root row of the tree and everything is one level deeper', () => {
    expect(js).toContain('wb-root-title')
    expect(js).toContain('walk(box, 1, null)')
    expect(js).toContain("data-wb-drop-box=\"1\"")
  })
  it('the panel upload only stores the file, it does not place it on the page', () => {
    expect(js).toContain('canvasDropImage(list[0], null, null, true)')
    expect(js).toContain('if (uploadOnly)')
  })
  it('there is a Layers tab with select and multi-move', () => {
    expect(js).toContain("['layers', '☰']")
    expect(js).toContain('fr-layer-sel')
    expect(js).toContain('pk.length > 1')
  })
  it('Layers rows have show/hide and forward/back, and a Format box sends one update per field (TG 2597)', () => {
    expect(js).toContain('fr-layer-vis')
    expect(js).toContain("op: 'order', id: act.getAttribute('data-wb-obj'), to: act.getAttribute('data-wb-arg')")
    expect(js).toContain('function frFormatHtml')
    expect(js).toContain("el.getAttribute('data-wb-act') !== 'fr-fmt'")
    for (const k of ['text_color', 'size', 'background', 'transparent', 'opacity']) expect(js).toContain('workbench.fr.fmt.' + k)
  })
  it('an uploaded picture is not placed by a click: it is dragged, and has a "..." menu with details (TG 2603)', () => {
    const i = js.indexOf('function frImageThumbs')
    const body = js.slice(i, js.indexOf('function frThumbDetailsHtml'))
    expect(body).toContain('data-wb-drag-img="1"')
    expect(body).not.toMatch(/class="wb-fr-thumb"[^>]*data-wb-act="fr-add-image"/)
    expect(body).toContain('data-wb-act="file-ctx"')
    expect(js).toContain("closest('[data-wb-drag-img]')")
    expect(js).toContain('workbench.fr.thumb_uploaded')
  })
  it('the Uploads tab also lists the image files lying next to the work item (TG 2608)', () => {
    expect(js).toContain('function frUploadImages')
    expect(js).toContain('WB.detail.assets')
    expect(js).toContain('isImageFile({ name: a.name })')
  })
})

describe('#501 picture to work item asks which kind (TG 2569)', () => {
  const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
  it('offers picture / presentation / graphic for an image file', () => {
    expect(js).toContain("['image', 'presentation', 'graphic']")
    expect(js).toContain("act.getAttribute('data-wb-kind')")
    expect(js).toContain("kind === 'presentation'")
  })
})

describe('#501 Layers clicks during a save wait their turn (TG 2612)', () => {
  const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
  it('order and visibility go through the queue, and the buttons are not disabled while busy', () => {
    expect(js).toContain("layerOp([{ op: 'order'")
    expect(js).toContain('function layerQueueFlush()')
    const start = js.indexOf('var mv = function (to, label)')
    expect(js.slice(start, start + 600)).not.toContain('disabled')
  })
})

describe('#501 the rail Projects tab keeps a New work item button (TG 2619)', () => {
  const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
  it('compact items panel renders the new button or form', () => {
    expect(js).toContain('(compact ? (archived() ?')
    expect(js).toContain('TG 2619')
  })
})
