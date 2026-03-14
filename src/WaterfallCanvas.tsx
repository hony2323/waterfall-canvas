import { useEffect, useRef } from 'react'
import { COLORMAP_LUT, valueToLutIndex } from './colormap'

export interface BandHeader {
  band_id: string
  band_start: number
  band_end: number
  timestamp: string
  sent_at: number
  length: number
  precision: string
}

export interface ParsedFrame {
  header: BandHeader[]
  bands: Record<string, Uint8Array | Uint16Array | Float32Array>
}

export interface WaterfallCanvasProps {
  frame: ParsedFrame | null
  rowCount?: number
  heightPx?: number
  onMetrics?: (pushMs: number, renderMs: number) => void
}

export default function WaterfallCanvas({ frame, rowCount = 400, heightPx = 400, onMetrics }: WaterfallCanvasProps) {
  const visCanvasRef = useRef<HTMLCanvasElement>(null)

  // Ring buffer: full-width ImageData (RAM only — no canvas size limit)
  const imgData      = useRef<ImageData | null>(null)
  // Reusable output buffer: canvas-width × rowCount (written via putImageData)
  const viewImg      = useRef<ImageData | null>(null)
  const visCtx       = useRef<CanvasRenderingContext2D | null>(null)

  const onMetricsRef = useRef(onMetrics)
  onMetricsRef.current = onMetrics      // always up-to-date without re-running effects

  const dirty        = useRef(false)   // new row data arrived
  const viewDirty    = useRef(true)    // viewport changed (zoom/pan)
  const viewStart    = useRef(0)
  const viewEnd      = useRef(0)
  const totalSamples = useRef(0)
  const dragActive   = useRef(false)
  const lastDragX    = useRef(0)
  const initialized   = useRef(false)
  const rafId         = useRef(0)
  const lastRenderMs  = useRef(0)    // render timing from previous rAF, reported on next push
  const bandBoundaries = useRef<number[]>([])

  function bandSampleCount(band: BandHeader): number {
    if (band.precision === 'float32') return band.length / 4
    if (band.precision === 'uint16')  return band.length / 2
    return band.length
  }

  function init(f: ParsedFrame) {
    const canvas = visCanvasRef.current
    if (!canvas) return

    let total = 0
    const boundaries: number[] = []
    for (const band of f.header) {
      total += bandSampleCount(band)
      boundaries.push(total)
    }
    boundaries.pop()
    totalSamples.current   = total
    bandBoundaries.current = boundaries

    // Allocate full-width ring buffer (ImageData is just a RAM array, no GPU size limit)
    const img = new ImageData(total, rowCount)
    new Uint32Array(img.data.buffer).fill(0xFF000000) // init to opaque black
    imgData.current = img

    // Allocate viewport-sized output buffer (canvas-width × rowCount)
    const w = canvas.width || 800
    viewImg.current = new ImageData(w, rowCount)

    visCtx.current = canvas.getContext('2d')!

    viewStart.current = 0
    viewEnd.current   = total
    initialized.current = true
    dirty.current    = true
    viewDirty.current = true
  }

  function pushRow(f: ParsedFrame) {
    const img = imgData.current
    if (!img) return
    const total = totalSamples.current
    const buf   = img.data

    // Shift all rows down by one
    buf.copyWithin(total * 4, 0, total * (rowCount - 1) * 4)

    // Write new row at position 0
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
    dirty.current = true
  }

  // Resample the current viewport from the ring buffer into viewImg
  function renderViewport() {
    const src   = imgData.current?.data
    const vData = viewImg.current
    if (!src || !vData) return

    const total = totalSamples.current
    const vs    = viewStart.current | 0
    const span  = ((viewEnd.current | 0) - vs)
    if (span <= 0) return

    const dst = vData.data
    const w   = vData.width
    const h   = rowCount

    for (let y = 0; y < h; y++) {
      const srcRow = y * total
      const dstRow = y * w
      for (let x = 0; x < w; x++) {
        const srcX = vs + ((x * span / w) | 0)
        const si = (srcRow + srcX) * 4
        const di = (dstRow + x)  * 4
        dst[di]   = src[si]
        dst[di+1] = src[si+1]
        dst[di+2] = src[si+2]
        dst[di+3] = src[si+3]
      }
    }
  }

  // rAF loop
  useEffect(() => {
    function loop() {
      const canvas = visCanvasRef.current
      const vctx   = visCtx.current

      if (canvas && canvas.width > 0 && vctx && (dirty.current || viewDirty.current)) {
        // Reallocate viewImg if canvas width changed
        if (!viewImg.current || viewImg.current.width !== canvas.width) {
          viewImg.current = new ImageData(canvas.width, rowCount)
        }

        const renderStart = performance.now()
        renderViewport()
        vctx.putImageData(viewImg.current!, 0, 0)
        lastRenderMs.current = performance.now() - renderStart

        // Band boundary lines
        const vs   = viewStart.current
        const ve   = viewEnd.current
        const span = ve - vs
        if (bandBoundaries.current.length > 0) {
          vctx.strokeStyle = 'rgba(255,255,255,0.4)'
          vctx.lineWidth   = 1
          for (const b of bandBoundaries.current) {
            if (b > vs && b < ve) {
              const x = ((b - vs) / span) * canvas.width
              vctx.beginPath()
              vctx.moveTo(x, 0)
              vctx.lineTo(x, canvas.height)
              vctx.stroke()
            }
          }
        }

        dirty.current     = false
        viewDirty.current = false
      }

      rafId.current = requestAnimationFrame(loop)
    }

    rafId.current = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(rafId.current)
      initialized.current = false
      imgData.current     = null
      viewImg.current     = null
      visCtx.current      = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Push new rows when frame arrives — dep on frame so it fires once per new frame,
  // not on every re-render (e.g. metrics state updates in the parent)
  useEffect(() => {
    if (!frame) return
    if (!initialized.current) init(frame)
    const pushStart = performance.now()
    pushRow(frame)
    const pushMs = performance.now() - pushStart
    onMetricsRef.current?.(pushMs, lastRenderMs.current)
  }, [frame]) // eslint-disable-line react-hooks/exhaustive-deps

  // Keep canvas pixel dimensions in sync with layout
  useEffect(() => {
    const canvas = visCanvasRef.current
    if (!canvas) return
    const ro = new ResizeObserver(() => {
      canvas.width  = canvas.offsetWidth
      canvas.height = heightPx
      viewDirty.current = true
    })
    ro.observe(canvas)
    canvas.width  = canvas.offsetWidth || 800
    canvas.height = heightPx
    return () => ro.disconnect()
  }, [heightPx])

  // Wheel must be non-passive to call preventDefault (React attaches passive by default)
  useEffect(() => {
    const canvas = visCanvasRef.current
    if (!canvas) return
    function handleWheel(e: WheelEvent) {
      e.preventDefault()
      const total = totalSamples.current
      if (!total) return

      const span         = viewEnd.current - viewStart.current
      const factor       = e.deltaY > 0 ? 1.15 : 0.85
      const newSpan      = Math.max(256, Math.min(total, span * factor))
      const cursorFrac   = e.offsetX / canvas!.clientWidth
      const cursorSample = viewStart.current + cursorFrac * span

      let newStart = cursorSample - cursorFrac * newSpan
      let newEnd   = newStart + newSpan
      if (newStart < 0)   { newStart = 0;     newEnd = newSpan }
      if (newEnd > total) { newEnd = total;   newStart = total - newSpan }

      viewStart.current = Math.max(0, newStart)
      viewEnd.current   = Math.min(total, newEnd)
      viewDirty.current = true
    }
    canvas.addEventListener('wheel', handleWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', handleWheel)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function handleMouseDown(e: React.MouseEvent<HTMLCanvasElement>) {
    dragActive.current = true
    lastDragX.current  = e.clientX
    e.currentTarget.style.cursor = 'grabbing'
  }

  function handleMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!dragActive.current) return
    const total = totalSamples.current
    if (!total) return

    const span = viewEnd.current - viewStart.current
    const dx   = ((e.clientX - lastDragX.current) / visCanvasRef.current!.clientWidth) * span
    lastDragX.current = e.clientX

    let newStart = viewStart.current - dx
    let newEnd   = viewEnd.current   - dx
    if (newStart < 0)   { newEnd -= newStart; newStart = 0 }
    if (newEnd > total) { newStart -= (newEnd - total); newEnd = total }

    viewStart.current = Math.max(0, newStart)
    viewEnd.current   = Math.min(total, newEnd)
    viewDirty.current = true
  }

  function handleMouseUp(e: React.MouseEvent<HTMLCanvasElement>) {
    dragActive.current = false
    e.currentTarget.style.cursor = 'grab'
  }

  return (
    <div style={{ width: '100%', cursor: 'grab' }}>
      <canvas
        ref={visCanvasRef}
        style={{ width: '100%', height: `${heightPx}px`, cursor: 'grab', display: 'block' }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      />
    </div>
  )
}
