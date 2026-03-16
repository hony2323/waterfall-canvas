# waterfall-canvas

![waterfall-canvas demo](https://raw.githubusercontent.com/hony2323/waterfall-canvas/master/assets/demo.gif)

High-performance waterfall / spectrogram canvas renderer with an optional React wrapper.

- Scrolling ring-buffer — no array shifting, constant memory
- Zoom & pan via mouse wheel and drag
- Multi-band support — bands rendered side-by-side with gap lines
- Hover tooltip with frequency, signal value, and timestamp
- Optional time-ago bar on the left edge
- Max-value pooling so narrow spikes are always visible when zoomed out
- `lazyThreshold` for a consistent speed/accuracy trade-off at extreme zoom-out
- Full image export (BMP or tiled PNG)
- Pluggable colormaps (grayscale, hot, turbo, or your own)
- Tree-shakeable, dual ESM/CJS, full TypeScript types

**Performance** (Chrome, mid-range laptop)
- 30+ FPS with ~2,000 bins
- ~10 FPS with ~70,000 bins

---

## Install

```bash
npm install @hony2323/waterfall-canvas
```

React is a peer dependency and is only needed if you use `@hony2323/waterfall-canvas/react`.

---

## Quick start — vanilla

```ts
import { WaterfallRenderer, interpolateTurbo } from '@hony2323/waterfall-canvas'
import type { ParsedFrame } from '@hony2323/waterfall-canvas'

const canvas = document.getElementById('waterfall') as HTMLCanvasElement

const renderer = new WaterfallRenderer(canvas, {
  rowCount:    400,
  colorMap:    interpolateTurbo,
  bufferWidth: 0,        // 0 = full input resolution (1:1 sample → pixel)
  minSpan:     32,       // max zoom: 32 ring pixels visible
  tooltip:     true,
  timeBar:     true,
  freqFormat:  hz  => (hz / 1e6).toFixed(4) + ' MHz',
  valueFormat: t   => (t * 100).toFixed(1)  + ' dBFS',
})

// push a parsed frame whenever new data arrives
renderer.push(frame satisfies ParsedFrame)

// clean up
renderer.destroy()
```

---

## Quick start — React

```tsx
import { useRef } from 'react'
import { WaterfallCanvas } from '@hony2323/waterfall-canvas/react'
import { interpolateTurbo } from '@hony2323/waterfall-canvas'
import type { WaterfallCanvasHandle } from '@hony2323/waterfall-canvas/react'

const freqFormat = (hz: number) => (hz / 1e6).toFixed(4) + ' MHz'
const valueFormat = (t: number)  => (t * 100).toFixed(1)  + ' dBFS'

export function Spectrogram() {
  const ref = useRef<WaterfallCanvasHandle>(null)

  // call ref.current.push(frame) from wherever you receive data
  // (WebSocket handler, web worker message, etc.)

  return (
    <WaterfallCanvas
      ref={ref}
      colorMap={interpolateTurbo}
      bufferWidth={0}
      minSpan={32}
      rowHeight={1}
      heightPx={400}
      tooltip
      timeBar
      freqFormat={freqFormat}
      valueFormat={valueFormat}
      onMetrics={(pushMs, renderMs, isLazy) => console.log(pushMs, renderMs, isLazy)}
    />
  )
}
```

> **Note:** define `freqFormat` and `valueFormat` outside the component (module-level constants or stable refs). Inline arrow functions cause the renderer to be recreated on every render.

---

## ParsedFrame format

`push()` expects a `ParsedFrame` — typically produced by parsing the binary WebSocket frame described below.

```ts
interface BandHeader {
  band_id:    string
  band_start: number   // Hz
  band_end:   number   // Hz
  timestamp:  string   // ISO-8601
  sent_at:    number   // ms epoch (used by tooltip & time bar)
  length:     number   // byte length of this band's data slice
  precision:  'uint8' | 'uint16' | 'float32'
}

interface ParsedFrame {
  header: BandHeader[]
  bands:  Record<string, Uint8Array | Uint16Array | Float32Array>
}
```

### Binary frame wire format

```
[uint32 big-endian: header_len][JSON header bytes][band data bytes ...]
```

The header is a JSON array, one object per band. The data section is each band's raw samples concatenated in the same order. Client slices by `length` bytes of the declared dtype.

```js
ws.binaryType = 'arraybuffer'
ws.onmessage = ({ data }) => {
  const view      = new DataView(data)
  const headerLen = view.getUint32(0)
  const header    = JSON.parse(new TextDecoder().decode(new Uint8Array(data, 4, headerLen)))
  const bands     = {}
  let offset      = 4 + headerLen
  for (const band of header) {
    const TypedArray = band.precision === 'float32' ? Float32Array
                     : band.precision === 'uint16'  ? Uint16Array
                     : Uint8Array
    const byteLen = band.length
    bands[band.band_id] = new TypedArray(data.slice(offset, offset + byteLen))
    offset += byteLen
  }
  renderer.push({ header, bands })
}
```

---

## API

### `new WaterfallRenderer(canvas, options?)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `rowCount` | `number` | `400` | Ring buffer height (history rows) |
| `bufferWidth` | `number` | `4096` | Max ring buffer width in pixels. `0` = full input resolution |
| `minSpan` | `number` | `32` | Minimum visible pixels (= maximum zoom) |
| `colorMap` | `(t: number) => [r,g,b]` | grayscale | Colormap function. A 256-entry LUT is pre-computed at init |
| `tooltip` | `boolean` | `false` | Show hover tooltip with band / freq / value / time |
| `timeBar` | `boolean` | `false` | Show time-ago labels on the left edge |
| `timeBarDynamic` | `boolean` | `false` | When `true`, time-ago updates every rAF tick; when `false`, only on new data |
| `lazyThreshold` | `number` | `4` | Source-pixels-per-output-pixel ratio above which rendering becomes **approximate**: the full per-pixel max-value scan is replaced by a strided scan over fixed grid positions (multiples of `lazyThreshold`). This is intentional — at extreme zoom-out the scan dominates render time, and sub-pixel spikes are not visible anyway. Grid positions are zoom-invariant, so spike visibility is consistent as you zoom. Set to `Infinity` to always use the full scan |
| `freqFormat` | `(hz: number) => string` | `hz.toFixed(1)` | Formats the frequency in the tooltip |
| `valueFormat` | `(t: number) => string` | `(t*100).toFixed(1)+'%'` | Formats the signal value (`t` is normalized 0–1) |

#### Instance members

| Member | Description |
|--------|-------------|
| `push(frame: ParsedFrame)` | Add a new row. Initializes the renderer on the first call |
| `exportImage(options?)` | Download the full ring buffer as an image file. See `ExportImageOptions` below |
| `rowHeight: number` | Pixel height of each time-slice row. Can be set at any time |
| `onMetrics?: (pushMs, renderMs, isLazy) => void` | Called after each render. `isLazy` is `true` when the strided scan was used instead of the full max-value scan |
| `destroy()` | Cancel rAF, remove event listeners, free buffers |

#### `ExportImageOptions`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `format` | `'bmp' \| 'png'` | `'bmp'` | BMP is uncompressed with no size limit. PNG is tiled into multiple files when width > 32,767 px |
| `filename` | `string` | `'waterfall'` | Base filename without extension |

#### Interaction

| Input | Action |
|-------|--------|
| Mouse wheel | Zoom in/out centered on cursor |
| Click & drag | Pan left/right |

---

### `<WaterfallCanvas>` (React)

All `WaterfallOptions` fields are available as props, plus:

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `ref` | `WaterfallCanvasHandle` | — | Exposes `push(frame)` and `exportImage(options?)` imperatively |
| `heightPx` | `number` | `400` | CSS height of the canvas element |
| `rowHeight` | `number` | `1` | Passed to renderer; updates without recreating |
| `lazyThreshold` | `number` | `4` | See `WaterfallOptions` above |
| `onMetrics` | `(pushMs, renderMs, isLazy) => void` | — | Render timing callback; `isLazy` reflects whether the strided scan was active |

`rowHeight` and `heightPx` changes are applied without tearing down the renderer. All other prop changes recreate it.

---

## Colormaps

```ts
import { interpolateGrayscale, interpolateHot, interpolateTurbo, buildLut } from '@hony2323/waterfall-canvas'

// Use a built-in
new WaterfallRenderer(canvas, { colorMap: interpolateTurbo })

// Build a custom LUT from any function: (t: number) => [r, g, b]
const myLut = buildLut(t => [Math.round(t * 255), 0, Math.round((1 - t) * 255)])
```

---

## Contributing

1. Fork the repo and create a branch from `dev`
2. Make your changes and add tests where relevant
3. Open a pull request against `dev` — CI must pass before review
4. A maintainer will merge to `dev`, then promote to `master` for release

Please open an issue first for significant changes so the approach can be discussed before you invest time in an implementation.
