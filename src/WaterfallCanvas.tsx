import { useEffect, useRef } from 'react'
import { WaterfallRenderer } from './WaterfallRenderer'
import type { ParsedFrame } from './types'

export interface WaterfallCanvasProps {
  frame: ParsedFrame | null
  rowCount?: number
  heightPx?: number
  onMetrics?: (pushMs: number, renderMs: number) => void
}

export function WaterfallCanvas({ frame, rowCount = 400, heightPx = 400, onMetrics }: WaterfallCanvasProps) {
  const canvasRef     = useRef<HTMLCanvasElement>(null)
  const rendererRef   = useRef<WaterfallRenderer | null>(null)
  const onMetricsRef  = useRef(onMetrics)
  onMetricsRef.current = onMetrics

  useEffect(() => {
    const renderer = new WaterfallRenderer(canvasRef.current!, { rowCount })
    renderer.onMetrics = (...args) => onMetricsRef.current?.(...args)
    rendererRef.current = renderer
    return () => { renderer.destroy(); rendererRef.current = null }
  }, [rowCount])

  useEffect(() => {
    if (!frame) return
    rendererRef.current?.push(frame)
  }, [frame])

  return (
    <canvas
      ref={canvasRef}
      style={{ width: '100%', height: `${heightPx}px`, display: 'block' }}
    />
  )
}
