# waterfall-canvas

High-performance waterfall / spectrogram canvas renderer with an optional React wrapper.

- Scrolling ring-buffer — no array shifting, constant memory
- Zoom & pan via mouse wheel and drag
- Multi-band support — bands rendered side-by-side with gap lines
- Hover tooltip with frequency, signal value, and timestamp
- Optional time-ago bar on the left edge
- Max-value pooling so narrow spikes are always visible at full zoom-out
- Pluggable colormaps (grayscale, hot, turbo, or your own)
- Tree-shakeable, dual ESM/CJS, full TypeScript types

---

## Install

```bash
npm install waterfall-canvas
```

React is a peer dependency and is only needed if you use `waterfall-canvas/react`.

---

## Quick start — vanilla

```ts
import { WaterfallRenderer, interpolateTurbo } from 'waterfall-canvas'
import type { ParsedFrame } from 'waterfall-canvas'

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
import { WaterfallCanvas } from 'waterfall-canvas/react'
import { interpolateTurbo } from 'waterfall-canvas'
import type { WaterfallCanvasHandle } from 'waterfall-canvas/react'

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
      onMetrics={(pushMs, renderMs) => console.log(pushMs, renderMs)}
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
| `freqFormat` | `(hz: number) => string` | `hz.toFixed(1)` | Formats the frequency in the tooltip |
| `valueFormat` | `(t: number) => string` | `(t*100).toFixed(1)+'%'` | Formats the signal value (`t` is normalized 0–1) |

#### Instance members

| Member | Description |
|--------|-------------|
| `push(frame: ParsedFrame)` | Add a new row. Initializes the renderer on the first call |
| `rowHeight: number` | Pixel height of each time-slice row. Can be set at any time |
| `onMetrics?: (pushMs, renderMs) => void` | Called after each render with timing data |
| `destroy()` | Cancel rAF, remove event listeners, free buffers |

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
| `ref` | `WaterfallCanvasHandle` | — | Exposes `push(frame)` imperatively |
| `heightPx` | `number` | `400` | CSS height of the canvas element |
| `rowHeight` | `number` | `1` | Passed to renderer; updates without recreating |
| `onMetrics` | `(pushMs, renderMs) => void` | — | Render timing callback |

`rowHeight` and `heightPx` changes are applied without tearing down the renderer. All other prop changes recreate it.

---

## Colormaps

```ts
import { interpolateGrayscale, interpolateHot, interpolateTurbo, buildLut } from 'waterfall-canvas'

// Use a built-in
new WaterfallRenderer(canvas, { colorMap: interpolateTurbo })

// Build a custom LUT from any function: (t: number) => [r, g, b]
const myLut = buildLut(t => [Math.round(t * 255), 0, Math.round((1 - t) * 255)])
```

---

## Development

```bash
npm run build        # compile to dist/
npm run watch        # rebuild on file changes
npm test             # run tests once
npm run test:watch   # run tests in watch mode
npm run test:coverage
npm run typecheck
```

---

## Publishing

```bash
# bump version in package.json, then:
git tag v0.2.0
git push origin v0.2.0
```

The `publish` GitHub Actions workflow triggers on `v*` tags, runs `prepublishOnly` (build + tests), and publishes to npm with provenance. Requires an `NPM_TOKEN` secret in the repository settings.
