// #766: find the external services the code asks the Vault for, so a CI gate can tell
// whether each one has a row in the setup wizard (setup-wizard-registry.ts) or a reasoned
// exception. Pure text scan, no imports from the app: it must run the same on a fresh install.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/** Vault ids written as literals: a getSecret call with a quoted id, and VAULT-named string constants. */
export function extractVaultIds(source: string): string[] {
  const ids = new Set<string>()
  for (const m of source.matchAll(/getSecret\(\s*(['"])([^'"`$\n]+)\1/g)) ids.add(m[2])
  for (const m of source.matchAll(/\bconst\s+[A-Z0-9_]*VAULT[A-Z0-9_]*\s*=\s*(['"])([^'"`$\n]+)\1/g)) ids.add(m[2])
  ids.delete('')
  return [...ids].filter(id => !/\s/.test(id) && !id.endsWith('-'))
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name === 'node_modules') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p)
  }
}

/** vault id -> first source file (relative to root) that names it. */
export function scanVaultIds(srcDir: string, root: string): Map<string, string> {
  const files: string[] = []
  walk(srcDir, files)
  const found = new Map<string, string>()
  for (const f of files.sort()) {
    for (const id of extractVaultIds(readFileSync(f, 'utf8'))) if (!found.has(id)) found.set(id, relative(root, f))
  }
  return found
}
