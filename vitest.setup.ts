import { vi } from 'vitest'

// jsdom doesn't include ImageData unless the native canvas package is installed
if (typeof ImageData === 'undefined') {
  class ImageDataPolyfill {
    readonly data: Uint8ClampedArray
    readonly width: number
    readonly height: number
    constructor(widthOrData: number | Uint8ClampedArray, widthOrHeight: number, height?: number) {
      if (typeof widthOrData === 'number') {
        this.width  = widthOrData
        this.height = widthOrHeight
        this.data   = new Uint8ClampedArray(widthOrData * widthOrHeight * 4)
      } else {
        this.data   = widthOrData
        this.width  = widthOrHeight
        this.height = height ?? (widthOrData.length / (widthOrHeight * 4))
      }
    }
  }
  global.ImageData = ImageDataPolyfill as unknown as typeof ImageData
}

// jsdom has no canvas implementation — provide a minimal 2D context stub
const mockCtx = {
  putImageData:  vi.fn(),
  drawImage:     vi.fn(),
  fillRect:      vi.fn(),
  fillText:      vi.fn(),
  clearRect:     vi.fn(),
  getImageData:  vi.fn(),
}
HTMLCanvasElement.prototype.getContext = vi.fn(() => mockCtx) as never

// jsdom has no ResizeObserver
global.ResizeObserver = class {
  observe    = vi.fn()
  unobserve  = vi.fn()
  disconnect = vi.fn()
}
