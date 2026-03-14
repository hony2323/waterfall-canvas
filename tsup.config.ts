import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    react:  'src/WaterfallCanvas.tsx',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  splitting: true,   // shared chunks (colormap, WaterfallRenderer) aren't duplicated
  clean: true,
  external: ['react', 'react/jsx-runtime'],
})
