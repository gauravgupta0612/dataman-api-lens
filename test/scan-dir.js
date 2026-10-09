const fs=require('fs'),path=require('path');const {scan}=require('../src/scanner');
const SKIP=/node_modules|\.git|dist|build|target|venv|__pycache__/;
function walk(d,a=[]){for(const f of fs.readdirSync(d)){const p=path.join(d,f);if(SKIP.test(f))continue;let s;try{s=fs.statSync(p)}catch(e){continue};if(s.isDirectory())walk(p,a);else if(s.size<512000&&/\.(js|ts|py|java|kt|cs|go|php|rb|rs|json|ya?ml|properties)$/.test(f))a.push({file:p,text:fs.readFileSync(p,'utf8')});}return a;}
const root=path.resolve(process.argv[2]);const t=Date.now();const files=walk(root);const r=scan(files);
console.log(files.length,'files',r.endpoints.length,'endpoints',Date.now()-t,'ms');
for(const e of r.endpoints.slice(0,+process.argv[3]||15))console.log(e.method.padEnd(6),e.path.padEnd(45),e.framework,e.params.map(p=>p.in+':'+p.name).join(' '),e.body.mode!=='none'?JSON.stringify(e.body.example).slice(0,80):'');
