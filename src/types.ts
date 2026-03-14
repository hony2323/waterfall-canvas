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
