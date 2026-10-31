import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const JS = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
const CSS = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.css'), 'utf8')

describe('one look in the translation column, the page and the preview (TG 3922)', () => {
  it('a translated block carries the same kind classes and list rows as the page block', () => {
    const i = JS.indexOf('function twTextLook')
    const body = JS.slice(i, i + 900)
    expect(body).toContain("'wb-dp-block wb-outline-kind-'")
    expect(body).toContain('dpListLinesHtml')
    expect(JS).toContain("'<div class=\"wb-tw-block ' + look.cls")
  })
  it('the column block has the page block spacing and line height', () => {
    expect(CSS).toMatch(/\.wb-tw-page \.wb-tw-block \{[^}]*line-height: 1\.6/)
  })
})

describe('the picture in the translation column is selectable, movable, resizable, deletable (TG 3925)', () => {
  it('has select, drag, size and delete handlers writing data-tw-text', () => {
    expect(JS).toContain('function twPicSelect')
    expect(JS).toContain('function twPicPut')
    expect(JS).toContain('function twPicDelete')
    expect(JS).toContain("data-tw-pic=\"del\"")
    expect(JS).toContain("isl.setAttribute('data-tw-text'")
  })
})
