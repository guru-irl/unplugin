import fs from 'node:fs';import path from 'node:path';
const dir=path.resolve('fixture/src');fs.mkdirSync(dir,{recursive:true});
const n=Number(process.env.MODULES??60000);let entry='';
for(let i=0;i<n;i++){
 let code='';for(let j=1;j<=3&&i%100>=j;j++)code+=`import { v as x${j} } from './m${i-j}.ts';\n`;
 code+=`export const v = ${i%100===0?1:Array.from({length:Math.min(3,i%100)},(_,j)=>'x'+(j+1)).join(' + ')};\n`;
 fs.writeFileSync(path.join(dir,`m${i}.ts`),code);entry+=`import { v as v${i} } from './m${i}.ts';\n`;
}
entry+='console.log(['+Array.from({length:n},(_,i)=>'v'+i).join(', ')+'].length);\n';fs.writeFileSync(path.join(dir,'index.ts'),entry);console.log(n,'synthetic modules generated');
