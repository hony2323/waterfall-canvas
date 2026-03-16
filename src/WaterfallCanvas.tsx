import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { WaterfallRenderer } from './WaterfallRenderer'
import type { ParsedFrame } from './types'

export interface WaterfallCanvasHandle {
  push(frame: ParsedFrame): void
}

export interface WaterfallCanvasProps {
  rowCount?: number
  heightPx?: number
  rowHeight?: number
  bufferWidth?: number
  minSpan?: number
  colorMap?: (t: number) => [number, number, number]
  tooltip?: boolean
  timeBar?: boolean
  timeBarDynamic?: boolean
  freqFormat?: (hz: number) => string
  valueFormat?: (t: number) => string
  lazyThreshold?: number
  onMetrics?: (pushMs: number, renderMs: number, isLazy: boolean) => void
}

export const WaterfallCanvas = forwardRef<WaterfallCanvasHandle, WaterfallCanvasProps>(
  function WaterfallCanvas({ rowCount = 400, heightPx = 400, rowHeight = 1, bufferWidth, minSpan, colorMap, tooltip, timeBar, timeBarDynamic, freqFormat, valueFormat, lazyThreshold, onMetrics }, ref) {
    const canvasRef    = useRef<HTMLCanvasElement>(null)
    const rendererRef  = useRef<WaterfallRenderer | null>(null)
    const onMetricsRef = useRef(onMetrics)
    onMetricsRef.current = onMetrics

    useImperativeHandle(ref, () => ({
      push: (frame) => rendererRef.current?.push(frame),
    }), [])

    useEffect(() => {
      const renderer = new WaterfallRenderer(canvasRef.current!, { rowCount, bufferWidth, minSpan, colorMap, tooltip, timeBar, timeBarDynamic, freqFormat, valueFormat, lazyThreshold })
      renderer.onMetrics = (...args) => onMetricsRef.current?.(...args)
      rendererRef.current = renderer
      return () => { renderer.destroy(); rendererRef.current = null }
    }, [rowCount, bufferWidth, minSpan, colorMap, tooltip, timeBar, timeBarDynamic, freqFormat, valueFormat, lazyThreshold])

    useEffect(() => {
      if (rendererRef.current) rendererRef.current.rowHeight = rowHeight
    }, [rowHeight])

    return (
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: `${heightPx}px`, display: 'block' }}
      />
    )
  }
)
