#!/usr/bin/env node
/**
 * 构建: 
 *  1. esbuild 打包 extension (commonjs, external vscode) → out/extension.js
 *  2. esbuild 打包 devin-remote-server → server/server-bundle.mjs (单文件, 插件内嵌分发)
 */
import { build } from 'esbuild';
import { mkdirSync, copyFileSync, cpSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  minify: false,
  sourcemap: true,
  logLevel: 'info',
};

// 1. extension bundle
await build({
  ...common,
  entryPoints: [join(here, 'src/extension.ts')],
  outfile: join(here, 'out/extension.js'),
  format: 'cjs',
  platform: 'node',
  external: ['vscode'],
  target: 'node18',
});

// 2. server bundle (ESM, node24 直跑)
mkdirSync(join(here, 'server'), { recursive: true });
await build({
  ...common,
  entryPoints: [join(here, '../server/src/index.ts')],
  outfile: join(here, 'server/server-bundle.mjs'),
  format: 'esm',
  platform: 'node',
  target: 'node20',
  banner: { js: 'import { createRequire } from "module"; const require = createRequire(import.meta.url);' },
  external: [],
});

// 3. PWA 静态资源拷入 server/web (server-bundle 运行时按相对路径找)
const webSrc = join(here, '../server/src/web');
if (existsSync(webSrc)) {
  cpSync(webSrc, join(here, 'server/web'), { recursive: true });
}

console.log('✔ extension + server bundle 构建完成');
