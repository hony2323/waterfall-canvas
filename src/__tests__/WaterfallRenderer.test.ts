import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { WaterfallRenderer } from '../WaterfallRenderer'
import type { ParsedFrame } from '../types'

// ── helpers ──────────────────────────────────────────────────────────────────

function makeCanvas(width = 800): HTMLCanvasElement {
  const el = document.createElement('canvas')
  Object.defineProperty(el, 'offsetWidth',  { get: () => width, configurable: true })
  Object.defineProperty(el, 'clientWidth',  { get: () => width, configurable: true })
  Object.defineProperty(el, 'clientHeight', { get: () => 400,   configurable: true })
  return el
}

function makeFrame(size = 16, value = 50): ParsedFrame {
  return {
    header: [{
      band_id:    'band_0',
      band_start: 100e6,
      band_end:   200e6,
      timestamp:  new Date().toISOString(),
      sent_at:    Date.now(),
      length:     size,
      precision:  'uint8',
    }],
    bands: { band_0: new Uint8Array(size).fill(value) },
  }
}

function makeMultiBandFrame(sizes: number[]): ParsedFrame {
  const header = sizes.map((size, i) => ({
    band_id:    `band_${i}`,
    band_start: i * 100e6,
    band_end:   (i + 1) * 100e6,
    timestamp:  new Date().toISOString(),
    sent_at:    Date.now(),
    length:     size,
    precision:  'uint8' as const,
  }))
  const bands: ParsedFrame['bands'] = {}
  sizes.forEach((size, i) => {
    bands[`band_${i}`] = new Uint8Array(size).fill(i * 25)
  })
  return { header, bands }
}

// Reach into private fields for assertions
function priv(r: WaterfallRenderer): Record<string, unknown> {
  return r as unknown as Record<string, unknown>
}

// ── construction ──────────────────────────────────────────────────────────────

describe('WaterfallRenderer — construction', () => {
  let canvas: HTMLCanvasElement
  let renderer: WaterfallRenderer

  afterEach(() => renderer.destroy())

  it('constructs without throwing', () => {
    canvas = makeCanvas()
    expect(() => { renderer = new WaterfallRenderer(canvas) }).not.toThrow()
  })

  it('sets canvas dimensions on construct', () => {
    canvas = makeCanvas(640)
    renderer = new WaterfallRenderer(canvas, { rowCount: 200 })
    expect(canvas.width).toBe(640)
    expect(canvas.height).toBe(200)
  })

  it('sets canvas cursor to grab', () => {
    canvas = makeCanvas()
    renderer = new WaterfallRenderer(canvas)
    expect(canvas.style.cursor).toBe('grab')
  })

  it('creates tooltip element in DOM when tooltip=true', () => {
    canvas = makeCanvas()
    renderer = new WaterfallRenderer(canvas, { tooltip: true })
    expect(document.body.querySelector('div')).not.toBeNull()
  })

  it('does not create tooltip element when tooltip=false', () => {
    canvas = makeCanvas()
    // Ensure clean body
    document.body.innerHTML = ''
    renderer = new WaterfallRenderer(canvas, { tooltip: false })
    expect(document.body.querySelector('div')).toBeNull()
  })

  it('applies custom minSpan option', () => {
    canvas = makeCanvas()
    renderer = new WaterfallRenderer(canvas, { minSpan: 64 })
    expect(priv(renderer).minSpan).toBe(64)
  })
})

// ── destroy ───────────────────────────────────────────────────────────────────

describe('WaterfallRenderer — destroy', () => {
  it('clears internal buffers', () => {
    const canvas = makeCanvas()
    const renderer = new WaterfallRenderer(canvas, { tooltip: true })
    renderer.push(makeFrame())
    renderer.destroy()
    expect(priv(renderer).imgData).toBeNull()
    expect(priv(renderer).viewImg).toBeNull()
    expect(priv(renderer).valueBuffer).toBeNull()
    expect(priv(renderer).timeBuffer).toBeNull()
  })

  it('removes tooltip element from DOM', () => {
    document.body.innerHTML = ''
    const canvas = makeCanvas()
    const renderer = new WaterfallRenderer(canvas, { tooltip: true })
    expect(document.body.querySelector('div')).not.toBeNull()
    renderer.destroy()
    expect(document.body.querySelector('div')).toBeNull()
  })

  it('sets initialized to false', () => {
    const canvas = makeCanvas()
    const renderer = new WaterfallRenderer(canvas)
    renderer.push(makeFrame())
    expect(priv(renderer).initialized).toBe(true)
    renderer.destroy()
    expect(priv(renderer).initialized).toBe(false)
  })
})

// ── push / init ───────────────────────────────────────────────────────────────

describe('WaterfallRenderer — push', () => {
  let canvas: HTMLCanvasElement
  let renderer: WaterfallRenderer

  beforeEach(() => { canvas = makeCanvas() })
  afterEach(() => renderer.destroy())

  it('is not initialized before first push', () => {
    renderer = new WaterfallRenderer(canvas)
    expect(priv(renderer).initialized).toBe(false)
  })

  it('initializes on first push', () => {
    renderer = new WaterfallRenderer(canvas)
    renderer.push(makeFrame(16))
    expect(priv(renderer).initialized).toBe(true)
  })

  it('allocates imgData ring buffer after first push', () => {
    renderer = new WaterfallRenderer(canvas)
    renderer.push(makeFrame(16))
    expect(priv(renderer).imgData).not.toBeNull()
  })

  it('sets ringWidth = totalSamples when bufferWidth=0', () => {
    renderer = new WaterfallRenderer(canvas, { bufferWidth: 0 })
    renderer.push(makeFrame(100))
    expect(priv(renderer).ringWidth).toBe(100)
    expect(priv(renderer).totalSamples).toBe(100)
  })

  it('sets ringWidth = bufferWidth when totalSamples > bufferWidth', () => {
    renderer = new WaterfallRenderer(canvas, { bufferWidth: 8 })
    renderer.push(makeFrame(100))
    expect(priv(renderer).ringWidth).toBe(8)
    expect(priv(renderer).totalSamples).toBe(100)
  })

  it('sets viewStart=0 and viewEnd=ringWidth after init', () => {
    renderer = new WaterfallRenderer(canvas, { bufferWidth: 0 })
    renderer.push(makeFrame(64))
    expect(priv(renderer).viewStart).toBe(0)
    expect(priv(renderer).viewEnd).toBe(64)
  })

  it('marks dirty after push', () => {
    renderer = new WaterfallRenderer(canvas)
    renderer.push(makeFrame())
    expect(priv(renderer).dirty).toBe(true)
  })

  it('handles multiple pushes without throwing', () => {
    renderer = new WaterfallRenderer(canvas)
    expect(() => {
      for (let i = 0; i < 10; i++) renderer.push(makeFrame())
    }).not.toThrow()
  })

  it('sums band sizes for totalSamples (multi-band)', () => {
    renderer = new WaterfallRenderer(canvas, { bufferWidth: 0 })
    renderer.push(makeMultiBandFrame([32, 48]))
    expect(priv(renderer).totalSamples).toBe(80)
  })

  it('allocates valueBuffer only when tooltip=true', () => {
    renderer = new WaterfallRenderer(canvas, { tooltip: true })
    renderer.push(makeFrame())
    expect(priv(renderer).valueBuffer).toBeInstanceOf(Float32Array)
  })

  it('always allocates valueBuffer (needed for live sensitivity/gamma re-render)', () => {
    renderer = new WaterfallRenderer(canvas, { tooltip: false })
    renderer.push(makeFrame())
    expect(priv(renderer).valueBuffer).toBeInstanceOf(Float32Array)
  })

  it('allocates timeBuffer when timeBar=true', () => {
    renderer = new WaterfallRenderer(canvas, { timeBar: true })
    renderer.push(makeFrame())
    expect(priv(renderer).timeBuffer).toBeInstanceOf(Float64Array)
  })

  it('stores sent_at in timeBuffer at headRow', () => {
    renderer = new WaterfallRenderer(canvas, { timeBar: true })
    const frame = makeFrame()
    const sentAt = frame.header[0].sent_at
    renderer.push(frame)
    const p = priv(renderer)
    const tb = p.timeBuffer as Float64Array
    expect(tb[p.headRow as number]).toBe(sentAt)
  })
})

// ── band ranges ───────────────────────────────────────────────────────────────

describe('WaterfallRenderer — band range mapping', () => {
  it('records correct freqStart/freqEnd per band', () => {
    const canvas = makeCanvas()
    const renderer = new WaterfallRenderer(canvas, { bufferWidth: 0 })
    renderer.push(makeMultiBandFrame([10, 20]))
    const ranges = priv(renderer).bandRanges as Array<{
      start: number; end: number; freqStart: number; freqEnd: number; id: string
    }>
    expect(ranges[0]).toMatchObject({ start: 0,  end: 10, freqStart: 0,     freqEnd: 100e6 })
    expect(ranges[1]).toMatchObject({ start: 10, end: 30, freqStart: 100e6, freqEnd: 200e6 })
    renderer.destroy()
  })
})

// ── zoom (wheel) ──────────────────────────────────────────────────────────────

describe('WaterfallRenderer — zoom', () => {
  let canvas: HTMLCanvasElement
  let renderer: WaterfallRenderer

  beforeEach(() => {
    canvas = makeCanvas(800)
    renderer = new WaterfallRenderer(canvas, { bufferWidth: 0, minSpan: 32 })
    renderer.push(makeFrame(1024))
  })
  afterEach(() => renderer.destroy())

  function wheel(deltaY: number, offsetX = 400) {
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true,
      clientX: offsetX, screenX: offsetX }))
  }

  it('zoom in (scroll up) reduces visible span', () => {
    const before = (priv(renderer).viewEnd as number) - (priv(renderer).viewStart as number)
    wheel(-100)
    const after = (priv(renderer).viewEnd as number) - (priv(renderer).viewStart as number)
    expect(after).toBeLessThan(before)
  })

  it('zoom out (scroll down) increases visible span', () => {
    // First zoom in so there's room to zoom out
    wheel(-100); wheel(-100); wheel(-100)
    const before = (priv(renderer).viewEnd as number) - (priv(renderer).viewStart as number)
    wheel(100)
    const after = (priv(renderer).viewEnd as number) - (priv(renderer).viewStart as number)
    expect(after).toBeGreaterThan(before)
  })

  it('span never drops below minSpan', () => {
    for (let i = 0; i < 50; i++) wheel(-100)
    const span = (priv(renderer).viewEnd as number) - (priv(renderer).viewStart as number)
    expect(span).toBeGreaterThanOrEqual(32)
  })

  it('span never exceeds ringWidth', () => {
    for (let i = 0; i < 50; i++) wheel(100)
    const span = (priv(renderer).viewEnd as number) - (priv(renderer).viewStart as number)
    expect(span).toBeLessThanOrEqual(priv(renderer).ringWidth as number)
  })

  it('viewStart never goes below 0', () => {
    for (let i = 0; i < 20; i++) wheel(-100, 0)  // zoom toward left edge
    expect(priv(renderer).viewStart).toBeGreaterThanOrEqual(0)
  })

  it('viewEnd never exceeds ringWidth', () => {
    for (let i = 0; i < 20; i++) wheel(-100, 800)  // zoom toward right edge
    expect(priv(renderer).viewEnd).toBeLessThanOrEqual(priv(renderer).ringWidth as number)
  })

  it('marks viewDirty after zoom', () => {
    ;(priv(renderer) as Record<string, unknown>).viewDirty = false
    wheel(100)
    expect(priv(renderer).viewDirty).toBe(true)
  })
})

// ── pan (drag) ────────────────────────────────────────────────────────────────

describe('WaterfallRenderer — pan', () => {
  let canvas: HTMLCanvasElement
  let renderer: WaterfallRenderer

  beforeEach(() => {
    canvas = makeCanvas(800)
    renderer = new WaterfallRenderer(canvas, { bufferWidth: 0, minSpan: 32 })
    renderer.push(makeFrame(1024))
    // Zoom in so there's room to pan
    for (let i = 0; i < 5; i++) {
      canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }))
    }
  })
  afterEach(() => renderer.destroy())

  it('changes cursor to grabbing on mousedown', () => {
    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 400, bubbles: true }))
    expect(canvas.style.cursor).toBe('grabbing')
  })

  it('restores cursor to grab on mouseup', () => {
    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 400, bubbles: true }))
    canvas.dispatchEvent(new MouseEvent('mouseup',   { clientX: 400, bubbles: true }))
    expect(canvas.style.cursor).toBe('grab')
  })

  it('panning right shifts view rightward', () => {
    const startBefore = priv(renderer).viewStart as number
    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 500, bubbles: true }))
    canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 400, bubbles: true }))
    canvas.dispatchEvent(new MouseEvent('mouseup',   { clientX: 400, bubbles: true }))
    expect(priv(renderer).viewStart as number).toBeGreaterThan(startBefore)
  })

  it('panning left shifts view leftward', () => {
    // Pan right first, then left
    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 200, bubbles: true }))
    canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 0,   bubbles: true }))
    canvas.dispatchEvent(new MouseEvent('mouseup',   { clientX: 0,   bubbles: true }))
    const startAfterRight = priv(renderer).viewStart as number

    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 0,   bubbles: true }))
    canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 200, bubbles: true }))
    canvas.dispatchEvent(new MouseEvent('mouseup',   { clientX: 200, bubbles: true }))
    expect(priv(renderer).viewStart as number).toBeLessThan(startAfterRight)
  })

  it('viewStart never goes below 0 after pan', () => {
    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 400, bubbles: true }))
    canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 9999, bubbles: true }))
    canvas.dispatchEvent(new MouseEvent('mouseup',   {               bubbles: true }))
    expect(priv(renderer).viewStart as number).toBeGreaterThanOrEqual(0)
  })

  it('viewEnd never exceeds ringWidth after pan', () => {
    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 400,  bubbles: true }))
    canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: -9999, bubbles: true }))
    canvas.dispatchEvent(new MouseEvent('mouseup',   {                 bubbles: true }))
    expect(priv(renderer).viewEnd as number)
      .toBeLessThanOrEqual(priv(renderer).ringWidth as number)
  })

  it('span is preserved after pan', () => {
    const spanBefore = (priv(renderer).viewEnd as number) - (priv(renderer).viewStart as number)
    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 400, bubbles: true }))
    canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 300, bubbles: true }))
    canvas.dispatchEvent(new MouseEvent('mouseup',   {               bubbles: true }))
    const spanAfter = (priv(renderer).viewEnd as number) - (priv(renderer).viewStart as number)
    expect(spanAfter).toBeCloseTo(spanBefore, 5)
  })
})

// ── rowHeight ─────────────────────────────────────────────────────────────────

describe('WaterfallRenderer — rowHeight', () => {
  it('can be set after construction', () => {
    const canvas = makeCanvas()
    const renderer = new WaterfallRenderer(canvas)
    renderer.rowHeight = 3
    expect(renderer.rowHeight).toBe(3)
    renderer.destroy()
  })
})

// ── ring cursor / row ordering ────────────────────────────────────────────────
//
// rowCount=4 so wraparound happens after 4 pushes.
// After 6 pushes the physical layout is:
//   row 0 → push 4 (value=40)   row 2 → push 6 (value=60) ← headRow
//   row 1 → push 3 (value=30)   row 3 → push 5 (value=50)

describe('WaterfallRenderer — ring cursor / row ordering', () => {
  const ROW_COUNT = 4

  it('headRow advances backward and wraps correctly', () => {
    const renderer = new WaterfallRenderer(makeCanvas(), { rowCount: ROW_COUNT, bufferWidth: 0 })
    renderer.push(makeFrame(1))  // 0 → 3
    expect(priv(renderer).headRow).toBe(3)
    renderer.push(makeFrame(1))  // 3 → 2
    expect(priv(renderer).headRow).toBe(2)
    renderer.push(makeFrame(1))  // 2 → 1
    renderer.push(makeFrame(1))  // 1 → 0  (full cycle)
    renderer.push(makeFrame(1))  // 0 → 3  (wraparound)
    expect(priv(renderer).headRow).toBe(3)
    renderer.destroy()
  })

  it('physical row at headRow holds the most recent push pixel', () => {
    const renderer = new WaterfallRenderer(makeCanvas(), { rowCount: ROW_COUNT, bufferWidth: 0 })
    for (let i = 1; i <= 6; i++) renderer.push(makeFrame(1, i * 10))

    const p       = priv(renderer)
    const img     = p.imgData as ImageData
    const head    = p.headRow as number
    const ringW   = p.ringWidth as number

    // value=60 → t=60/255 → LUT index=round(60/255×255)=60
    expect(img.data[head * ringW * 4]).toBe(Math.round(60 / 255 * 255))
    // second-newest (value=50 → 50) sits at next physical row
    expect(img.data[((head + 1) % ROW_COUNT) * ringW * 4]).toBe(Math.round(50 / 255 * 255))

    renderer.destroy()
  })

  it('getOrdered (export) maps logical rows to correct physical rows after wraparound', () => {
    const renderer = new WaterfallRenderer(makeCanvas(), { rowCount: ROW_COUNT, bufferWidth: 0 })
    for (let i = 1; i <= 6; i++) renderer.push(makeFrame(1, i * 10))

    const p     = priv(renderer)
    const img   = p.imgData as ImageData
    const head  = p.headRow as number
    const ringW = p.ringWidth as number
    const rc    = ROW_COUNT

    // Replicate the getOrdered() logic used by exportImage
    const ordered = new Uint8ClampedArray(ringW * rc * 4)
    for (let y = 0; y < rc; y++) {
      const physRow = (head + y) % rc
      ordered.set(img.data.subarray(physRow * ringW * 4, (physRow + 1) * ringW * 4), y * ringW * 4)
    }

    // Logical row 0 = newest (push 6, value=60 → 60)
    expect(ordered[0 * ringW * 4]).toBe(Math.round(60 / 255 * 255))
    // Logical row 1 = push 5 (value=50 → 50)
    expect(ordered[1 * ringW * 4]).toBe(Math.round(50 / 255 * 255))
    // Logical row 2 = push 4 (value=40 → 40)
    expect(ordered[2 * ringW * 4]).toBe(Math.round(40 / 255 * 255))
    // Logical row 3 = oldest surviving (push 3, value=30 → 30)
    expect(ordered[3 * ringW * 4]).toBe(Math.round(30 / 255 * 255))

    renderer.destroy()
  })
})

// ── valueBuffer / timeBuffer after wraparound ─────────────────────────────────

describe('WaterfallRenderer — buffers after wraparound', () => {
  const ROW_COUNT = 4

  it('valueBuffer at headRow×ringWidth holds the most recent normalized value', () => {
    const renderer = new WaterfallRenderer(makeCanvas(), { rowCount: ROW_COUNT, bufferWidth: 0, tooltip: true })
    for (let i = 1; i <= 6; i++) renderer.push(makeFrame(1, i * 10))

    const p    = priv(renderer)
    const vb   = p.valueBuffer as Float32Array
    const head = p.headRow as number
    const ringW = p.ringWidth as number

    expect(vb[head * ringW]).toBeCloseTo(60 / 255, 3)                              // push 6
    expect(vb[((head + 1) % ROW_COUNT) * ringW]).toBeCloseTo(50 / 255, 3)         // push 5

    renderer.destroy()
  })

  it('timeBuffer at headRow holds the most recent sent_at after wraparound', () => {
    const renderer = new WaterfallRenderer(makeCanvas(), { rowCount: ROW_COUNT, bufferWidth: 0, timeBar: true })
    for (let i = 1; i <= 6; i++) {
      const frame = makeFrame(1)
      frame.header[0].sent_at = i * 1000
      renderer.push(frame)
    }

    const p    = priv(renderer)
    const tb   = p.timeBuffer as Float64Array
    const head = p.headRow as number

    expect(tb[head]).toBe(6000)                          // most recent
    expect(tb[(head + 1) % ROW_COUNT]).toBe(5000)        // second most recent

    renderer.destroy()
  })
})

// ── isLazy boundary ───────────────────────────────────────────────────────────

describe('WaterfallRenderer — isLazy boundary', () => {
  // Force _loop to run synchronously so onMetrics is called immediately.
  function runLoop(r: WaterfallRenderer) {
    (r as unknown as { _loop(): void })._loop()
  }

  it('reports isLazy=false when span/canvasWidth <= lazyThreshold', () => {
    const canvas = makeCanvas(100)
    const renderer = new WaterfallRenderer(canvas, { bufferWidth: 0, tooltip: true, lazyThreshold: 4 })
    const metrics = vi.fn()
    renderer.onMetrics = metrics
    renderer.push(makeFrame(200))   // span=200, ratio=2 ≤ 4
    runLoop(renderer)
    expect(metrics).toHaveBeenCalledWith(expect.any(Number), expect.any(Number), false)
    renderer.destroy()
  })

  it('reports isLazy=true when span/canvasWidth > lazyThreshold', () => {
    const canvas = makeCanvas(100)
    const renderer = new WaterfallRenderer(canvas, { bufferWidth: 0, tooltip: true, lazyThreshold: 4 })
    const metrics = vi.fn()
    renderer.onMetrics = metrics
    renderer.push(makeFrame(1000))  // span=1000, ratio=10 > 4
    runLoop(renderer)
    expect(metrics).toHaveBeenCalledWith(expect.any(Number), expect.any(Number), true)
    renderer.destroy()
  })

  it('reports isLazy=true when zoom ratio exceeds lazyThreshold (regardless of tooltip setting)', () => {
    const canvas = makeCanvas(100)
    const renderer = new WaterfallRenderer(canvas, { bufferWidth: 0, tooltip: false, lazyThreshold: 4 })
    const metrics = vi.fn()
    renderer.onMetrics = metrics
    renderer.push(makeFrame(1000))  // ratio=10 > 4, valueBuffer always allocated now
    runLoop(renderer)
    expect(metrics).toHaveBeenCalledWith(expect.any(Number), expect.any(Number), true)
    renderer.destroy()
  })

  it('isLazy flips at the exact threshold boundary', () => {
    // span == canvasWidth * lazyThreshold is NOT lazy (strictly greater required)
    const canvas = makeCanvas(100)
    const renderer = new WaterfallRenderer(canvas, { bufferWidth: 0, tooltip: true, lazyThreshold: 4 })
    const metrics = vi.fn()
    renderer.onMetrics = metrics
    renderer.push(makeFrame(400))   // span=400, ratio=4 — exactly at threshold, not lazy
    runLoop(renderer)
    expect(metrics).toHaveBeenCalledWith(expect.any(Number), expect.any(Number), false)
    renderer.destroy()
  })
})
