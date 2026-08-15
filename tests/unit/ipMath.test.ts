import { describe, it, expect } from 'vitest'
import { ipToNumber, ipInCIDR } from '../../electron/utils/ipMath'

describe('ipMath.ipToNumber', () => {
  it('converts 192.168.1.1 to unsigned 3232235777 (>>>0)', () => {
    expect(ipToNumber('192.168.1.1')).toBe(3232235777)
  })

  it('returns 4294967295 for 255.255.255.255 (no signed overflow)', () => {
    expect(ipToNumber('255.255.255.255')).toBe(4294967295)
  })

  it('returns null for segment > 255 (999.1.1.1)', () => {
    expect(ipToNumber('999.1.1.1')).toBeNull()
  })

  it('returns null for non-numeric segments (a.b.c.d)', () => {
    expect(ipToNumber('a.b.c.d')).toBeNull()
  })

  it('returns null for 3-segment and 5-segment inputs', () => {
    expect(ipToNumber('1.2.3')).toBeNull()
    expect(ipToNumber('1.2.3.4.5')).toBeNull()
  })

  it('returns null for negative segment (-1.2.3.4)', () => {
    expect(ipToNumber('-1.2.3.4')).toBeNull()
  })
})

describe('ipMath.ipInCIDR', () => {
  it('returns true when ip falls inside /24 cidr', () => {
    expect(ipInCIDR('192.168.1.10', '192.168.1.0/24')).toBe(true)
  })

  it('returns false when ip falls outside /24 cidr', () => {
    expect(ipInCIDR('192.168.10.1', '192.168.1.0/24')).toBe(false)
  })

  it('returns true for /0 catch-all (0.0.0.0/0)', () => {
    expect(ipInCIDR('1.2.3.4', '0.0.0.0/0')).toBe(true)
  })

  it('returns false for malformed cidr missing prefix (192.168.1.0/)', () => {
    expect(ipInCIDR('192.168.1.10', '192.168.1.0/')).toBe(false)
  })

  it('returns false for malformed network part (notacidr/8)', () => {
    expect(ipInCIDR('192.168.1.10', 'notacidr/8')).toBe(false)
  })

  it('returns false for out-of-range prefix (/33 and x.x.x.x/33) — WR-04 one bad rule must not swallow all IPs', () => {
    expect(ipInCIDR('1.2.3.4', '/33')).toBe(false)
    expect(ipInCIDR('1.2.3.4', 'x.x.x.x/33')).toBe(false)
  })
})
