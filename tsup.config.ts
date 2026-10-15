import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/better-sqlite3.ts', 'src/snowflake.ts', 'src/langchain.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  target: 'node18',
  platform: 'node',
  sourcemap: true,
  clean: true,
  // Shared chunks: the error classes must be the same objects in every entry point,
  // or `instanceof VerictoBlockedError` would fail across them.
  splitting: true,
  treeshake: true,
});
