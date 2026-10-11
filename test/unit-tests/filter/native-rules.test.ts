import type { UnpluginOptions } from '../../../src/types'
import { resolve } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { getRspackPlugin } from '../../../src/rspack'
import rspackTransform from '../../../src/rspack/loaders/transform'
import { normalizeObjectHook } from '../../../src/utils/filter'
import { getWebpackPlugin } from '../../../src/webpack'
import webpackTransform from '../../../src/webpack/loaders/transform'

function createStartHook() {
  const callbacks: (() => void)[] = []
  return { tap(_name: unknown, callback: () => void) { callbacks.push(callback) }, async promise(_compiler: unknown) { for (const callback of callbacks) callback() } }
}

function setup(getPlugin: typeof getRspackPlugin | typeof getWebpackPlugin, definition: UnpluginOptions) {
  const compiler = {
    options: { context: process.cwd(), module: { rules: [] as any[] } },
    rspack: { version: '2.0.0', experiments: {} },
    webpack: { version: '5.0.0' },
    hooks: { beforeRun: createStartHook(), watchRun: createStartHook() },
  }
  getPlugin(() => definition)({}).apply(compiler as any)
  return compiler
}

function condition(condition: any, value: string): boolean {
  if (condition == null)
    return true
  if (condition instanceof RegExp)
    return condition.test(value)
  if (typeof condition === 'function')
    return condition(value)
  if (Array.isArray(condition))
    return condition.some(item => conditionMatch(item, value))
  return (!condition.and || condition.and.every((item: any) => conditionMatch(item, value)))
    && (!condition.or || condition.or.some((item: any) => conditionMatch(item, value)))
    && (!condition.not || !conditionMatch(condition.not, value))
}
const conditionMatch = condition

function uses(rules: any[], resource: string, resourceQuery = '', resourceFragment = ''): any[] {
  return rules.flatMap((rule) => {
    if (!condition(rule.resource, resource) || !condition(rule.resourceQuery, resourceQuery)
      || !condition(rule.resourceFragment, resourceFragment)
      || !condition(rule.include, resource) || (rule.exclude && condition(rule.exclude, resource)))
      return []
    if (rule.rules)
      return uses(rule.rules, resource, resourceQuery, resourceFragment)
    return typeof rule.use === 'function' ? rule.use({ resource, resourceQuery, resourceFragment }) : rule.use || []
  })
}

describe.each([[getRspackPlugin, rspackTransform], [getWebpackPlugin, webpackTransform]] as const)('native rules (%#)', (getPlugin, loader) => {
  it('matches the JS decision table without callbacks for plain resources', async () => {
    const cwd = process.cwd()
    const filters = [
      { include: ['**/*.tsx', '**/src/**/*.ts'], exclude: ['**/node_modules/**'] },
      { include: /\.(ts|tsx)$/i, exclude: /node_modules/ },
      { include: ['src/**/*.ts'], exclude: ['src/skip.ts'] },
    ]
    const cases = [
      ['/src/a.ts', '', '', [true, true, true]],
      ['/src/.hidden.ts', '', '', [true, true, true]],
      ['/src/a.tsx', '', '', [true, true, false]],
      ['/src/a.TS', '', '', [false, true, false]],
      ['/src/a.js', '', '', [false, false, false]],
      ['/src/skip.ts', '', '', [true, true, false]],
      ['/node_modules/src/a.ts', '', '', [false, false, false]],
      ['/src/a.ts', '?raw', '', [false, false, false]],
      ['/src/a.js', '?x.ts', '', [true, true, true]],
      ['/src/a.ts', '?raw\n', '', [false, false, false]],
      ['/src/a.ts', '', '#raw', [true, true, true]],
      ['/src/a.js', '', '#x.ts', [false, false, false]],
      ['/src/a.ts', '', '#raw\n', [true, true, true]],
      ['/src/a\\b.ts', '', '', [true, true, true]],
    ] as const
    for (const [index, id] of filters.entries()) {
      const compiler = setup(getPlugin, { name: 'rules', enforce: 'pre', transform: { filter: { id }, handler: code => code }, load: { filter: { id }, handler: () => null } })
      await compiler.hooks.beforeRun.promise(compiler)
      const rules = compiler.options.module.rules
      if (process.platform !== 'win32') {
        expect(Array.isArray(rules[0].use)).toBe(true)
        expect(rules).toHaveLength(4)
        expect(rules[0].enforce).toBe('pre')
        expect(rules[1].rules[0].rules[0].enforce).toBe('pre')
      }
      for (const [suffix, query, fragment, expected] of cases) {
        const resource = cwd + suffix
        const actual = uses(rules, resource, query, fragment)
        const transformDecision = actual.some(use => use.ident === 'rules')
        const loadDecision = actual.some(use => !use.ident)
        expect(transformDecision, resource + query + fragment).toBe(expected[index])
        expect(transformDecision).toBe(normalizeObjectHook('load', { filter: { id }, handler: () => null }).filter(resource + query))
        expect(loadDecision).toBe(normalizeObjectHook('load', { filter: { id }, handler: () => null }).filter(resource))
      }
    }
  })

  it('keeps accessor, Proxy, function, legacy and unsafe filters on the lazy JS path', async () => {
    let reads = 0
    const accessor = { get filter() { reads++; return { id: '**/*.ts' } }, handler: (code: string) => code }
    const hooks = [accessor, new Proxy({ filter: { id: '**/*.ts' }, handler: (code: string) => code }, {}),
      { filter: { id: /\.ts$/g }, handler: (code: string) => code },
      { filter: { id: '!**/*.js' }, handler: (code: string) => code },
      (code: string) => code]
    for (const transform of hooks) {
      const compiler = setup(getPlugin, { name: 'lazy', transform })
      await compiler.hooks.beforeRun.promise(compiler)
      expect(reads).toBe(0)
      expect(typeof compiler.options.module.rules[0].use).toBe('function')
      expect(uses(compiler.options.module.rules, resolve('src/a.ts')).length > 0).toBe(normalizeObjectHook('load', transform).filter(resolve('src/a.ts')))
      if (transform === accessor)
        reads = 0
    }
    const compiler = setup(getPlugin, { name: 'legacy', transform: { filter: { id: '**/*.ts' }, handler: code => code }, transformInclude: () => false })
    await compiler.hooks.beforeRun.promise(compiler)
    expect(typeof compiler.options.module.rules[0].use).toBe('function')
    expect(uses(compiler.options.module.rules, resolve('src/a.ts'))).toHaveLength(0)
  })

  it('snapshots data filters and cwd at first build start but resolves handlers lazily', async () => {
    const originalCwd = process.cwd()
    const first = resolve(import.meta.dirname, 'test-src')
    const second = resolve(import.meta.dirname, '../resolve-id/test-src')
    try {
      process.chdir(first)
      const hook = { filter: { id: '*.js' }, handler: (code: string) => `${code}:first` }
      const compiler = setup(getPlugin, { name: 'snapshot', transform: hook })
      hook.filter.id = '*.ts'
      process.chdir(second)
      await compiler.hooks.watchRun.promise(compiler)
      hook.filter.id = '*.js'
      process.chdir(first)
      const selected = uses(compiler.options.module.rules, resolve(second, 'mod.ts'))
      expect(selected).toHaveLength(1)
      expect(uses(compiler.options.module.rules, resolve(first, 'mod.ts'))).toHaveLength(0)
      const plugin = selected[0].options.plugin
      plugin.transform = { filter: { id: '*.js' }, handler: (code: string) => `${code}:replacement` }
      let result: unknown
      await (loader as typeof rspackTransform).call({ query: selected[0].options, resource: resolve(second, 'mod.ts'), async: () => (error: Error | null, code: string) => { if (error) throw error; result = code } } as any, 'source', undefined)
      expect(result).toBe('source:replacement')
      await compiler.hooks.beforeRun.promise(compiler)
      expect(uses(compiler.options.module.rules, resolve(second, 'mod.ts'))).toHaveLength(1)
    }
    finally { process.chdir(originalCwd) }
  })
})
