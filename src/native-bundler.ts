import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createDebug } from 'obug'
import { isIdentifierName, isKeyword } from '@babel/helper-validator-identifier'
import { RE_DTS, RE_DTS_MAP, RE_JS, filename_js_to_dts, filename_to_dts } from './filename.ts'
import type { DtsMap } from './generate.ts'
import type { OptionsResolved } from './options.ts'
import type { TscResult } from './tsc/index.ts'
import type { IsolatedDeclarationsOptions } from 'rolldown/experimental'
import type { Plugin } from 'rolldown'

const debug = createDebug('rolldown-plugin-dts:native-bundler')

export interface NativeBundlerContext {
  dtsMap: DtsMap
  tscEmit?: (id: string) => Promise<TscResult>
  tsgoDist?: string
  oxcOptions?: IsolatedDeclarationsOptions | false
  rootDir: string
  sourcemap: boolean
  cleanup?: () => Promise<void>
}

interface BundleDtsDiagnostic {
  message: string
  file?: string
  span?: number[]
  severity: string
}

interface BundleDtsResult {
  code: string
  map?: string
  warnings: BundleDtsDiagnostic[]
}

type BundleFn = (options: {
  input: string[]
  external?: string[]
  cwd?: string
  sourcemap?: boolean
  cjsDefault?: boolean
}) => BundleDtsResult

export function createNativeBundlerPlugin(
  {
    dtsInput,
    cwd,
    cjsDefault,
    sourcemap,
    emitDtsOnly,
  }: Pick<
    OptionsResolved,
    'dtsInput' | 'cwd' | 'cjsDefault' | 'sourcemap' | 'emitDtsOnly'
  >,
  ctx: NativeBundlerContext,
): Plugin {
  let bundleFn: BundleFn
  let externalPatterns: string[] = []

  return {
    name: 'rolldown-plugin-dts:native-bundler',

    async buildStart() {
      try {
        const mod = await import('typeroll')
        bundleFn = mod.bundle
      } catch {
        throw new Error(
          '[rolldown-plugin-dts] `typeroll` is required but not installed. ' +
            'Please install it: npm install typeroll',
        )
      }
    },

    options(options) {
      // Capture Rolldown's external config for forwarding to native bundler
      if (options.external) {
        if (Array.isArray(options.external)) {
          externalPatterns = options.external.filter(
            (e): e is string => typeof e === 'string',
          )
        }
      }
      return options
    },

    transform: {
      filter: {
        id: {
          include: [RE_DTS],
        },
      },
      handler(_code, _id) {
        // .d.ts files are handled by the native bundler; return dummy for Rolldown
        return { code: 'export {}' }
      },
    },

    async generateBundle(outputOptions, bundle) {
      // 1. Identify DTS entries and compute their output filenames
      const dtsEntries: {
        fileName: string
        facadeModuleId: string
        bundleKey: string
      }[] = []
      const dtsStubKeys: string[] = []

      if (dtsInput) {
        // dtsInput mode: Rolldown's own entries are .d.ts files
        for (const [bundleKey, chunk] of Object.entries(bundle)) {
          if (chunk.type !== 'chunk' || !chunk.facadeModuleId) continue
          if (!RE_DTS.test(chunk.facadeModuleId) || !chunk.isEntry) continue
          dtsEntries.push({
            fileName: chunk.fileName,
            facadeModuleId: chunk.facadeModuleId,
            bundleKey,
          })
        }
      } else {
        // Non-dtsInput: derive DTS filenames from JS entry filenames
        // Build map: source .ts path → JS entry fileName
        const jsEntryFileNames = new Map<string, string>()
        for (const chunk of Object.values(bundle)) {
          if (chunk.type !== 'chunk' || !chunk.facadeModuleId) continue
          if (!chunk.isEntry || ctx.dtsMap.has(chunk.facadeModuleId)) continue
          jsEntryFileNames.set(chunk.facadeModuleId, chunk.fileName)
        }

        // Process DTS stub chunks emitted by the generate plugin
        for (const [bundleKey, chunk] of Object.entries(bundle)) {
          if (chunk.type !== 'chunk' || !chunk.facadeModuleId) continue
          if (!ctx.dtsMap.has(chunk.facadeModuleId)) continue

          dtsStubKeys.push(bundleKey)

          if (!chunk.isEntry) continue

          // Find corresponding JS entry and derive DTS filename
          const sourceId = ctx.dtsMap.get(chunk.facadeModuleId)!.id
          const jsFileName = jsEntryFileNames.get(sourceId)
          let dtsFileName: string
          if (jsFileName && RE_JS.test(jsFileName)) {
            dtsFileName = filename_js_to_dts(jsFileName)
          } else if (jsFileName) {
            // Non-JS extension (e.g., .invalid) — add .d. prefix
            const ext = path.extname(jsFileName)
            dtsFileName =
              jsFileName.slice(0, -ext.length) + '.d' + ext
          } else {
            // No JS entry (shouldn't happen, but fallback)
            dtsFileName = chunk.name.endsWith('.d')
              ? `${chunk.name}.ts`
              : `${chunk.name}.d.ts`
          }

          dtsEntries.push({
            fileName: dtsFileName,
            facadeModuleId: chunk.facadeModuleId,
            bundleKey,
          })
        }
      }

      // 2. Delete all DTS-related chunks from bundle
      const keysToDelete = new Set([
        ...dtsEntries.map((e) => e.bundleKey),
        ...dtsStubKeys,
      ])
      for (const key of keysToDelete) {
        delete bundle[key]
      }
      // Also delete any .d.ts.map chunks
      for (const fileName of Object.keys(bundle)) {
        if (RE_DTS_MAP.test(fileName)) {
          delete bundle[fileName]
        }
      }

      if (dtsEntries.length === 0) return

      // 3. Determine entry paths and cwd for the native bundler
      let bundleCwd: string
      let entryPaths: string[]
      let tempDir: string | undefined

      if (dtsInput) {
        // dtsInput mode: .d.ts files are on disk already
        bundleCwd = cwd
        entryPaths = dtsEntries.map((e) => e.facadeModuleId)
      } else if (ctx.tsgoDist) {
        // tsgo optimization: use tsgoDist directly (files already generated)
        bundleCwd = ctx.tsgoDist
        entryPaths = dtsEntries.map((e) => {
          const relPath = path.relative(
            path.resolve(ctx.rootDir),
            e.facadeModuleId,
          )
          return path.resolve(ctx.tsgoDist!, relPath)
        })
      } else {
        // Normal mode (oxc/tsc): generate .d.ts files to a temp dir
        tempDir = await mkdtemp(path.join(tmpdir(), 'rolldown-plugin-dts-'))
        // Resolve symlinks (e.g. macOS /var → /private/var) so paths
        // match what the native bundler's resolver canonicalizes to
        tempDir = realpathSync(tempDir)

        const entryDtsIds = new Set(dtsEntries.map((e) => e.facadeModuleId))
        await generateDtsToDir(tempDir, cwd, ctx, entryDtsIds)

        bundleCwd = tempDir
        entryPaths = dtsEntries.map((e) => {
          const relPath = path.relative(
            path.resolve(ctx.rootDir),
            e.facadeModuleId,
          )
          return path.resolve(tempDir!, relPath)
        })
      }

      // 4. Call native bundler for each entry
      for (let i = 0; i < dtsEntries.length; i++) {
        const { fileName } = dtsEntries[i]
        const entryPath = entryPaths[i]

        debug('bundling entry %s -> %s', entryPath, fileName)

        let result: BundleDtsResult
        try {
          result = bundleFn({
            input: [entryPath],
            external: externalPatterns,
            cwd: bundleCwd,
            sourcemap,
            cjsDefault,
          })
        } catch (error: any) {
          // Parse NAPI JSON diagnostics from error.message
          let diagnostics: BundleDtsDiagnostic[] | undefined
          try {
            diagnostics = JSON.parse(error.message)
          } catch {
            // Not JSON, re-throw as-is
          }
          if (diagnostics && Array.isArray(diagnostics)) {
            const messages = diagnostics.map((d) => d.message).join('\n')
            this.error(
              `[typeroll] Failed to bundle ${fileName}:\n${messages}`,
            )
          }
          throw error
        }

        // Forward warnings
        for (const warning of result.warnings) {
          this.warn(warning.message)
        }

        // 5. Emit bundled .d.ts as asset
        let code = result.code

        // Post-process: replace temp/tsgo dir paths in #region comments with
        // relative source paths so output is deterministic across runs
        if (tempDir) {
          code = code.replaceAll(tempDir, ctx.rootDir)
        } else if (ctx.tsgoDist) {
          code = code.replaceAll(ctx.tsgoDist, ctx.rootDir)
        }

        if (sourcemap && result.map) {
          // 6. Handle source maps
          const mapFileName = `${fileName}.map`
          const map = JSON.parse(result.map)

          map.file = path.basename(fileName)

          // Remap sources to be relative to the output directory
          if (map.sources) {
            const outputDir = path.resolve(
              outputOptions.dir || path.dirname(fileName),
            )
            const remapDir = tempDir || ctx.tsgoDist
            map.sources = map.sources.map((source: string) => {
              // Sources from Rust are relative to bundleCwd
              const absSource = path.resolve(bundleCwd, source)
              let finalAbs = absSource
              if (remapDir) {
                // Check if source is under remapDir (generated .d.ts).
                // If so, remap to the equivalent path under rootDir.
                // If not (e.g., composed .ts source from .d.ts.map),
                // the absSource is already the correct absolute path.
                const relFromRemap = path.relative(remapDir, absSource)
                if (!relFromRemap.startsWith('..')) {
                  finalAbs = path.resolve(ctx.rootDir, relFromRemap)
                }
              }
              return path.relative(outputDir, finalAbs)
            })
          }

          const mapJson = JSON.stringify(map)

          // Append sourceMappingURL to code
          code += `\n//# sourceMappingURL=${path.basename(mapFileName)}\n`

          // Emit source map asset
          this.emitFile({
            type: 'asset',
            fileName: mapFileName,
            source: mapJson,
          })
        }

        // Emit .d.ts asset
        this.emitFile({
          type: 'asset',
          fileName,
          source: code,
        })
      }

      // 7. If emitDtsOnly, remove remaining non-DTS chunks from bundle
      if (emitDtsOnly) {
        for (const fileName of Object.keys(bundle)) {
          if (
            bundle[fileName].type === 'chunk' &&
            !RE_DTS.test(fileName) &&
            !RE_DTS_MAP.test(fileName)
          ) {
            delete bundle[fileName]
          }
        }
      }

      // 8. Clean up
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {})
      }
      if (ctx.cleanup) {
        await ctx.cleanup()
      }
    },
  }
}

async function generateDtsToDir(
  tempDir: string,
  cwd: string,
  ctx: NativeBundlerContext,
  entryDtsIds: Set<string>,
): Promise<void> {
  const { dtsMap, rootDir } = ctx
  const absRootDir = path.resolve(rootDir)
  const writtenDtsIds = new Set<string>()

  // 1. Generate .d.ts for all modules in dtsMap (discovered by Rolldown)
  for (const [dtsId, mod] of dtsMap) {
    const result = await generateSingleDts(mod.id, mod.code, ctx)
    if (result && 'code' in result) {
      await writeDtsFile(tempDir, absRootDir, dtsId, result.code, result.map)
      writtenDtsIds.add(dtsId)
    } else if (result && 'error' in result && entryDtsIds.has(dtsId)) {
      // Entry file failed to generate — propagate the error
      throw new Error(result.error)
    }
  }

  // 2. Follow the import graph from generated .d.ts files and resolve
  //    missing dependencies: generate from source .ts files, copy existing
  //    .d.ts files from the source tree, or create stubs for JSON/Vue files.
  await scanAndGenerateMissing(tempDir, absRootDir, writtenDtsIds, ctx)

  // 3. Symlink node_modules so the native bundler can resolve packages
  const nodeModulesPath = path.resolve(cwd, 'node_modules')
  const tempNodeModules = path.join(tempDir, 'node_modules')
  if (existsSync(nodeModulesPath) && !existsSync(tempNodeModules)) {
    await symlink(nodeModulesPath, tempNodeModules, 'junction').catch(
      () => {},
    )
  }
}

async function generateSingleDts(
  sourceId: string,
  sourceCode: string,
  ctx: NativeBundlerContext,
): Promise<{ code: string; map?: string } | { error: string } | undefined> {
  if (ctx.oxcOptions) {
    const { isolatedDeclarationSync } = await import('rolldown/experimental')
    const result = isolatedDeclarationSync(sourceId, sourceCode, {
      ...ctx.oxcOptions,
      sourcemap: ctx.sourcemap,
    })
    if (result.errors.length) {
      debug('oxc generation failed for %s: %s', sourceId, result.errors[0].message)
      return { error: result.errors.map((e: any) => e.message).join('\n') }
    }
    return {
      code: result.code,
      map: result.map ? JSON.stringify(result.map) : undefined,
    }
  } else if (ctx.tscEmit) {
    const result = await ctx.tscEmit(sourceId)
    if (result.error) {
      debug('tsc generation failed for %s: %s', sourceId, result.error)
      return { error: result.error }
    }
    if (!result.code) return undefined
    let map: string | undefined
    if (result.map) {
      // tsc's .d.ts.map sources are relative to the tsc-computed outDir, which
      // may differ from where we write the .d.ts. Normalize sources to absolute
      // paths so writeDtsFile can re-relativize them correctly.
      const parsedMap = typeof result.map === 'string'
        ? JSON.parse(result.map)
        : result.map
      parsedMap.sources = [sourceId]
      parsedMap.sourcesContent = [sourceCode]
      map = JSON.stringify(parsedMap)
    }
    return { code: result.code, map }
  }
  return undefined
}

async function writeDtsFile(
  tempDir: string,
  absRootDir: string,
  dtsId: string,
  dtsCode: string,
  dtsMap?: string,
): Promise<void> {
  const relPath = path.relative(absRootDir, dtsId)
  const outPath = path.resolve(tempDir, relPath)
  await mkdir(path.dirname(outPath), { recursive: true })
  debug('generateDtsToDir: writing %s (%d bytes)', outPath, dtsCode.length)
  await writeFile(outPath, dtsCode)
  if (dtsMap) {
    // Normalize map sources to be relative to the .d.ts file's directory.
    // Some tools (e.g., oxc) emit absolute paths in sources; the Rust bundler
    // expects them to be relative to the .d.ts.map file.
    const map = JSON.parse(dtsMap)
    const mapDir = path.dirname(outPath)
    if (map.sources) {
      map.sources = map.sources.map((source: string) =>
        path.isAbsolute(source)
          ? path.relative(mapDir, source)
          : source,
      )
      // Ensure sourcesContent is populated so the Rust bundler can include
      // original .ts content in the composed sourcemap. Some tools (e.g., tsc)
      // omit sourcesContent from .d.ts.map files.
      if (!map.sourcesContent || map.sourcesContent.some((c: any) => c == null)) {
        map.sourcesContent = await Promise.all(
          map.sources.map(async (source: string, i: number) => {
            if (map.sourcesContent?.[i] != null) return map.sourcesContent[i]
            // Try reading from tempDir first, then from original source tree
            const absSource = path.resolve(mapDir, source)
            try {
              return await readFile(absSource, 'utf8')
            } catch {
              // Source doesn't exist in tempDir — try original source tree
              const relToTemp = path.relative(tempDir, absSource)
              const originalAbs = path.resolve(absRootDir, relToTemp)
              try {
                return await readFile(originalAbs, 'utf8')
              } catch {
                return ''
              }
            }
          }),
        )
      }
    }
    await writeFile(`${outPath}.map`, JSON.stringify(map))
  }
}

async function scanAndGenerateMissing(
  tempDir: string,
  absRootDir: string,
  writtenDtsIds: Set<string>,
  ctx: NativeBundlerContext,
): Promise<void> {
  // Follow the import graph from already-generated .d.ts files and resolve
  // missing dependencies on demand. This avoids walking the entire project
  // tree (which is slow and can cause race conditions with concurrent tests).
  const queue: string[] = []
  const visited = new Set<string>()

  // Seed the queue with all files already generated
  for (const dtsId of writtenDtsIds) {
    const relPath = path.relative(absRootDir, dtsId)
    const dtsPath = path.resolve(tempDir, relPath)
    queue.push(dtsPath)
    visited.add(dtsPath)
  }

  while (queue.length > 0) {
    const dtsPath = queue.shift()!
    let code: string
    try {
      code = await readFile(dtsPath, 'utf8')
    } catch {
      continue
    }

    // Find relative imports in the .d.ts file
    const importRegex = /(?:from|import)\s*['"](\.[^'"]+)['"]/g
    let match: RegExpExecArray | null
    while ((match = importRegex.exec(code)) !== null) {
      const specifier = match[1]
      const dir = path.dirname(dtsPath)

      // If specifier already has .d.ts extension (from rewriteNonTsSpecifiers),
      // use it directly as the candidate
      const candidates: string[] = RE_DTS.test(specifier)
        ? [path.resolve(dir, specifier)]
        : [
            path.resolve(dir, `${specifier}.d.ts`),
            path.resolve(dir, `${specifier}.ts`),
            path.resolve(dir, specifier, 'index.d.ts'),
            path.resolve(dir, `${specifier}.d.mts`),
            path.resolve(dir, `${specifier}.d.cts`),
          ]

      // TypeScript preserves source extensions (.ts/.tsx/.mts/.cts) in .d.ts
      // output. Add the corresponding declaration file as a candidate so the
      // import graph walker can discover it.
      if (/\.tsx?$/.test(specifier) && !RE_DTS.test(specifier)) {
        candidates.unshift(path.resolve(dir, specifier.replace(/\.tsx?$/, '.d.ts')))
      } else if (/\.mts$/.test(specifier)) {
        candidates.unshift(path.resolve(dir, specifier.replace(/\.mts$/, '.d.mts')))
      } else if (/\.cts$/.test(specifier)) {
        candidates.unshift(path.resolve(dir, specifier.replace(/\.cts$/, '.d.cts')))
      }

      for (const candidate of candidates) {
        if (visited.has(candidate)) break
        visited.add(candidate)

        if (existsSync(candidate)) {
          queue.push(candidate)
          break
        }

        // Compute the corresponding path in the source tree
        const relToTemp = path.relative(tempDir, candidate)
        const originalAbs = path.resolve(absRootDir, relToTemp)

        // For .json.d.ts stubs, generate from the original .json file
        if (candidate.endsWith('.json.d.ts')) {
          const jsonPath = originalAbs.replace(/\.d\.ts$/, '')
          let jsonContent: string | undefined
          try { jsonContent = await readFile(jsonPath, 'utf8') } catch {}
          const stub = generateJsonDtsStub(jsonContent)
          await mkdir(path.dirname(candidate), { recursive: true })
          await writeFile(candidate, stub)
          queue.push(candidate)
          break
        }

        // For .vue.d.ts stubs, generate a simple component stub
        if (candidate.endsWith('.vue.d.ts')) {
          const stub = 'declare const _default: any;\nexport default _default;\n'
          await mkdir(path.dirname(candidate), { recursive: true })
          await writeFile(candidate, stub)
          queue.push(candidate)
          break
        }

        // Check if the original .d.ts file exists in the source tree
        // (hand-written declaration files that aren't generated)
        if (RE_DTS.test(candidate) && existsSync(originalAbs)) {
          await mkdir(path.dirname(candidate), { recursive: true })
          await copyFile(originalAbs, candidate)
          queue.push(candidate)
          break
        }

        // Try generating from the source .ts file
        const sourceTs = originalAbs.replace(RE_DTS, '.ts')
        if (!existsSync(sourceTs)) continue

        let sourceCode: string
        try {
          sourceCode = await readFile(sourceTs, 'utf8')
        } catch {
          continue
        }

        const dtsId = filename_to_dts(sourceTs)
        if (writtenDtsIds.has(dtsId)) continue

        const result = await generateSingleDts(sourceTs, sourceCode, ctx)
        if (result && 'code' in result) {
          await writeDtsFile(tempDir, absRootDir, dtsId, result.code, result.map)
          queue.push(candidate)
        }
        break
      }
    }
  }
}

/**
 * Generate a simple .d.ts stub for a JSON module from its content.
 */
function generateJsonDtsStub(jsonContent?: string): string {
  if (!jsonContent) return 'declare const _default: any;\nexport default _default;\n'
  try {
    const parsed = JSON.parse(jsonContent)
    if (Array.isArray(parsed)) {
      return 'declare const _default: any[];\nexport default _default;\n'
    }
    if (typeof parsed === 'object' && parsed !== null) {
      const validKeys = Object.keys(parsed).filter((key) => isIdentifierName(key) && !isKeyword(key))
      const exports = validKeys
        .map((key) => `export declare const ${key}: ${typeof parsed[key]};`)
        .join('\n')
      const propKey = (k: string) => (isIdentifierName(k) && !isKeyword(k)) ? k : JSON.stringify(k)
      return `${exports}\ndeclare const _default: { ${Object.keys(parsed).map((k) => `${propKey(k)}: ${typeof parsed[k]}`).join('; ')} };\nexport default _default;\n`
    }
    return `declare const _default: ${typeof parsed};\nexport default _default;\n`
  } catch {
    return 'declare const _default: any;\nexport default _default;\n'
  }
}
