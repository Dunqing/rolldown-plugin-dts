import { fork, type ChildProcess } from 'node:child_process'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { createDebug } from 'obug'
import {
  filename_to_dts,
  RE_DTS,
  RE_JS,
  RE_JSON,
  RE_NODE_MODULES,
  RE_ROLLDOWN_RUNTIME,
  RE_TS,
  RE_VUE,
  replaceTemplateName,
  resolveTemplateFn,
} from './filename.ts'
import {
  createContext,
  globalContext,
  invalidateContextFile,
  type TscContext,
} from './tsc/context.ts'
import { runTsgo } from './tsgo.ts'
import type { NativeBundlerContext } from './native-bundler.ts'
import type { OptionsResolved } from './options.ts'
import type { TscOptions, TscResult } from './tsc/index.ts'
import type { TscFunctions } from './tsc/worker.ts'
import type { BirpcReturn } from 'birpc'
import type { Plugin } from 'rolldown'

const debug = createDebug('rolldown-plugin-dts:generate')

const WORKER_URL = import.meta.WORKER_URL || './tsc/worker.ts'

export interface TsModule {
  /** `.ts` source code */
  code: string
  /** `.ts` file name */
  id: string
  isEntry: boolean
}
/** dts filename -> ts module */
export type DtsMap = Map<string, TsModule>

export function createGeneratePlugin(
  {
    tsconfig,
    tsconfigRaw,
    build,
    incremental,
    cwd,
    oxc,
    emitDtsOnly,
    vue,
    tsMacro,
    parallel,
    eager,
    tsgo,
    newContext,
    emitJs,
    sourcemap,
  }: Pick<
    OptionsResolved,
    | 'cwd'
    | 'tsconfig'
    | 'tsconfigRaw'
    | 'build'
    | 'incremental'
    | 'oxc'
    | 'emitDtsOnly'
    | 'vue'
    | 'tsMacro'
    | 'parallel'
    | 'eager'
    | 'tsgo'
    | 'newContext'
    | 'emitJs'
    | 'sourcemap'
  >,
  ctx: NativeBundlerContext,
): Plugin {
  const { dtsMap } = ctx

  /**
   * A map of input id to output file name
   *
   * @example
   *
   * inputAlias = new Map([
   *   ['/absolute/path/to/src/source_file.ts', 'dist/foo/index'],
   * ])
   */
  const inputAliasMap = new Map<string, string>()

  let childProcess: ChildProcess | undefined
  let rpc: BirpcReturn<TscFunctions> | undefined
  let tscModule: typeof import('./tsc/index.ts')
  let tscContext: TscContext | undefined

  return {
    name: 'rolldown-plugin-dts:generate',

    async buildStart(options) {
      if (tsgo) {
        ctx.tsgoDist = await runTsgo(
          ctx.rootDir,
          tsconfig,
          sourcemap,
          tsgo.path,
        )
      } else if (!oxc) {
        // tsc
        if (parallel) {
          childProcess = fork(new URL(WORKER_URL, import.meta.url), {
            stdio: 'inherit',
          })
          rpc = (await import('birpc')).createBirpc<TscFunctions>(
            {},
            {
              post: (data) => childProcess!.send(data),
              on: (fn) => childProcess!.on('message', fn),
            },
          )
        } else {
          tscModule = await import('./tsc/index.ts')
          if (newContext) {
            tscContext = createContext()
          }
        }
      }

      // Expose oxc options to the native bundler context
      ctx.oxcOptions = oxc

      // Expose tscEmit function for native bundler
      if (!tsgo && !oxc) {
        ctx.tscEmit = async (id: string): Promise<TscResult> => {
          const entries = eager
            ? undefined
            : Array.from(dtsMap.values())
                .filter((v) => v.isEntry)
                .map((v) => v.id)
          const tscOptions: Omit<TscOptions, 'programs'> = {
            tsconfig,
            tsconfigRaw,
            build,
            incremental,
            cwd,
            entries,
            id,
            sourcemap,
            vue,
            tsMacro,
            context: tscContext,
          }
          if (parallel) {
            return rpc!.tscEmit(tscOptions)
          }
          return tscModule.tscEmit(tscOptions)
        }
      }

      // Expose deferred cleanup
      ctx.cleanup = async () => {
        childProcess?.kill()
        if (!debug.enabled && ctx.tsgoDist) {
          await rm(ctx.tsgoDist, { recursive: true, force: true }).catch(
            () => {},
          )
        }
        ctx.tsgoDist = undefined
        if (newContext) {
          tscContext = undefined
        }
      }

      if (!Array.isArray(options.input)) {
        for (const [name, id] of Object.entries(options.input)) {
          debug('resolving input alias %s -> %s', name, id)
          let resolved = await this.resolve(id)
          if (!id.startsWith('./')) {
            resolved ||= await this.resolve(`./${id}`)
          }
          const resolvedId = resolved?.id || id
          debug('resolved input alias %s -> %s', id, resolvedId)
          inputAliasMap.set(resolvedId, name)
        }
      }
    },

    outputOptions(options) {
      return {
        ...options,
        entryFileNames(chunk) {
          const { entryFileNames } = options
          const nameTemplate = resolveTemplateFn(
            entryFileNames || '[name].js',
            chunk,
          )

          if (chunk.name.endsWith('.d')) {
            if (RE_DTS.test(nameTemplate)) {
              return replaceTemplateName(nameTemplate, chunk.name.slice(0, -2))
            }
            if (RE_JS.test(nameTemplate)) {
              return nameTemplate.replace(RE_JS, '.$1ts')
            }
          }

          return nameTemplate
        },
      }
    },

    resolveId(id) {
      if (dtsMap.has(id)) {
        debug('resolve dts id %s', id)
        return { id }
      }
    },

    transform: {
      order: 'pre',
      filter: {
        id: {
          include: [RE_JS, RE_TS, RE_VUE, RE_JSON],
          exclude: [RE_DTS, RE_NODE_MODULES, RE_ROLLDOWN_RUNTIME],
        },
      },
      handler(code, id) {
        const shouldEmit = !RE_JS.test(id) || emitJs

        if (shouldEmit) {
          const mod = this.getModuleInfo(id)
          const isEntry = !!mod?.isEntry
          const dtsId = filename_to_dts(id)
          dtsMap.set(dtsId, { code, id, isEntry })
          debug('register dts source: %s', id)

          if (isEntry) {
            const alias = inputAliasMap.get(id)
            // Always provide a name so Rolldown uses entryFileNames (not chunkFileNames)
            const chunkName = alias
              ? `${alias}.d`
              : `${path.basename(dtsId, path.extname(dtsId))}`
            this.emitFile({
              type: 'chunk',
              id: dtsId,
              name: chunkName,
            })
          }
        }

        if (emitDtsOnly) {
          if (RE_JSON.test(id)) return '{}'
          return 'export { }'
        }
      },
    },

    load: {
      filter: {
        id: {
          include: [RE_DTS],
          exclude: [RE_NODE_MODULES],
        },
      },
      handler(dtsId) {
        if (!dtsMap.has(dtsId)) return
        debug('load dummy for dts %s', dtsId)
        // Return dummy content — the native bundler generates the real .d.ts
        return { code: 'export {}' }
      },
    },

    watchChange(id) {
      if (tscModule) {
        invalidateContextFile(tscContext || globalContext, id)
      }
    },
  }
}
