import path from 'node:path'
import { createDebug } from 'obug'
import { createDtsInputPlugin } from './dts-input.ts'
import { createGeneratePlugin } from './generate.ts'
import { createNativeBundlerPlugin } from './native-bundler.ts'
import { resolveOptions, type Options } from './options.ts'
import type { NativeBundlerContext } from './native-bundler.ts'
import type { Plugin } from 'rolldown'

const debug = createDebug('rolldown-plugin-dts:options')

export function dts(options: Options = {}): Plugin[] {
  debug('resolving dts options')
  const resolved = resolveOptions(options)
  debug('resolved dts options %o', resolved)

  const ctx: NativeBundlerContext = {
    dtsMap: new Map(),
    rootDir: resolved.tsconfig
      ? path.dirname(resolved.tsconfig)
      : resolved.cwd,
    sourcemap: resolved.sourcemap,
  }

  const plugins: Plugin[] = []
  if (options.dtsInput) {
    plugins.push(createDtsInputPlugin(resolved))
  } else {
    plugins.push(createGeneratePlugin(resolved, ctx))
  }
  plugins.push(createNativeBundlerPlugin(resolved, ctx))
  return plugins
}

export {
  createGeneratePlugin,
  createNativeBundlerPlugin,
  resolveOptions,
  type Options,
}
