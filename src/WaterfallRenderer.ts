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
  /**
   * Show a time axis on the left edge of the canvas with time-ago labels.
   * Reads from the same timeBuffer as the tooltip (allocated when either is true).
   * Default: false.
   */
  timeBar?: boolean
  /**
   * When true, the time-ago labels in the time bar update live every rAF tick.
   * When false (default), labels only update when new data arrives — no jumping.
   */
  timeBarDynamic?: boolean
  /**
   * Source-pixels-per-output-pixel ratio above which the per-pixel max-value scan
   * is skipped (center-pixel sampling instead). Kicks in only when significantly
   * zoomed out, where the scan is expensive and spikes are sub-pixel anyway.
   * Default: 4. Set to Infinity to always preserve spikes.
   */
  lazyThreshold?: number
}

export interface ExportImageOptions {
  /**
   * Image format.
   * - `'bmp'` — uncompressed, single file, no size limit (default)
   * - `'png'` — compressed, tiled into multiple files if width > 32,767px
   */
  format?: 'bmp' | 'png'
  /** Base filename without extension. Default: `'waterfall'` */
  filename?: string
}

interface BandRange {
  start: number; end: number
  id: string; precision: string
  freqStart: number; freqEnd: number
}

export class WaterfallRenderer {
  /** Called from the rAF loop after each render. Assign freely — no re-render side effects. */
  onMetrics?: (pushMs: number, renderMs: number, isLazy: boolean) => void
  /** Pixel height of each time-slice row. Higher = faster-looking waterfall. Default: 1 */
  rowHeight = 1

  private readonly canvas: HTMLCanvasElement
  private readonly rowCount: number
  private readonly bufferWidth: number
  private readonly lut: Uint8Array
  private readonly tooltipEnabled: boolean
  private readonly timeBarEnabled: boolean
  private readonly timeBarDynamic: boolean
  private readonly minSpan: number
  private readonly lazyThreshold: number
  private readonly freqFormat: (hz: number) => string
  private readonly valueFormat: (t: number) => string

  private timeBarNow = 0  // snapshot of Date.now() taken at each push

  private imgData: ImageData | null = null
  private viewImg: ImageData | null = null
  private ctx: CanvasRenderingContext2D | null = null

  // Optional buffers — allocated when tooltip or timeBar is true
  private valueBuffer: Float32Array | null = null   // normalized [0,1] per ring pixel
  private timeBuffer: Float64Array | null = null    // ms epoch per row
  private tooltipEl: HTMLDivElement | null = null

  // Ring cursor: headRow is the physical row index of the most-recently-written row
  private headRow = 0

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
  private lastMouseEvent: MouseEvent | null = null

  private readonly ro: ResizeObserver
  private readonly _boundLoop: FrameRequestCallback
  private readonly _boundWheel: (e: WheelEvent) => void
  private readonly _boundMouseDown: (e: MouseEvent) => void
  private readonly _boundMouseMove: (e: MouseEvent) => void
  private readonly _boundMouseUp: (e: MouseEvent) => void

  constructor(canvas: HTMLCanvasElement, options: WaterfallOptions = {}) {
    this.canvas         = canvas
    this.rowCount       = options.rowCount       ?? 400
    this.bufferWidth    = options.bufferWidth    ?? 4096
    this.lut            = buildLut(options.colorMap ?? interpolateGrayscale)
    this.tooltipEnabled = options.tooltip        ?? false
    this.timeBarEnabled = options.timeBar        ?? false
    this.timeBarDynamic = options.timeBarDynamic ?? false
    this.minSpan        = options.minSpan        ?? 32
    this.lazyThreshold  = options.lazyThreshold  ?? 4
    this.freqFormat     = options.freqFormat     ?? (hz => hz.toFixed(1))
    this.valueFormat    = options.valueFormat    ?? (t  => (t * 100).toFixed(1) + '%')

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
      canvas.width  = canvas.offsetWidth
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

  /**
   * Download the full ring buffer as an image file.
   * BMP is uncompressed and has no size limit; PNG is tiled when width > 32,767px.
   */
  exportImage(options: ExportImageOptions = {}): void {
    const img = this.imgData
    if (!img) return
    const { format = 'bmp', filename = 'waterfall' } = options

    // Compose a logically-ordered copy (ring cursor means physical rows are not in order)
    const getOrdered = (): ImageData => {
      const ringW   = this.ringWidth
      const rc      = this.rowCount
      const ordered = new Uint8ClampedArray(ringW * rc * 4)
      for (let y = 0; y < rc; y++) {
        const physRow = (this.headRow + y) % rc
        const src     = physRow * ringW * 4
        ordered.set(img.data.subarray(src, src + ringW * 4), y * ringW * 4)
      }
      return new ImageData(ordered, ringW, rc)
    }

    if (format === 'bmp') {
      setTimeout(() => this._triggerDownload(this._encodeBmp(getOrdered()), `${filename}.bmp`), 0)
      return
    }

    // PNG: tile into 30,000px-wide chunks to stay under Chrome's 32,767px limit
    const ordered  = getOrdered()
    const totalW   = ordered.width
    const h        = ordered.height
    const tileW    = 30000
    const numTiles = Math.ceil(totalW / tileW)

    for (let t = 0; t < numTiles; t++) {
      const x0       = t * tileW
      const w        = Math.min(tileW, totalW - x0)
      const tileData = new Uint8ClampedArray(w * h * 4)
      for (let row = 0; row < h; row++) {
        const src = (row * totalW + x0) * 4
        tileData.set(ordered.data.subarray(src, src + w * 4), row * w * 4)
      }
      const c = document.createElement('canvas')
      c.width  = w
      c.height = h
      c.getContext('2d')!.putImageData(new ImageData(tileData, w, h), 0, 0)
      const name = numTiles > 1 ? `${filename}_${t + 1}of${numTiles}.png` : `${filename}.png`
      setTimeout(() => {
        c.toBlob(blob => { if (blob) this._triggerDownload(blob, name) }, 'image/png')
      }, t * 300)
    }
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

    this.ctx = this.canvas.getContext('2d')!

    if (this.tooltipEnabled) {
      this.valueBuffer = new Float32Array(this.ringWidth * this.rowCount)
    }
    if (this.tooltipEnabled || this.timeBarEnabled) {
      this.timeBuffer = new Float64Array(this.rowCount)
    }

    this.headRow     = 0
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
    const rc    = this.rowCount
    const buf   = img.data
    const lut   = this.lut

    // Advance ring cursor — new row goes at logical top, no bulk copy needed
    this.headRow = (this.headRow - rowH + rc) % rc
    const head   = this.headRow

    // Write new row at physical position `head`
    let px = head * ringW * 4

    if (ringW === total) {
      // Fast path: 1:1, no downsampling
      let vi = head * ringW
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
        if (this.valueBuffer) this.valueBuffer[head * ringW + x] = t
        const idx = Math.min(255, Math.max(0, Math.round(t * 255)))
        buf[px++] = lut[idx * 3]
        buf[px++] = lut[idx * 3 + 1]
        buf[px++] = lut[idx * 3 + 2]
        buf[px++] = 255
      }
    }

    // For rowH > 1: copy the new row to adjacent physical rows (only ringW pixels each)
    const src0 = head * ringW * 4
    for (let row = 1; row < rowH; row++) {
      const physRow = (head + row) % rc
      buf.copyWithin(physRow * ringW * 4, src0, src0 + ringW * 4)
      if (this.valueBuffer) {
        this.valueBuffer.copyWithin(physRow * ringW, head * ringW, head * ringW + ringW)
      }
    }

    if (this.timeBuffer) {
      const ts = f.header[0]?.sent_at ?? Date.now()
      for (let row = 0; row < rowH; row++) {
        this.timeBuffer[(head + row) % rc] = ts
      }
      this.timeBarNow = Date.now()
    }

    this.dirty = true
  }

  private _renderViewport(): void {
    const src   = this.imgData?.data
    const vData = this.viewImg
    if (!src || !vData) return

    const ringW = this.ringWidth
    const rc    = this.rowCount
    const vs    = this.viewStart | 0
    const span  = (this.viewEnd | 0) - vs
    if (span <= 0) return

    const dst  = vData.data
    const w    = vData.width
    const head = this.headRow

    for (let y = 0; y < rc; y++) {
      const physRow = (head + y) % rc
      const srcRow  = physRow * ringW
      const dstRow  = y * w
      const vRow    = this.valueBuffer ? physRow * ringW : -1
      for (let x = 0; x < w; x++) {
        const x0 = vs + ((x       * span / w) | 0)
        const x1 = Math.min(ringW, vs + (((x + 1) * span / w) | 0))
        let srcX = vs + (((x + 0.5) * span / w) | 0)
        if (vRow >= 0 && x1 > x0 + 1 && x1 - x0 <= this.lazyThreshold) {
          // Precise: max-value scan — preserves every spike
          let bestVal = -1
          for (let sx = x0; sx < x1; sx++) {
            const v = this.valueBuffer![vRow + sx]
            if (v > bestVal) { bestVal = v; srcX = sx }
          }
        } else if (vRow >= 0 && x1 > x0 + 1) {
          // Lazy: max over strided grid points only (multiples of lazyThreshold).
          // Grid positions are absolute in the buffer — zoom-invariant — so the
          // same source frequencies are always candidates regardless of zoom level.
          const stride    = this.lazyThreshold
          const firstGrid = Math.ceil(x0 / stride) * stride
          if (firstGrid < x1) {
            let bestVal = -1
            for (let sx = firstGrid; sx < x1; sx += stride) {
              const v = this.valueBuffer![vRow + sx]
              if (v > bestVal) { bestVal = v; srcX = sx }
            }
          }
        }
        const si = (srcRow + srcX) * 4
        const di = (dstRow + x) * 4
        dst[di]   = src[si]
        dst[di+1] = src[si+1]
        dst[di+2] = src[si+2]
        dst[di+3] = src[si+3]
      }
    }
  }

  private _drawTimeBar(): void {
    const ctx = this.ctx
    const tb  = this.timeBuffer
    if (!ctx || !tb || !this.initialized) return

    const barW = 76
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.fillRect(0, 0, barW, this.rowCount)

    ctx.font         = '11px monospace'
    ctx.fillStyle    = 'rgba(200,210,220,0.9)'
    ctx.textBaseline = 'middle'

    // Newest row is at headRow in the physical buffer
    const newestTs = tb[this.headRow]
    if (newestTs <= 0) return

    // Estimate ms-per-row from physical buffer
    const sampleRows = Math.min(this.rowCount - 1, 20)
    const olderPhys  = (this.headRow + sampleRows) % this.rowCount
    const rowIntervalMs = sampleRows > 0 && tb[olderPhys] > 0
      ? (newestTs - tb[olderPhys]) / sampleRows
      : 0

    const now           = this.timeBarDynamic ? Date.now() : this.timeBarNow
    const elapsedNewest = now - newestTs
    const step          = 50

    for (let y = 0; y < this.rowCount; y += step) {
      const diffMs = elapsedNewest + y * rowIntervalMs
      const diffS  = diffMs / 1000
      let label: string
      if (diffS < 60)        label = `${diffS.toFixed(1)}s ago`
      else if (diffS < 3600) label = `${(diffS / 60).toFixed(1)}m ago`
      else                   label = `${(diffS / 3600).toFixed(1)}h ago`
      ctx.fillText(label, 4, y + step / 2)
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
      if (this.timeBarEnabled) this._drawTimeBar()
      const renderMs = performance.now() - t0

      if (this.pendingPushMs >= 0) {
        const span   = this.viewEnd - this.viewStart
        const isLazy = !!this.valueBuffer && span / (canvas.width || 1) > this.lazyThreshold
        this.onMetrics?.(this.pendingPushMs, renderMs, isLazy)
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

    const ringW = this.ringWidth
    const vs    = this.viewStart | 0
    const span  = (this.viewEnd | 0) - vs

    const rect       = this.canvas.getBoundingClientRect()
    const canvasFrac = (e.clientX - rect.left) / rect.width
    const rowFrac    = (e.clientY - rect.top)  / rect.height

    const rx      = Math.min(ringW - 1, Math.max(0, vs + (((canvasFrac + 0.5 / rect.width) * span) | 0)))
    const logicRy = Math.min(this.rowCount - 1, Math.max(0, (rowFrac * this.rowCount) | 0))
    const physRy  = (this.headRow + logicRy) % this.rowCount

    const ringXf = vs + canvasFrac * span
    const srcXf  = ringW === this.totalSamples
      ? ringXf
      : ringXf * (this.totalSamples / ringW)
    const srcXc  = Math.max(0, Math.min(this.totalSamples - 1, Math.round(srcXf)))

    let band: BandRange = this.bandRanges[this.bandRanges.length - 1]
    for (const range of this.bandRanges) {
      if (srcXc < range.end) { band = range; break }
    }

    const level   = valueBuffer[physRy * ringW + rx]
    const ts      = timeBuffer[physRy]
    const timeStr = ts > 0 ? new Date(ts).toISOString().slice(11, 23) + ' UTC' : '—'

    const offsetInBand = Math.max(0, srcXc - band.start)
    const bandSamples  = band.end - band.start
    const freq         = band.freqStart + (offsetInBand / bandSamples) * (band.freqEnd - band.freqStart)
    const freqLine     = `${band.id}  (${this.freqFormat(band.freqStart)} – ${this.freqFormat(band.freqEnd)})\nfreq:  ${this.freqFormat(freq)}\n`

    el.textContent   = `${freqLine}time:  ${timeStr}\nvalue: ${this.valueFormat(level)}`
    el.style.display = 'block'

    const pad  = 16
    const tw   = el.offsetWidth  || 140
    const th   = el.offsetHeight || 80
    const left = e.clientX + 14 + tw > window.innerWidth  ? e.clientX - tw - 6 : e.clientX + 14
    const top  = e.clientY - 10 < pad                     ? e.clientY + 14      : e.clientY - 10
    el.style.left = `${Math.max(pad, Math.min(window.innerWidth  - tw  - pad, left))}px`
    el.style.top  = `${Math.max(pad, Math.min(window.innerHeight - th  - pad, top ))}px`
  }

  private _encodeBmp(img: ImageData): Blob {
    const w              = img.width
    const h              = img.height
    const src            = img.data
    const rowBytes       = w * 3
    const padding        = (4 - (rowBytes % 4)) % 4
    const paddedRowBytes = rowBytes + padding
    const pixelDataSize  = paddedRowBytes * h
    const buf            = new ArrayBuffer(54 + pixelDataSize)
    const view           = new DataView(buf)
    const bytes          = new Uint8Array(buf)

    bytes[0] = 0x42; bytes[1] = 0x4D
    view.setUint32(2,  54 + pixelDataSize, true)
    view.setUint32(10, 54, true)
    view.setUint32(14, 40,  true)
    view.setInt32 (18, w,   true)
    view.setInt32 (22, -h,  true)
    view.setUint16(26, 1,   true)
    view.setUint16(28, 24,  true)
    view.setUint32(34, pixelDataSize, true)

    let dst = 54
    for (let row = 0; row < h; row++) {
      const rowStart = row * w * 4
      for (let x = 0; x < w; x++) {
        const s = rowStart + x * 4
        bytes[dst++] = src[s + 2]
        bytes[dst++] = src[s + 1]
        bytes[dst++] = src[s]
      }
      dst += padding
    }

    return new Blob([buf], { type: 'image/bmp' })
  }

  private _triggerDownload(blob: Blob, filename: string): void {
    const a = document.createElement('a')
    a.href  = URL.createObjectURL(blob)
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(a.href)
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
