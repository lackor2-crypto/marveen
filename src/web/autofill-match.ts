// Which stored login belongs to the page the browser is standing on.
//
// Card 21311fdb (#96), the second half of 85eafd56 (#46). Boss, through the
// card: when a login form opens in Chrome, the MARVEEN vault should fill it,
// not the browser's own password manager. That only works if the server can
// answer one narrow question -- "what do you have for THIS url?" -- and can
// refuse every wider one.
//
// This module is the pure half: no crypto, no I/O, no database. It decides
//   (1) whether a vault entry's stored url covers the page's url, and
//   (2) which of the entry's fields form a username/password pair.
// src/web/autofill-clients.ts owns the tokens, routes/autofill.ts the wire.
//
// The matching direction is deliberately one-way. An entry saved as
// "youtube.com" covers "www.youtube.com" (the user named the site, the browser
// added the host), but an entry saved as "accounts.google.com" does NOT cover
// "mail.google.com" -- widening a stored url is the caller's guess, and a wrong
// guess here means a password typed into a site the user never paired it with.

import type { VaultField } from '../vault-fields.js'

/** Hosts that are registries, not sites: an entry saved as one of these would
 *  otherwise act as a wildcard over every site under it. The list is short on
 *  purpose -- it only needs to cover what a person might paste by accident,
 *  and anything missing still has to pass the one-dot rule below. */
const PUBLIC_SUFFIXES = new Set([
  'com', 'net', 'org', 'edu', 'gov', 'io', 'co', 'hu', 'de', 'uk', 'eu',
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'com.au', 'co.jp', 'co.nz', 'com.br',
])

/** The host part of a url, lowercased, without port, `www.` kept.
 *  Accepts bare hosts too ("youtube.com"), because that is what people type
 *  into a vault card's url field. Returns null when there is no usable host --
 *  the caller must treat that as "no match", never as "matches everything". */
export function hostFromUrlLike(input: string | undefined | null): string | null {
  const raw = (input ?? '').trim()
  if (!raw) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`
  let host: string
  try { host = new URL(withScheme).hostname.toLowerCase() } catch { return null }
  if (!host) return null
  // A trailing dot is a legal absolute-root FQDN ("youtube.com.") and would
  // otherwise make two spellings of the same host compare unequal.
  return host.endsWith('.') ? host.slice(0, -1) : host
}

/** True when `entryHost` is specific enough to stand for a site. */
export function isUsableEntryHost(host: string): boolean {
  if (!host.includes('.')) return false
  if (PUBLIC_SUFFIXES.has(host)) return false
  return true
}

/**
 * Does an entry's stored url cover the page's url?
 *
 * Equal hosts match. A page host matches when it sits UNDER the entry host
 * (`www.youtube.com` under `youtube.com`). Nothing else matches: same-parent
 * siblings do not, and a lookalike ("evil-youtube.com") cannot, because the
 * test requires the dot separator.
 */
export function urlCoversPage(entryUrl: string | undefined | null, pageUrl: string): boolean {
  const entryHost = hostFromUrlLike(entryUrl)
  const pageHost = hostFromUrlLike(pageUrl)
  if (!entryHost || !pageHost) return false
  if (!isUsableEntryHost(entryHost)) return false
  if (entryHost === pageHost) return true
  return pageHost.endsWith(`.${entryHost}`)
}

const PASSWORD_LABEL = /jelsz|password|passwd|\bpass\b|pin\b/i
const USERNAME_LABEL = /felhaszn|user|login|bejelent|e-?mail|azonos|account|fiók|fiok/i
// A one-time code is a secret field that must never be offered as the password:
// filling it would send a stale code and look like a wrong password.
const NOT_A_PASSWORD = /helyre|recovery|backup|mentő|mento|seed|otp|2fa|totp|api|token|kulcs|key/i

/** One fillable username/password pair found inside a vault entry. */
export interface FieldCredential {
  /** Named group on the card ("Belépés"), empty for the card's default group. */
  section: string
  usernameLabel: string
  username: string
  passwordLabel: string
  password: string
}

/** Why an entry that matched the url still cannot fill anything. */
export type CredentialProblem = 'no_password'

function groupBySection(fields: VaultField[]): Map<string, VaultField[]> {
  const out = new Map<string, VaultField[]>()
  for (const f of fields) {
    const key = f.section?.trim() || ''
    const list = out.get(key)
    if (list) list.push(f)
    else out.set(key, [f])
  }
  return out
}

function pickPassword(fields: VaultField[]): VaultField | null {
  const secrets = fields.filter(f => f.kind === 'secret' && f.value)
  const named = secrets.find(f => PASSWORD_LABEL.test(f.label) && !NOT_A_PASSWORD.test(f.label))
  if (named) return named
  // No field says "password" in so many words. A lone secret field on a login
  // card is still almost certainly it -- but only if nothing marks it as a
  // recovery code or an API key, where filling it would be actively wrong.
  const plain = secrets.filter(f => !NOT_A_PASSWORD.test(f.label))
  return plain.length === 1 ? plain[0]! : null
}

function pickUsername(fields: VaultField[], password: VaultField): VaultField | null {
  const others = fields.filter(f => f !== password && f.kind !== 'secret' && f.value)
  const named = others.find(f => USERNAME_LABEL.test(f.label))
  if (named) return named
  // Fall back to the field directly above the password: that is how login
  // cards are written, and how the form itself is laid out.
  const idx = fields.indexOf(password)
  for (let i = idx - 1; i >= 0; i--) {
    const f = fields[i]!
    if (f.kind !== 'secret' && f.value) return f
  }
  return others[0] ?? null
}

/**
 * Every username/password pair an entry can fill, one per named group.
 *
 * A card can legitimately hold more than one login (a site's two accounts, or
 * a "Bankkártya" group next to a "Belépés" one), and the groups are what keep
 * them apart -- Boss, 2026-08-10: "azon a jelszo mihez tartozik?".
 */
export function credentialsFromFields(fields: VaultField[]): FieldCredential[] {
  const out: FieldCredential[] = []
  for (const [section, group] of groupBySection(fields)) {
    const password = pickPassword(group)
    if (!password) continue
    const username = pickUsername(group, password)
    out.push({
      section,
      usernameLabel: username?.label ?? '',
      username: username?.value ?? '',
      passwordLabel: password.label,
      password: password.value,
    })
  }
  return out
}
