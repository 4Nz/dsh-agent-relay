import { defineConfig } from 'tsdown'
import { readFileSync } from 'node:fs'

// 浏览器客户端 bundle 的 id 必须是包名（宿主按包名查找）。
const PLUGIN_ID = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
).name

// 由 DSH loader 模块表（platform seed）提供、不打进 bundle 的 external。
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
]

export default defineConfig({
  name: `${PLUGIN_ID}/client`,
  entry: { client: 'src/client.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  inputOptions: {
    platform: 'browser',
    resolve: {
      conditionNames: ['browser', 'import', 'default'],
      mainFields: ['browser', 'module', 'main'],
    },
  },
  dts: false,
  clean: false,
  deps: {
    neverBundle: (id) => CLIENT_EXTERNALS.includes(id),
    alwaysBundle: (id) => !CLIENT_EXTERNALS.includes(id),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
