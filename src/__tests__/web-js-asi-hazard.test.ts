// A missing semicolon before a line that starts with `(` or `[` does NOT end
// the statement: JavaScript glues the two together. 2026-09-25 (#390) the
// network-banner IIFE `const _netStatus = (() => {...})()` was followed by the
// token IIFE `(() => {...})()` with no `;` between them, so the browser called
// the first IIFE's return value as a function:
//   TypeError: (intermediate value)(...)(...) is not a function  (app.js:341)
// The whole dashboard script stopped at load and every page stayed empty,
// while `node --check`, tsc and the server-side suite were all green -- the
// file is syntactically valid, it only fails at runtime in the browser.
//
// The guard parses every hand-written web/*.js file with the TypeScript
// parser (already a dependency) and flags each call `f(...)` / index `a[...]`
// whose opening `(` / `[` is the first thing on a NEW line, i.e. glued onto
// the expression that ended on an earlier line. Nobody writes that on
// purpose; it is always a missing semicolon. A real parser, not a line regex:
// the dashboard is full of multi-line template literals and comments whose
// text starts with `(`.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

const ROOT = join(__dirname, '..', '..')
const WEB = join(ROOT, 'web')

function jsFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name === 'vendor' || name === 'node_modules') continue
      out.push(...jsFiles(p))
    } else if (name.endsWith('.js') && !name.endsWith('.min.js')) {
      out.push(p)
    }
  }
  return out
}

function asiHazards(src: string, fileName = 'x.js'): string[] {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const hits: string[] = []
  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line
  const visit = (node: ts.Node): void => {
    let callee: ts.Expression | undefined
    if (ts.isCallExpression(node) || ts.isElementAccessExpression(node)) callee = node.expression
    if (callee && !(ts.isCallExpression(node) && node.questionDotToken)) {
      const open = ts.skipTrivia(src, callee.end)
      const lineStart = sf.getPositionOfLineAndCharacter(lineOf(open), 0)
      const startsLine = src.slice(lineStart, open).trim() === ''
      if (startsLine && lineOf(open) > lineOf(callee.end)) {
        hits.push(`${lineOf(callee.end) + 1} -> ${lineOf(open) + 1}: ${src.slice(open, open + 40).split('\n')[0]}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return hits
}

describe('web/*.js: no statement glued onto the next by a missing semicolon', () => {
  it('flags the exact #390 shape, and not the fixed one', () => {
    const bad = 'const a = (() => {\n  return 1\n})()\n\n(() => {\n  run()\n})()\n'
    expect(asiHazards(bad)).toHaveLength(1)
    const good = 'const a = (() => {\n  return 1\n})();\n\n(() => {\n  run()\n})()\n'
    expect(asiHazards(good)).toHaveLength(0)
  })

  it('flags a glued array index too', () => {
    expect(asiHazards('const x = foo()\n[1, 2].forEach(f)\n')).toHaveLength(1)
  })

  it('ignores `(` inside comments and template literals, and normal multi-line calls', () => {
    const src = [
      '/*',
      ' (not code)',
      ' */',
      'const h = `',
      '  <!-- x -->',
      '  (also not code)',
      '`',
      'foo(',
      '  1,',
      ')',
      'bar(a)(b)',
    ].join('\n')
    expect(asiHazards(src)).toHaveLength(0)
  })

  for (const file of jsFiles(WEB)) {
    it(relative(ROOT, file), () => {
      expect(asiHazards(readFileSync(file, 'utf-8'), file)).toEqual([])
    })
  }
})
