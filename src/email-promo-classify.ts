// Pure heuristic for the "Promóciók" email view (kanban 8449bbac).
//
// Gmail's own Promotions category is a web-UI-only feature -- it is NOT
// exposed as an IMAP folder/label (confirmed live against the lackor2
// account: no [Gmail]/Promotions or similar mailbox exists), so himalaya
// can't just list a "Promotions" mailbox. Boss chose the fast, sender/subject
// heuristic over a per-message List-Unsubscribe header fetch (2026-08-08):
// the header check is more accurate but needs one extra IMAP round-trip per
// message, which would slow down inbox loading (already a known perf
// concern -- see the "Email-nézet sebesség" kanban card). This trades some
// precision for speed: no extra IMAP calls, works off data envelope listing
// already returns.
//
// Deliberately conservative: false negatives (a promo email left in Inbox)
// are harmless, false positives (a real email hidden in Promóciók) are not
// -- so a rule only fires on fairly distinctive signals, not generic terms
// that could appear in normal correspondence.

export interface PromoEnvelopeLike {
  subject?: string | null
  from?: Array<{ name?: string | null; email?: string | null }> | null
}

// Sender local-parts (before the @) that are, in practice, almost never used
// for anything but bulk marketing mail.
const PROMO_SENDER_LOCAL_PARTS = [
  'promo', 'promo-team', 'promotion', 'promotions', 'marketing', 'newsletter',
  'newsletters', 'deals', 'offers', 'offer', 'campaign', 'campaigns',
]

// Domains/domain-fragments belonging to email service providers that are
// used almost exclusively for marketing/bulk sends (vs. transactional ESPs
// like plain SendGrid, which also carries password resets etc. -- excluded
// on purpose to avoid false positives).
const PROMO_SENDER_DOMAIN_SUBSTRINGS = [
  'mailchimp', 'klaviyo', 'hubspotemail', 'constantcontact', 'mailerlite',
  'campaign-archive', 'sailthru', 'e.aliexpress.com',
]

// Subject-line patterns distinctive enough to rarely appear outside a
// marketing email (a %-off figure, an explicit sale/clearance/coupon call-out).
const PROMO_SUBJECT_PATTERNS: RegExp[] = [
  /\d{1,3}\s*%\s*(off|kedvezmény|kedvezmenyt)\b/i,
  /\bclearance\b/i,
  /\bcoupon\b/i,
  /\bkupon(kód|kod)?\b/i,
  // No trailing \b: JS regex \b is ASCII-\w-only, so a boundary check right
  // after an accented "ó" silently never matches (verified: /\bakció\b/i
  // fails on "akció" itself) -- the leading \b (before the ASCII "a") is
  // enough to avoid matching mid-word.
  /\bakci[oó]s?/i,
  /\bkedvezm[eé]ny(es)?\b/i,
  /\ble[eé]rt[eé]kel[eé]s/i,
  /\bblack friday\b/i,
  /\bcyber monday\b/i,
  /ingyenes sz[aá]ll[ií]t[aá]s/i,
]

/** True when an envelope (subject + sender) matches the promo heuristic. */
export function isPromotionalEnvelope(env: PromoEnvelopeLike): boolean {
  const email = (env.from?.[0]?.email || '').trim().toLowerCase()
  const atIdx = email.indexOf('@')
  const localPart = atIdx >= 0 ? email.slice(0, atIdx) : email
  const domain = atIdx >= 0 ? email.slice(atIdx + 1) : ''

  if (localPart && PROMO_SENDER_LOCAL_PARTS.some(p => localPart === p || localPart.startsWith(p + '.') || localPart.startsWith(p + '-') || localPart.startsWith(p + '_'))) {
    return true
  }
  if (domain && PROMO_SENDER_DOMAIN_SUBSTRINGS.some(d => domain.includes(d))) {
    return true
  }
  const subject = env.subject || ''
  if (subject && PROMO_SUBJECT_PATTERNS.some(rx => rx.test(subject))) {
    return true
  }
  return false
}
