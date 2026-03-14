import { COLORMAP_LUT, valueToLutIndex } from './colormap'
import type { BandHeader, ParsedFrame } from './types'

export interface WaterfallOptions {
  /** Number of history rows in the ring buffer (also sets canvas pixel height). Default: 400 */
  rowCount?: number
}

export class WaterfallRenderer {
  /** Called from the rAF loop after each render. Assign freely — no re-render side effects. */
  onMetrics?: (pushMs: number, renderMs: number) => void

  private readonly canvas: HTMLCanvasElement
  private readonly rowCount: number

  private imgData: ImageData | null = null       // full-width ring buffer (RAM, no size limit)
  private viewImg: ImageData | null = null       // canvas-width output buffer
  private ctx: CanvasRenderingContext2D | null = null

  private dirty = false
  private viewDirty = true
  private viewStart = 0
  private viewEnd = 0
  private totalSamples = 0
  private initialized = false
  private rafId = 0
  private pendingPushMs = -1
  private bandBoundaries: number[] = []

  private dragActive = false
  private lastDragX = 0

  private readonly ro: ResizeObserver
  private readonly _boundLoop: FrameRequestCallback
  private readonly _boundWheel: (e: WheelEvent) => void
  private readonly _boundMouseDown: (e: MouseEvent) => void
  private readonly _boundMouseMove: (e: MouseEvent) => void
  private readonly _boundMouseUp: (e: MouseEvent) => void

  constructor(canvas: HTMLCanvasElement, options: WaterfallOptions = {}) {
    this.canvas = canvas
    this.rowCount = options.rowCount ?? 400

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

  /** Push a new frame — adds a row to the top of the waterfall. */
  push(frame: ParsedFrame): void {
    if (!this.initialized) this._init(frame)
    const t0 = performance.now()
    this._pushRow(frame)
    this.pendingPushMs = performance.now() - t0
  }

  /** Tear down: cancel rAF, remove all event listeners, free buffers. */
  destroy(): void {
    cancelAnimationFrame(this.rafId)
    this.ro.disconnect()
    this.canvas.removeEventListener('wheel',      this._boundWheel)
    this.canvas.removeEventListener('mousedown',  this._boundMouseDown)
    this.canvas.removeEventListener('mousemove',  this._boundMouseMove)
    this.canvas.removeEventListener('mouseup',    this._boundMouseUp)
    this.canvas.removeEventListener('mouseleave', this._boundMouseUp)
    this.imgData      = null
    this.viewImg      = null
    this.ctx          = null
    this.initialized  = false
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private _bandSampleCount(band: BandHeader): number {
    if (band.precision === 'float32') return band.length / 4
    if (band.precision === 'uint16')  return band.length / 2
    return band.length
  }

  private _init(f: ParsedFrame): void {
    let total = 0
    const boundaries: number[] = []
    for (const band of f.header) {
      total += this._bandSampleCount(band)
      boundaries.push(total)
    }
    boundaries.pop()
    this.totalSamples    = total
    this.bandBoundaries  = boundaries

    const img = new ImageData(total, this.rowCount)
    new Uint32Array(img.data.buffer).fill(0xFF000000)  // opaque black
    this.imgData = img

    this.viewImg = new ImageData(this.canvas.width || 800, this.rowCount)
    this.ctx     = this.canvas.getContext('2d')!

    this.viewStart   = 0
    this.viewEnd     = total
    this.initialized = true
    this.dirty       = true
    this.viewDirty   = true
  }

  private _pushRow(f: ParsedFrame): void {
    const img = this.imgData
    if (!img) return
    const total = this.totalSamples
    const buf   = img.data

    buf.copyWithin(total * 4, 0, total * (this.rowCount - 1) * 4)

    let px = 0
    for (const band of f.header) {
      const samples   = f.bands[band.band_id]
      if (!samples) continue
      const precision = band.precision
      const count     = samples.length
      for (let i = 0; i < count; i++) {
        const idx = valueToLutIndex(samples[i], precision)
        buf[px++] = COLORMAP_LUT[idx * 3]
        buf[px++] = COLORMAP_LUT[idx * 3 + 1]
        buf[px++] = COLORMAP_LUT[idx * 3 + 2]
        buf[px++] = 255
      }
    }
    this.dirty = true
  }

  private _renderViewport(): void {
    const src   = this.imgData?.data
    const vData = this.viewImg
    if (!src || !vData) return

    const total = this.totalSamples
    const vs    = this.viewStart | 0
    const span  = (this.viewEnd | 0) - vs
    if (span <= 0) return

    const dst = vData.data
    const w   = vData.width
    const h   = this.rowCount

    for (let y = 0; y < h; y++) {
      const srcRow = y * total
      const dstRow = y * w
      for (let x = 0; x < w; x++) {
        const srcX = vs + ((x * span / w) | 0)
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

      // Band boundary lines
      const vs   = this.viewStart
      const ve   = this.viewEnd
      const span = ve - vs
      if (this.bandBoundaries.length > 0) {
        ctx.strokeStyle = 'rgba(255,255,255,0.4)'
        ctx.lineWidth   = 1
        for (const b of this.bandBoundaries) {
          if (b > vs && b < ve) {
            const x = ((b - vs) / span) * canvas.width
            ctx.beginPath()
            ctx.moveTo(x, 0)
            ctx.lineTo(x, canvas.height)
            ctx.stroke()
          }
        }
      }

      this.dirty     = false
      this.viewDirty = false
    }

    this.rafId = requestAnimationFrame(this._boundLoop)
  }

  private _onWheel(e: WheelEvent): void {
    e.preventDefault()
    const total = this.totalSamples
    if (!total) return

    const span         = this.viewEnd - this.viewStart
    const factor       = e.deltaY > 0 ? 1.15 : 0.85
    const newSpan      = Math.max(256, Math.min(total, span * factor))
    const cursorFrac   = e.offsetX / this.canvas.clientWidth
    const cursorSample = this.viewStart + cursorFrac * span

    let newStart = cursorSample - cursorFrac * newSpan
    let newEnd   = newStart + newSpan
    if (newStart < 0)     { newStart = 0;     newEnd   = newSpan }
    if (newEnd   > total) { newEnd   = total; newStart = total - newSpan }

    this.viewStart = Math.max(0, newStart)
    this.viewEnd   = Math.min(total, newEnd)
    this.viewDirty = true
  }

  private _onMouseDown(e: MouseEvent): void {
    this.dragActive          = true
    this.lastDragX           = e.clientX
    this.canvas.style.cursor = 'grabbing'
  }

  private _onMouseMove(e: MouseEvent): void {
    if (!this.dragActive) return
    const total = this.totalSamples
    if (!total) return

    const span = this.viewEnd - this.viewStart
    const dx   = ((e.clientX - this.lastDragX) / this.canvas.clientWidth) * span
    this.lastDragX = e.clientX

    let newStart = this.viewStart - dx
    let newEnd   = this.viewEnd   - dx
    if (newStart < 0)     { newEnd -= newStart;          newStart = 0 }
    if (newEnd   > total) { newStart -= (newEnd - total); newEnd   = total }

    this.viewStart = Math.max(0, newStart)
    this.viewEnd   = Math.min(total, newEnd)
    this.viewDirty = true
  }

  private _onMouseUp(): void {
    this.dragActive          = false
    this.canvas.style.cursor = 'grab'
  }
}
