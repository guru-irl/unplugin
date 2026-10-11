import { definitionForFixture, fixtureKind } from './filters.mjs';
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
let compiler,state;const rss=()=>process.memoryUsage().rss/1048576;
function start(){counts.use=counts.include=0;state={time:performance.now(),cpu:process.cpuUsage()};console.log(JSON.stringify({event:'start',pid:process.pid}));}
function end(stats){if(stats.hasErrors())throw Error(stats.toString({all:false,errors:true}));const wall=performance.now()-state.time,cpu=process.cpuUsage(state.cpu),end=rss();console.log(JSON.stringify({event:'endpoint',end_rss_mib:end}));const sha=crypto.createHash('sha256').update(fs.readFileSync(path.join(output,'bundle.js'))).digest('hex');console.log(JSON.stringify({event:'result',arm,phase,pair:Number(pair),fixture_kind:fixtureKind,wall_ms:wall,cpu_ms:(cpu.user+cpu.system)/1000,end_rss_mib:end,counts:{...counts},output_sha256:sha,modules:stats.compilation.modules.size}));}
const close=()=>new Promise((res,rej)=>compiler.close(e=>e?rej(e):res()));
if(phase!=='edit'){
 start();compiler=rspack(config);const stats=await new Promise((res,rej)=>compiler.run((e,s)=>e?rej(e):res(s)));end(stats);await close();
}else{
 compiler=rspack(config);let resolve,reject;let round=new Promise((r,j)=>{resolve=r;reject=j});let index=0;
 const watching=compiler.watch({aggregateTimeout:20},(e,s)=>{if(e){reject(e);return}if(index===1)end(s);else if(s.hasErrors()){reject(Error(s.toString()));return}resolve(s)});
 await round;await new Promise(r=>setTimeout(r,1500));
 const leaf=path.join(fixture,'src/m0.ts'),orig=fs.readFileSync(leaf,'utf8');round=new Promise((r,j)=>{resolve=r;reject=j});index=1;start();fs.writeFileSync(leaf,orig+'\n// synthetic edit\n');await round;
 await new Promise((res,rej)=>watching.close(e=>e?rej(e):res()));await close();fs.writeFileSync(leaf,orig);
}
