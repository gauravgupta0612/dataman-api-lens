const fs = require('fs'); const path = require('path');
const { scan } = require('../src/scanner');
function walk(d, acc=[]) { for (const f of fs.readdirSync(d)) { const p = path.join(d,f); fs.statSync(p).isDirectory()? walk(p,acc): acc.push({file:p, text: fs.readFileSync(p,'utf8')}); } return acc; }
const root = path.resolve(process.argv[2] || path.join(__dirname,'fixtures'));
const res = scan(walk(root));
for (const e of res.endpoints) {
  const ps = e.params.map(p => `${p.in}:${p.name}${p.required?'*':''}`).join(' ');
  console.log(`${e.method.padEnd(6)} ${e.path.padEnd(40)} [${e.framework}] ${path.relative(root,e.file)}:${e.line+1}  ${ps}  ${e.body.mode!=='none'? 'BODY('+e.body.mode+')='+JSON.stringify(e.body.example):''}`);
}
console.log('hints', JSON.stringify(res.hints));
