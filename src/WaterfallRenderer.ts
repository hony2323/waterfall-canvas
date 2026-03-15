import { buildLut, interpolateGrayscale, normalizeValue } from './colormap'
import type { BandHeader, ParsedFrame } from './types'

export interface WaterfallOptions {
  /** Number of history rows in the ring buffer (also sets canvas pixel height). Default: 400 */
  rowCount?: number
  /**
   * Colormap function: receives a normalized value t ∈ [0, 1] and returns [r, g, b] (0–255).
   * Defaults to grayscale. A 256-entry LUT is pre-computed at construction time.
   */
  colorMap?: (t: number) => [number, number, number]
  /**
   * Max width of the ring buffer in pixels. Input is downsampled to this width when
   * totalSamples exceeds it, keeping memory bounded.
   * Memory cost: bufferWidth × rowCount × 4 bytes.
   * Default: 4096 (~6 MB at rowCount=400). Set to 0 to use full input resolution.
   */
  bufferWidth?: number
  /**
   * Minimum number of ring-buffer pixels visible (= maximum zoom level).
   * Default: 32. Lower = more zoom possible.
   */
  minSpan?: number
  /**
   * Show a hover tooltip with band, frequency, time, and signal value.
   * Allocates an additional Float32Array (ringWidth × rowCount) for value storage.
   * Default: false.
   */
  tooltip?: boolean
  /**
   * Format the frequency shown in the tooltip. Receives the raw Hz value.
   * Default: hz => hz.toFixed(1)
   */
  freqFormat?: (hz: number) => string
  /**
   * Format the signal value shown in the tooltip. Receives normalized t ∈ [0, 1].
   * Default: t => (t * 100).toFixed(1) + '%'
   */
  valueFormat?: (t: number) => string
}

interface BandRange {
  start: number; end: number
  id: string; precision: string
  freqStart: number; freqEnd: number
}

export class WaterfallRenderer {
  /** Called from the rAF loop after each render. Assign freely — no re-render side effects. */
  onMetrics?: (pushMs: number, renderMs: number) => void
  /** Pixel height of each time-slice row. Higher = faster-looking waterfall. Default: 1 */
  rowHeight = 1

  private readonly canvas: HTMLCanvasElement
  private readonly rowCount: number
  private readonly bufferWidth: number
  private readonly lut: Uint8Array
  private readonly tooltipEnabled: boolean
  private readonly minSpan: number
  private readonly freqFormat: (hz: number) => string
  private readonly valueFormat: (t: number) => string

  private imgData: ImageData | null = null
  private viewImg: ImageData | null = null
  private ctx: CanvasRenderingContext2D | null = null

  // Optional tooltip buffers — only allocated when tooltip: true
  private valueBuffer: Float32Array | null = null   // normalized [0,1] per ring pixel
  private timeBuffer: Float64Array | null = null    // ms epoch per row
  private tooltipEl: HTMLDivElement | null = null

  private dirty = false
  private viewDirty = true
  private viewStart = 0
  private viewEnd = 0
  private ringWidth = 0
  private totalSamples = 0
  private bandRanges: BandRange[] = []
  private initialized = false
  private rafId = 0
  private pendingPushMs = -1

  private dragActive = false
  private lastDragX = 0
  private lastMouseEvent: MouseEvent | null = null   // kept for rAF tooltip refresh

  private readonly ro: ResizeObserver
  private readonly _boundLoop: FrameRequestCallback
  private readonly _boundWheel: (e: WheelEvent) => void
  private readonly _boundMouseDown: (e: MouseEvent) => void
  private readonly _boundMouseMove: (e: MouseEvent) => void
  private readonly _boundMouseUp: (e: MouseEvent) => void

  constructor(canvas: HTMLCanvasElement, options: WaterfallOptions = {}) {
    this.canvas         = canvas
    this.rowCount       = options.rowCount    ?? 400
    this.bufferWidth    = options.bufferWidth ?? 4096
    this.lut            = buildLut(options.colorMap ?? interpolateGrayscale)
    this.tooltipEnabled = options.tooltip     ?? false
    this.minSpan        = options.minSpan     ?? 32
    this.freqFormat     = options.freqFormat  ?? (hz => hz.toFixed(1))
    this.valueFormat    = options.valueFormat ?? (t  => (t * 100).toFixed(1) + '%')

    if (this.tooltipEnabled) {
      const el = document.createElement('div')
      el.style.cssText = [
        'position:fixed', 'display:none', 'pointer-events:none', 'z-index:9999',
        'background:rgba(0,0,0,0.82)', 'color:#e2e8f0', 'font:12px/1.6 monospace',
        'padding:6px 10px', 'border-radius:5px', 'border:1px solid rgba(255,255,255,0.12)',
        'white-space:pre', 'box-shadow:0 2px 8px rgba(0,0,0,0.5)',
      ].join(';')
      document.body.appendChild(el)
      this.tooltipEl = el
    }

    this._boundLoop      = this._loop.bind(this)
    this._boundWheel     = this._onWheel.bind(this)
    this._boundMouseDown = this._onMouseDown.bind(this)
    this._boundMouseMove = this._onMouseMove.bind(this)
    this._boundMouseUp   = this._onMouseUp.bind(this)

    this.ro = new ResizeObserver(() => {
      canvas.width = canvas.offsetWidth
      canvas.height = this.rowCount
      this.viewDirty = true
    })
    this.ro.observe(canvas)
    canvas.width  = canvas.offsetWidth || 800
    canvas.height = this.rowCount
    canvas.style.cursor = 'grab'

    canvas.addEventListener('wheel',      this._boundWheel,     { passive: false })
    canvas.addEventListener('mousedown',  this._boundMouseDown)
    canvas.addEventListener('mousemove',  this._boundMouseMove)
    canvas.addEventListener('mouseup',    this._boundMouseUp)
    canvas.addEventListener('mouseleave', this._boundMouseUp)

    this.rafId = requestAnimationFrame(this._boundLoop)
  }

  push(frame: ParsedFrame): void {
    if (!this.initialized) this._init(frame)
    const t0 = performance.now()
    this._pushRow(frame)
    this.pendingPushMs = performance.now() - t0
  }

  destroy(): void {
    cancelAnimationFrame(this.rafId)
    this.ro.disconnect()
    this.canvas.removeEventListener('wheel',      this._boundWheel)
    this.canvas.removeEventListener('mousedown',  this._boundMouseDown)
    this.canvas.removeEventListener('mousemove',  this._boundMouseMove)
    this.canvas.removeEventListener('mouseup',    this._boundMouseUp)
    this.canvas.removeEventListener('mouseleave', this._boundMouseUp)
    this.tooltipEl?.remove()
    this.imgData     = null
    this.viewImg     = null
    this.ctx         = null
    this.valueBuffer = null
    this.timeBuffer  = null
    this.tooltipEl   = null
    this.initialized = false
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private _bandSampleCount(band: BandHeader): number {
    if (band.precision === 'float32') return band.length / 4
    if (band.precision === 'uint16')  return band.length / 2
    return band.length
  }

  private _init(f: ParsedFrame): void {
    let total = 0
    this.bandRanges = []
    for (const band of f.header) {
      const count = this._bandSampleCount(band)
      this.bandRanges.push({
        start: total, end: total + count,
        id: band.band_id, precision: band.precision,
        freqStart: band.band_start, freqEnd: band.band_end,
      })
      total += count
    }
    this.totalSamples = total
    this.ringWidth    = this.bufferWidth > 0 ? Math.min(total, this.bufferWidth) : total

    const img = new ImageData(this.ringWidth, this.rowCount)
    new Uint32Array(img.data.buffer).fill(0xFF000000)
    this.imgData = img

    this.viewImg = new ImageData(this.canvas.width || 800, this.rowCount)
    this.ctx     = this.canvas.getContext('2d')!

    if (this.tooltipEnabled) {
      this.valueBuffer = new Float32Array(this.ringWidth * this.rowCount)
      this.timeBuffer  = new Float64Array(this.rowCount)
    }

    this.viewStart   = 0
    this.viewEnd     = this.ringWidth
    this.initialized = true
    this.dirty       = true
    this.viewDirty   = true
  }

  private _pushRow(f: ParsedFrame): void {
    const img   = this.imgData
    if (!img) return
    const ringW = this.ringWidth
    const total = this.totalSamples
    const rowH  = Math.max(1, this.rowHeight | 0)
    const buf   = img.data
    const lut   = this.lut

    buf.copyWithin(ringW * 4 * rowH, 0, ringW * (this.rowCount - rowH) * 4)

    if (this.timeBuffer) {
      this.timeBuffer.copyWithin(rowH, 0, this.rowCount - rowH)
      const ts = f.header[0]?.sent_at ?? Date.now()
      this.timeBuffer.fill(ts, 0, rowH)
    }
    if (this.valueBuffer) {
      this.valueBuffer.copyWithin(ringW * rowH, 0, ringW * (this.rowCount - rowH))
    }

    let px = 0
    if (ringW === total) {
      // Fast path: 1:1, no downsampling
      let vi = 0
      for (const band of f.header) {
        const samples   = f.bands[band.band_id]
        if (!samples) continue
        const precision = band.precision
        for (let i = 0; i < samples.length; i++) {
          const t = normalizeValue(samples[i], precision)
          if (this.valueBuffer) this.valueBuffer[vi] = t
          vi++
          const idx = Math.min(255, Math.max(0, Math.round(t * 255)))
          buf[px++] = lut[idx * 3]
          buf[px++] = lut[idx * 3 + 1]
          buf[px++] = lut[idx * 3 + 2]
          buf[px++] = 255
        }
      }
    } else {
      // Downsampled path: nearest-neighbour from input → ring buffer
      for (let x = 0; x < ringW; x++) {
        const srcX = (x * total / ringW) | 0
        let t = 0
        for (const range of this.bandRanges) {
          if (srcX < range.end) {
            t = normalizeValue(f.bands[range.id]![srcX - range.start], range.precision)
            break
          }
        }
        if (this.valueBuffer) this.valueBuffer[x] = t
        const idx = Math.min(255, Math.max(0, Math.round(t * 255)))
        buf[px++] = lut[idx * 3]
        buf[px++] = lut[idx * 3 + 1]
        buf[px++] = lut[idx * 3 + 2]
        buf[px++] = 255
      }
    }

    for (let row = 1; row < rowH; row++) {
      buf.copyWithin(row * ringW * 4, 0, ringW * 4)
      if (this.valueBuffer) this.valueBuffer.copyWithin(row * ringW, 0, ringW)
    }

    this.dirty = true
  }

  private _renderViewport(): void {
    const src   = this.imgData?.data
    const vData = this.viewImg
    if (!src || !vData) return

    const ringW = this.ringWidth
    const vs    = this.viewStart | 0
    const span  = (this.viewEnd | 0) - vs
    if (span <= 0) return

    const dst = vData.data
    const w   = vData.width
    const h   = this.rowCount

    for (let y = 0; y < h; y++) {
      const srcRow = y * ringW
      const dstRow = y * w
      for (let x = 0; x < w; x++) {
        const srcX = vs + (((x + 0.5) * span / w) | 0)
        const si = (srcRow + srcX) * 4
        const di = (dstRow + x) * 4
        dst[di]   = src[si]
        dst[di+1] = src[si+1]
        dst[di+2] = src[si+2]
        dst[di+3] = src[si+3]
      }
    }
  }

  private _loop(): void {
    const canvas = this.canvas
    const ctx    = this.ctx

    if (canvas.width > 0 && ctx && (this.dirty || this.viewDirty)) {
      if (!this.viewImg || this.viewImg.width !== canvas.width) {
        this.viewImg = new ImageData(canvas.width, this.rowCount)
      }

      const t0 = performance.now()
      this._renderViewport()
      ctx.putImageData(this.viewImg!, 0, 0)
      const renderMs = performance.now() - t0

      if (this.pendingPushMs >= 0) {
        this.onMetrics?.(this.pendingPushMs, renderMs)
        this.pendingPushMs = -1
      }

      if (this.lastMouseEvent) this._updateTooltip(this.lastMouseEvent)

      this.dirty     = false
      this.viewDirty = false
    }

    this.rafId = requestAnimationFrame(this._boundLoop)
  }

  private _updateTooltip(e: MouseEvent): void {
    const el          = this.tooltipEl
    const valueBuffer = this.valueBuffer
    const timeBuffer  = this.timeBuffer
    if (!el || !valueBuffer || !timeBuffer || !this.initialized) return

    const ringW  = this.ringWidth
    // Mirror _renderViewport: use integer-truncated view bounds
    const vs     = this.viewStart | 0
    const span   = (this.viewEnd | 0) - vs

    const rect       = this.canvas.getBoundingClientRect()
    const canvasFrac = (e.clientX - rect.left) / rect.width
    const rowFrac    = (e.clientY - rect.top)  / rect.height

    // Integer ring pixel — for value buffer lookup (matches what _renderViewport drew)
    const rx = Math.min(ringW - 1, Math.max(0, vs + (((canvasFrac + 0.5 / rect.width) * span) | 0)))
    const ry = Math.min(this.rowCount - 1, Math.max(0, (rowFrac * this.rowCount) | 0))

    // Continuous ring position → input sample, snapped to nearest sample
    // so freq is always an exact multiple of the band step
    const ringXf = vs + canvasFrac * span
    const srcXf  = ringW === this.totalSamples
      ? ringXf
      : ringXf * (this.totalSamples / ringW)
    const srcXc  = Math.max(0, Math.min(this.totalSamples - 1, Math.round(srcXf)))

    // Find band using continuous position; fall back to last band at right edge
    let band: BandRange = this.bandRanges[this.bandRanges.length - 1]
    for (const range of this.bandRanges) {
      if (srcXc < range.end) { band = range; break }
    }

    const level = valueBuffer[ry * ringW + rx]
    const ts      = timeBuffer[ry]
    const timeStr = ts > 0 ? new Date(ts).toISOString().slice(11, 23) + ' UTC' : '—'

    const offsetInBand = Math.max(0, srcXc - band.start)
    const bandSamples  = band.end - band.start
    const freq = band.freqStart + (offsetInBand / bandSamples) * (band.freqEnd - band.freqStart)
    const freqLine = `${band.id}  (${this.freqFormat(band.freqStart)} – ${this.freqFormat(band.freqEnd)})\nfreq:  ${this.freqFormat(freq)}\n`

    el.textContent = `${freqLine}time:  ${timeStr}\nvalue: ${this.valueFormat(level)}`
    el.style.display = 'block'

    // Position near cursor, nudge away from edges
    const pad = 16
    const tw  = el.offsetWidth  || 140
    const th  = el.offsetHeight || 80
    const left = e.clientX + 14 + tw > window.innerWidth  ? e.clientX - tw - 6 : e.clientX + 14
    const top  = e.clientY - 10 < pad                     ? e.clientY + 14      : e.clientY - 10
    el.style.left = `${Math.max(pad, Math.min(window.innerWidth  - tw  - pad, left))}px`
    el.style.top  = `${Math.max(pad, Math.min(window.innerHeight - th  - pad, top ))}px`
  }

  private _onWheel(e: WheelEvent): void {
    e.preventDefault()
    const ringW = this.ringWidth
    if (!ringW) return

    const span         = this.viewEnd - this.viewStart
    const factor       = e.deltaY > 0 ? 1.15 : 0.85
    const newSpan      = Math.max(this.minSpan, Math.min(ringW, span * factor))
    const cursorFrac   = e.offsetX / this.canvas.clientWidth
    const cursorSample = this.viewStart + cursorFrac * span

    let newStart = cursorSample - cursorFrac * newSpan
    let newEnd   = newStart + newSpan
    if (newStart < 0)     { newStart = 0;     newEnd   = newSpan }
    if (newEnd   > ringW) { newEnd   = ringW; newStart = ringW - newSpan }

    this.viewStart = Math.max(0, newStart)
    this.viewEnd   = Math.min(ringW, newEnd)
    this.viewDirty = true
  }

  private _onMouseDown(e: MouseEvent): void {
    this.dragActive          = true
    this.lastDragX           = e.clientX
    this.lastMouseEvent      = null
    this.canvas.style.cursor = 'grabbing'
    if (this.tooltipEl) this.tooltipEl.style.display = 'none'
  }

  private _onMouseMove(e: MouseEvent): void {
    if (this.dragActive) {
      const ringW = this.ringWidth
      if (!ringW) return
      const span = this.viewEnd - this.viewStart
      const dx   = ((e.clientX - this.lastDragX) / this.canvas.clientWidth) * span
      this.lastDragX = e.clientX

      let newStart = this.viewStart - dx
      let newEnd   = this.viewEnd   - dx
      if (newStart < 0)     { newEnd -= newStart;           newStart = 0 }
      if (newEnd   > ringW) { newStart -= (newEnd - ringW); newEnd   = ringW }

      this.viewStart = Math.max(0, newStart)
      this.viewEnd   = Math.min(ringW, newEnd)
      this.viewDirty = true
    } else {
      this.lastMouseEvent = e
      this._updateTooltip(e)
    }
  }

  private _onMouseUp(): void {
    this.dragActive          = false
    this.lastMouseEvent      = null
    this.canvas.style.cursor = 'grab'
    if (this.tooltipEl) this.tooltipEl.style.display = 'none'
  }
}
