const fs=require('fs');
const s=fs.readFileSync('src/index.ts','utf8');
const lines=s.split('\n');
const stack=[];let inS=false,inD=false,inT=false,esc=false;
for(let i=0;i<lines.length;i++){
  const line=lines[i];
  for(let j=0;j<line.length;j++){
    const ch=line[j];
    if(esc){esc=false;continue}
    if(ch==='\\'){esc=true;continue}
    if(!inD && !inT && ch==="'"){inS=!inS;continue}
    if(!inS && !inT && ch==='"'){inD=!inD;continue}
    if(!inS && !inD && ch==='`'){inT=!inT;continue}
    if(inS||inD||inT) continue;
    if(ch==='{') stack.push({line:i+1,col:j+1,ctx:lines[i].trim()});
    else if(ch==='}') stack.pop();
  }
}
console.log('unmatched opens count',stack.length);
stack.forEach(o=>{
  console.log('--- open at',o.line,o.col,o.ctx);
  const start=Math.max(0,o.line-5);
  const end=Math.min(lines.length,o.line+20);
  for(let k=start;k<end;k++) console.log((k+1).toString().padStart(4),'|',lines[k]);
});
