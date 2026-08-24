const fs = require('fs');
const s = fs.readFileSync('src/index.ts', 'utf8');
const lines = s.split('\n');
const stack = [];
let inSingle=false, inDouble=false, inTpl=false, esc=false;
for(let i=0;i<lines.length;i++){
  const line = lines[i];
  for(let j=0;j<line.length;j++){
    const ch = line[j];
    if(esc){esc=false; continue}
    if(ch==='\\') {esc=true; continue}
    if(!inDouble && !inTpl && ch==="'") { inSingle = !inSingle; continue }
    if(!inSingle && !inTpl && ch==='"') { inDouble = !inDouble; continue }
    if(!inSingle && !inDouble && ch==='`') { inTpl = !inTpl; continue }
    if(inSingle || inDouble || inTpl) continue;
    if(ch==='{') stack.push({line:i+1,col:j+1,context:line.trim()});
    else if(ch==='}') stack.pop();
  }
}
console.log('unmatched opens:', JSON.stringify(stack, null, 2));
console.log('total opens', (s.match(/\{/g)||[]).length, 'closes', (s.match(/\}/g)||[]).length);
