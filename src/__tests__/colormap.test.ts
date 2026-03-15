import { describe, it, expect } from 'vitest'
import {
  interpolateGrayscale,
  interpolateHot,
  interpolateTurbo,
  buildLut,
  normalizeValue,
} from '../colormap'

// ── helpers ──────────────────────────────────────────────────────────────────

function isValidRgb([r, g, b]: [number, number, number]) {
  return [r, g, b].every(v => Number.isInteger(v) && v >= 0 && v <= 255)
}

// ── interpolateGrayscale ─────────────────────────────────────────────────────

describe('interpolateGrayscale', () => {
  it('returns black at t=0', () => {
    expect(interpolateGrayscale(0)).toEqual([0, 0, 0])
  })

  it('returns white at t=1', () => {
    expect(interpolateGrayscale(1)).toEqual([255, 255, 255])
  })

  it('returns mid-grey at t=0.5', () => {
    const [r, g, b] = interpolateGrayscale(0.5)
    expect(r).toBe(g)
    expect(g).toBe(b)
    expect(r).toBeCloseTo(128, 0)
  })

  it('clamps below 0', () => {
    expect(interpolateGrayscale(-1)).toEqual([0, 0, 0])
  })

  it('clamps above 1', () => {
    expect(interpolateGrayscale(2)).toEqual([255, 255, 255])
  })

  it('always returns equal R G B channels (greyscale invariant)', () => {
    for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const [r, g, b] = interpolateGrayscale(t)
      expect(r).toBe(g)
      expect(g).toBe(b)
    }
  })

  it('is monotonically non-decreasing', () => {
    let prev = -1
    for (let i = 0; i <= 100; i++) {
      const [r] = interpolateGrayscale(i / 100)
      expect(r).toBeGreaterThanOrEqual(prev)
      prev = r
    }
  })
})

// ── interpolateHot ───────────────────────────────────────────────────────────

describe('interpolateHot', () => {
  it('returns black at t=0', () => {
    expect(interpolateHot(0)).toEqual([0, 0, 0])
  })

  it('returns white at t=1', () => {
    expect(interpolateHot(1)).toEqual([255, 255, 255])
  })

  it('is pure red at t≈0.333 (first segment end)', () => {
    const [r, g, b] = interpolateHot(0.333)
    expect(r).toBe(255)
    expect(g).toBe(0)
    expect(b).toBe(0)
  })

  it('returns valid RGB at all sampled points', () => {
    for (let i = 0; i <= 100; i++) {
      expect(isValidRgb(interpolateHot(i / 100))).toBe(true)
    }
  })

  it('clamps below 0', () => {
    expect(interpolateHot(-5)).toEqual([0, 0, 0])
  })

  it('clamps above 1', () => {
    expect(interpolateHot(5)).toEqual([255, 255, 255])
  })
})

// ── interpolateTurbo ─────────────────────────────────────────────────────────

describe('interpolateTurbo', () => {
  it('returns valid RGB at t=0', () => {
    expect(isValidRgb(interpolateTurbo(0))).toBe(true)
  })

  it('returns valid RGB at t=1', () => {
    expect(isValidRgb(interpolateTurbo(1))).toBe(true)
  })

  it('returns valid RGB at all sampled points', () => {
    for (let i = 0; i <= 100; i++) {
      expect(isValidRgb(interpolateTurbo(i / 100))).toBe(true)
    }
  })

  it('clamps below 0', () => {
    expect(interpolateTurbo(-1)).toEqual(interpolateTurbo(0))
  })

  it('clamps above 1', () => {
    expect(interpolateTurbo(2)).toEqual(interpolateTurbo(1))
  })
})

// ── buildLut ─────────────────────────────────────────────────────────────────

describe('buildLut', () => {
  it('produces exactly 256×3 bytes', () => {
    const lut = buildLut(interpolateGrayscale)
    expect(lut).toBeInstanceOf(Uint8Array)
    expect(lut.length).toBe(256 * 3)
  })

  it('entry 0 matches colormap(0)', () => {
    const lut = buildLut(interpolateGrayscale)
    const [r, g, b] = interpolateGrayscale(0)
    expect(lut[0]).toBe(r)
    expect(lut[1]).toBe(g)
    expect(lut[2]).toBe(b)
  })

  it('entry 255 matches colormap(1)', () => {
    const lut = buildLut(interpolateGrayscale)
    const [r, g, b] = interpolateGrayscale(1)
    expect(lut[255 * 3]).toBe(r)
    expect(lut[255 * 3 + 1]).toBe(g)
    expect(lut[255 * 3 + 2]).toBe(b)
  })

  it('all values are valid bytes (0–255)', () => {
    const lut = buildLut(interpolateTurbo)
    for (const v of lut) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(255)
    }
  })

  it('works with a custom colormap', () => {
    const alwaysRed = () => [255, 0, 0] as [number, number, number]
    const lut = buildLut(alwaysRed)
    for (let i = 0; i < 256; i++) {
      expect(lut[i * 3]).toBe(255)
      expect(lut[i * 3 + 1]).toBe(0)
      expect(lut[i * 3 + 2]).toBe(0)
    }
  })
})

// ── normalizeValue ────────────────────────────────────────────────────────────

describe('normalizeValue', () => {
  describe('uint8 (0–100 range)', () => {
    it('maps 0 → 0', ()   => expect(normalizeValue(0,   'uint8')).toBe(0))
    it('maps 100 → 1', () => expect(normalizeValue(100, 'uint8')).toBe(1))
    it('maps 50 → 0.5', () => expect(normalizeValue(50, 'uint8')).toBe(0.5))
  })

  describe('float32 (0–100 range, same as uint8)', () => {
    it('maps 0 → 0',   () => expect(normalizeValue(0,   'float32')).toBe(0))
    it('maps 100 → 1', () => expect(normalizeValue(100, 'float32')).toBe(1))
    it('maps 50 → 0.5', () => expect(normalizeValue(50, 'float32')).toBe(0.5))
  })

  describe('uint16 (0–65535 range)', () => {
    it('maps 0 → 0',     () => expect(normalizeValue(0,     'uint16')).toBe(0))
    it('maps 65535 → 1', () => expect(normalizeValue(65535, 'uint16')).toBe(1))
    it('maps 32767.5 → ~0.5', () => {
      expect(normalizeValue(32767.5, 'uint16')).toBeCloseTo(0.5, 5)
    })
  })
})
