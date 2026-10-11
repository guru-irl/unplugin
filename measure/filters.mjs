import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import picomatch from 'picomatch';
export const globFilter = { include: ['**/*.tsx', '**/src/**/*.ts'], exclude: ['**/node_modules/**'] };
export const regexpFilter = { include: [/\.tsx$/, /[\\/]src[\\/](?:[^\\/]+[\\/])*[^\\/]+\.ts$/], exclude: [/[\\/]node_modules[\\/]/] };
export const fixtureKind = process.env.FILTER_KIND ?? 'glob';
assert(['glob','regexp','hook-shapes'].includes(fixtureKind));
export const idFilter = fixtureKind === 'glob' ? globFilter : regexpFilter;
const globInclude = globFilter.include.map(x => picomatch(x, {dot:true}));
const globExclude = globFilter.exclude.map(x => picomatch(x, {dot:true}));
function decision(id, include, exclude) { return !exclude.some(f => f(id)) && include.some(f => f(id)); }
let checked = 0, matched = 0;
function walk(dir) {
  for (const entry of fs.readdirSync(dir, {withFileTypes:true})) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else {
      const normalized = p.replaceAll('\\','/');
      const a = decision(normalized, globInclude, globExclude);
      const b = decision(normalized, regexpFilter.include.map(r => id => r.test(id)), regexpFilter.exclude.map(r => id => r.test(id)));
      assert.equal(a,b,`Glob/RegExp mismatch: ${p}`); checked++; matched += Number(a);
    }
  }
}
walk(path.resolve('fixture'));
assert.equal(checked, 60001); assert.equal(matched, 60001);
console.log(JSON.stringify({event:'match_sets',fixture_kind:fixtureKind,checked,matched,filters:{glob:globFilter,regexp:{include:regexpFilter.include.map(String),exclude:regexpFilter.exclude.map(String)}}}));

export function definitionForFixture() {
  if (fixtureKind !== 'hook-shapes') return {name:'synthetic-filter',transform:{filter:{id:idFilter},handler(code){return code}},load:{filter:{id:idFilter},handler(){return null}}};
  const extension = /\.(m|c)?(j|t)sx?$/;
  // Synthetic code predicates exercise loader-side checks without reproducing
  // any package's transform implementation. No glob exclusions in this arm.
  const code = [/export\s+const/, /console\.log/, /import\s*\{/];
  return [
    {name:'reference-shape', transform:{filter:{id:extension,code},handler(source){return source}}},
    {name:'virtual-shape', transform:{filter:{id:/tsr-split/},handler(source){return source}}},
    {name:'shared-shape', transform:{filter:{id:/tsr-shared/},handler(source){return source}}},
    {name:'hmr-shape', transform:{filter:{id:extension,code},handler(source){return source}}},
  ];
}
if (fixtureKind === 'hook-shapes') {
  let modules = 0;
  for (const entry of fs.readdirSync(path.resolve('fixture/src'))) {
    const id = path.resolve('fixture/src',entry);
    assert(extensionDecision(id));
    assert(!/tsr-split/.test(id)); assert(!/tsr-shared/.test(id));
    assert(/tsr-split/.test(id+'?tsr-split')); assert(/tsr-shared/.test(id+'?tsr-shared'));
    modules++;
  }
  console.log(JSON.stringify({event:'hook_shape_sets',modules,extension_matches:modules,plain_query_matches:0,query_probes:modules*2}));
}
function extensionDecision(id) { return /\.(m|c)?(j|t)sx?$/.test(id); }
