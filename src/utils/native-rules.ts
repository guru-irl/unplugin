import type { RuleSetRule, RuleSetUseItem } from '@rspack/core'
import type { ResolvedUnpluginOptions, StringFilter, StringOrRegExp } from '../types'
import type { PluginFilter } from './filter'
import { types } from 'node:util'
import picomatch from 'picomatch'
import { getMatcherString, normalizeObjectHook } from './filter'

// Missing properties are data too. Never inspect a Proxy or invoke accessors.
function data(object: object, key: string): { value: unknown } | undefined {
  if (types.isProxy(object))
    return
  const descriptor = Object.getOwnPropertyDescriptor(object, key)
  if (descriptor)
    return 'value' in descriptor ? { value: descriptor.value } : undefined
  const prototype = Object.getPrototypeOf(object)
  if (prototype === Object.prototype || prototype === null)
    return { value: undefined }
}

function pattern(value: unknown): StringOrRegExp | undefined {
  if (typeof value === 'string')
    return value
  if (typeof value === 'object' && value !== null && !types.isProxy(value) && value instanceof RegExp && Object.getPrototypeOf(value) === RegExp.prototype
    && !Object.hasOwn(value, 'source') && !Object.hasOwn(value, 'flags') && !Object.hasOwn(value, 'test')) {
    return new RegExp(value.source, value.flags)
  }
}

function patterns(value: unknown): StringOrRegExp[] | undefined {
  if (!Array.isArray(value) || types.isProxy(value)) {
    const single = pattern(value)
    return single === undefined ? undefined : [single]
  }
  const result: StringOrRegExp[] = []
  for (let index = 0; index < value.length; index++) {
    const item = data(value, String(index))
    const copy = item && pattern(item.value)
    if (copy === undefined)
      return
    result.push(copy)
  }
  return result
}

function stringFilter(value: unknown): { value: StringFilter | undefined } | undefined {
  if (!value)
    return { value: undefined }
  const list = patterns(value)
  if (list)
    return { value: list }
  if (typeof value !== 'object' || value === null)
    return
  const include = data(value, 'include')
  const exclude = data(value, 'exclude')
  if (!include || !exclude)
    return
  const includes = include.value ? patterns(include.value) : []
  const excludes = exclude.value ? patterns(exclude.value) : []
  if (!includes || !excludes)
    return
  return { value: { include: includes, exclude: excludes } }
}

function snapshot(plugin: ResolvedUnpluginOptions, name: 'load' | 'transform'): { id: StringFilter | undefined, code: StringFilter | undefined } | undefined {
  const legacy = data(plugin, name === 'load' ? 'loadInclude' : 'transformInclude')
  const hook = data(plugin, name)
  if (!legacy || legacy.value || !hook || typeof hook.value !== 'object' || hook.value === null)
    return
  const filter = data(hook.value, 'filter')
  if (!filter || typeof filter.value === 'function')
    return
  if (!filter.value)
    return { id: undefined, code: undefined }
  if (typeof filter.value !== 'object')
    return
  const id = data(filter.value, 'id')
  const code = name === 'transform' ? data(filter.value, 'code') : { value: undefined }
  if (!id || !code)
    return
  const idCopy = stringFilter(id.value)
  const codeCopy = stringFilter(code.value)
  if (!idCopy || !codeCopy)
    return
  return { id: idCopy.value, code: codeCopy.value }
}

function nativePatterns(filter: StringFilter | undefined): { include?: RegExp[], exclude?: RegExp[] } | undefined {
  let include: StringOrRegExp[] = []
  let exclude: StringOrRegExp[] = []
  if (Array.isArray(filter)) {
    include = filter
  }
  else if (filter) {
    if (typeof filter === 'string' || filter instanceof RegExp) {
      include = [filter]
    }
    else {
      include = filter.include ? Array.isArray(filter.include) ? filter.include : [filter.include] : []
      exclude = filter.exclude ? Array.isArray(filter.exclude) ? filter.exclude : [filter.exclude] : []
    }
  }
  const convert = (items: StringOrRegExp[]): RegExp[] | undefined => {
    const result: RegExp[] = []
    for (const item of items) {
      if (item instanceof RegExp) {
        // Do not assume Unicode set/astral semantics match native engines.
        if (/[gyuv]/.test(item.flags))
          return
        result.push(item)
      }
      else {
        // Negation, escapes, extglobs and unusual syntax retain the JS path.
        if (!/^[\w./*? -]+$/.test(item) || item.startsWith('!'))
          return
        result.push(picomatch.makeRe(getMatcherString(item, process.cwd()), { dot: true }))
      }
    }
    return result
  }
  const includes = convert(include)
  const excludes = convert(exclude)
  if (!includes || !excludes)
    return
  return { include: includes.length ? includes : undefined, exclude: excludes.length ? excludes : undefined }
}

// Both path normalizers leave these POSIX paths untouched. Others use JS.
// eslint-disable-next-line regexp/no-useless-assertions, regexp/prefer-predefined-assertion
const CANONICAL_RESOURCE = /^(?![\s\S]*\/\/)(?![\s\S]*(?:^|\/)\.{1,2}(?:\/|$))(?![\s\S]*\/$)[\w./ -]+$(?![\s\S])/
// Unlike $, this cannot accept the position before a trailing newline.
// eslint-disable-next-line regexp/prefer-predefined-assertion
const EMPTY = /^(?![\s\S])/

export function prepareNativeRule(
  compiler: { options: { module: { rules: any[] } }, hooks: { beforeRun: { tap: (options: { name: string, stage: number }, callback: () => void) => void }, watchRun: { tap: (options: { name: string, stage: number }, callback: () => void) => void } } },
  plugin: ResolvedUnpluginOptions,
  name: 'load' | 'transform',
  rule: RuleSetRule,
  use: RuleSetUseItem[],
): { filter: PluginFilter, readonly snapshot: boolean } {
  let idFilter: PluginFilter | undefined
  let initialized = false
  const start = () => {
    if (initialized)
      return
    initialized = true
    const copy = snapshot(plugin, name)
    if (!copy)
      return
    idFilter = normalizeObjectHook('load', { handler: () => null, filter: { id: copy.id } }).filter
    if (name === 'transform')
      plugin.__transformFilterSnapshot = normalizeObjectHook('transform', { handler: () => null, filter: copy }).filter
    // Loads also decode virtual ids and consult dynamic externals.
    if (process.platform === 'win32' || copy.code || (name === 'load' && plugin.resolveId))
      return
    const native = nativePatterns(copy.id)
    if (!native)
      return
    const index = compiler.options.module.rules.indexOf(rule)
    if (index < 0)
      return
    const safeResource = name === 'load'
      ? { and: [CANONICAL_RESOURCE, { not: new RegExp(`^${plugin.__virtualModulePrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }] }
      : CANONICAL_RESOURCE
    const fast = { ...rule, ...native, resource: safeResource, resourceQuery: EMPTY, resourceFragment: EMPTY, use }
    // Parent guards run before child include callbacks. The three fallback
    // branches are disjoint and exactly complement the safe plain rule.
    const fallback = {
      rules: [
        { resource: { not: safeResource }, rules: [rule] },
        { resource: safeResource, resourceQuery: { not: EMPTY }, rules: [rule] },
        { resource: safeResource, resourceQuery: EMPTY, resourceFragment: { not: EMPTY }, rules: [rule] },
      ],
    }
    compiler.options.module.rules.splice(index, 1, fast, fallback)
  }
  // Rspack reads options once in #getInstance; webpack compiles rules at its
  // first build start. Snapshot after other start taps, never during apply.
  compiler.hooks.beforeRun.tap({ name: plugin.name, stage: Number.POSITIVE_INFINITY }, start)
  compiler.hooks.watchRun.tap({ name: plugin.name, stage: Number.POSITIVE_INFINITY }, start)
  return {
    filter: id => idFilter ? idFilter(id) : true,
    get snapshot() {
      return idFilter !== undefined
    },
  }
}
