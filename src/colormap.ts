// Hot colormap: black → red → yellow → white (256 entries, RGB)
const LUT = new Uint8Array(256 * 3)

for (let i = 0; i < 256; i++) {
  const t = i / 255
  let r: number, g: number, b: number
  if (t < 0.333) {
    const s = t / 0.333
    r = Math.round(s * 255)
    g = 0
    b = 0
  } else if (t < 0.666) {
    const s = (t - 0.333) / 0.333
    r = 255
    g = Math.round(s * 255)
    b = 0
  } else {
    const s = (t - 0.666) / 0.334
    r = 255
    g = 255
    b = Math.round(s * 255)
  }
  LUT[i * 3] = r
  LUT[i * 3 + 1] = g
  LUT[i * 3 + 2] = b
}

export const COLORMAP_LUT = LUT

export function valueToLutIndex(value: number, precision: string): number {
  if (precision === 'uint8') return Math.round(value * 2.55) & 0xff
  if (precision === 'uint16') return Math.round((value / 65535) * 255) & 0xff
  // float32: values 0–100
  return Math.round((value / 100) * 255) & 0xff
}
