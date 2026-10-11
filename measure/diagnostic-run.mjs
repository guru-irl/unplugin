import { definitionForFixture, fixtureKind } from './filters.mjs';
import readline from 'node:readline';
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);const {rspack}=require('@rspack/core');
const [arm,phase,pair]=process.argv.slice(2);const fixture=path.resolve('fixture');const cacheDir=path.resolve('cache',`${fixtureKind}-${arm}-${pair}`);const output=path.resolve('output');
const {createUnplugin}=await import(path.resolve(arm==='base'?'../baseline/dist/index.mjs':'../dist/index.mjs'));
const counts={use:0,include:0};
const definition=definitionForFixture();
const wrap=rules=>{for(const r of rules){if(typeof r.use==='function'){const f=r.use;r.use=function(...a){counts.use++;return f.apply(this,a)}}if(typeof r.include==='function'){const f=r.include;r.include=function(...a){counts.include++;return f.apply(this,a)}}if(r.rules)wrap(r.rules)}};
const unplugin=createUnplugin(()=>definition).rspack();const plugin={apply(c){unplugin.apply(c);c.hooks.beforeRun.tap({name:'Count',stage:Infinity},()=>wrap(c.options.module.rules));c.hooks.watchRun.tap({name:'Count',stage:Infinity},()=>wrap(c.options.module.rules));}};
if(phase==='cold')fs.rmSync(cacheDir,{recursive:true,force:true});
const config={mode:'development',context:fixture,entry:'./src/index.ts',devtool:false,output:{path:output,filename:'bundle.js'},optimization:{concatenateModules:false,minimize:false},module:{rules:[{test:/\.ts$/,type:'javascript/auto'}]},plugins:[plugin],cache:{type:'persistent',storage:{type:'filesystem',directory:cacheDir},buildDependencies:[path.resolve('run.mjs'),path.resolve('filters.mjs')]},experiments:{newCache:true},infrastructureLogging:{level:'error'},stats:'none'};
const input=readline.createInterface({input:process.stdin});const replies=input[Symbol.asyncIterator]();
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let inFlight=0,maxInFlight=0,built=0,succeeded=0;
const state={time:performance.now(),cpu:process.cpuUsage()};console.log(JSON.stringify({event:'start',pid:process.pid}));
const compiler=rspack(config);
compiler.hooks.thisCompilation.tap('DiagnosticConcurrency',compilation=>{
 compilation.hooks.buildModule.tap('DiagnosticConcurrency',()=>{built++;inFlight++;maxInFlight=Math.max(maxInFlight,inFlight)});
 compilation.hooks.succeedModule.tap('DiagnosticConcurrency',()=>{succeeded++;inFlight--});
});
const stats=await new Promise((res,rej)=>compiler.run((e,s)=>e?rej(e):res(s)));
const wall=performance.now()-state.time,cpu=process.cpuUsage(state.cpu);
if(stats.hasErrors())throw Error(stats.toString({all:false,errors:true}));
async function snapshot(stage){
 const memory=process.memoryUsage();console.log(JSON.stringify({event:'snapshot',stage,pid:process.pid,heap_used_mib:memory.heapUsed/1048576,heap_total_mib:memory.heapTotal/1048576,external_mib:memory.external/1048576,node_rss_mib:memory.rss/1048576}));
 const reply=await replies.next();if(reply.done||reply.value!==stage)throw Error(`Missing snapshot ack: ${stage}`);
}
await snapshot('end');
global.gc();global.gc();await sleep(1000);await snapshot('gc');
await sleep(10000);await snapshot('idle10');
await sleep(50000);await snapshot('idle60');
const sha=crypto.createHash('sha256').update(fs.readFileSync(path.join(output,'bundle.js'))).digest('hex');
console.log(JSON.stringify({event:'result',arm,phase:'cold',pair:Number(pair),fixture_kind:fixtureKind,wall_ms:wall,cpu_ms:(cpu.user+cpu.system)/1000,counts:{...counts},max_in_flight:maxInFlight,built,succeeded,in_flight_at_end:inFlight,output_sha256:sha,modules:stats.compilation.modules.size}));
input.close();await new Promise((res,rej)=>compiler.close(e=>e?rej(e):res()));
