/** Grayscale: black → white */
export function interpolateGrayscale(t: number): [number, number, number] {
  const v = Math.round(Math.max(0, Math.min(1, t)) * 255)
  return [v, v, v]
}

/** Hot colormap: black → red → yellow → white */
export function interpolateHot(t: number): [number, number, number] {
  t = Math.max(0, Math.min(1, t))
  if (t < 0.333) {
    return [Math.round((t / 0.333) * 255), 0, 0]
  } else if (t < 0.666) {
    return [255, Math.round(((t - 0.333) / 0.333) * 255), 0]
  } else {
    return [255, 255, Math.round(((t - 0.666) / 0.334) * 255)]
  }
}

/**
 * Turbo colormap (Google, 2019) — perceptually-uniform rainbow.
 * Polynomial coefficients from d3-scale-chromatic / Google AI Blog.
 */
export function interpolateTurbo(t: number): [number, number, number] {
  t = Math.max(0, Math.min(1, t))
  return [
    Math.max(0, Math.min(255, Math.round(34.61 + t * (1172.33 - t * (10793.56 - t * (33300.12 - t * (38394.49 - t * 14825.05))))))),
    Math.max(0, Math.min(255, Math.round(23.31 + t * (  557.33 + t * ( 1225.33 - t * ( 3574.96 - t * ( 1073.77 + t *   707.56))))))),
    Math.max(0, Math.min(255, Math.round(27.2  + t * ( 3211.1  - t * (15327.97 - t * (27814    - t * (22569.18 - t *  6838.66))))))),
  ]
}

/** Build a 256-entry packed RGB LUT from any colormap function. */
export function buildLut(colorMap: (t: number) => [number, number, number]): Uint8Array {
  const lut = new Uint8Array(256 * 3)
  for (let i = 0; i < 256; i++) {
    const [r, g, b] = colorMap(i / 255)
    lut[i * 3]     = r
    lut[i * 3 + 1] = g
    lut[i * 3 + 2] = b
  }
  return lut
}

/**
 * Normalize a raw sample value to [0, 1] based on wire precision.
 * uint8 / float32 — backend sends values in the 0–100 range.
 * uint16           — full 0–65535 range.
 */
export function normalizeValue(value: number, precision: string): number {
  if (precision === 'uint16') return value / 65535
  return value / 100  // uint8 and float32: 0–100
}
