import { describe, it, expect } from 'vitest'
import { isPromotionalEnvelope } from '../email-promo-classify.js'

function envelope(email: string, subject: string) {
  return { subject, from: [{ name: null, email }] }
}

describe('isPromotionalEnvelope', () => {
  it('matches a real-world marketing email (AliExpress promo, verified live 2026-08-09)', () => {
    expect(isPromotionalEnvelope(envelope('promotion@aliexpress.com', 'Clearance: up to 60% off'))).toBe(true)
  })

  it('matches on a distinctive sender local-part alone', () => {
    expect(isPromotionalEnvelope(envelope('newsletter@example.com', 'Weekly update'))).toBe(true)
    expect(isPromotionalEnvelope(envelope('marketing.team@example.com', 'Hi there'))).toBe(true)
  })

  it('matches on a known marketing-ESP domain alone', () => {
    expect(isPromotionalEnvelope(envelope('hello@list.mailchimp.com', 'Hi there'))).toBe(true)
  })

  it('matches on a distinctive Hungarian subject keyword alone', () => {
    expect(isPromotionalEnvelope(envelope('info@example.com', 'Nagy AKCIÓ csak ma!'))).toBe(true)
    expect(isPromotionalEnvelope(envelope('info@example.com', '20% kedvezmény mindenre'))).toBe(true)
  })

  it('does not flag a real Gmail storage-warning email (verified live 2026-08-09)', () => {
    expect(isPromotionalEnvelope(envelope('google-noreply@google.com', 'A Gmail-tárhelyed 84%-ig megtelt'))).toBe(false)
  })

  it('does not flag an ordinary transactional/personal email', () => {
    expect(isPromotionalEnvelope(envelope('boss@example.com', 'Találkozó holnap'))).toBe(false)
    expect(isPromotionalEnvelope(envelope('noreply@bank.com', 'A számlakivonatod elkészült'))).toBe(false)
  })

  it('handles a missing/malformed sender gracefully', () => {
    expect(isPromotionalEnvelope({ subject: 'Hi', from: [] })).toBe(false)
    expect(isPromotionalEnvelope({ subject: null, from: null })).toBe(false)
    expect(isPromotionalEnvelope({})).toBe(false)
  })
})
