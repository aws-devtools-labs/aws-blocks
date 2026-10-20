// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
// Verifier self-test fixture only. Never supplied to the coding agent or used as a Blocks implementation.
import http from 'node:http';
import fs from 'node:fs';
let items=[];
try { items=JSON.parse(fs.readFileSync('/tmp/fixture-data.json')); } catch {}
const html=`<!doctype html><label>Todo title<input id="title"></label><button id="add">Add todo</button><main></main><script>
let items=[];
async function rpc(op,data={}){const r=await fetch('/aws-blocks/api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({op,...data})});items=await r.json();render();}
function render(){const m=document.querySelector('main');m.replaceChildren();for(const x of items){const row=document.createElement('div');row.dataset.testid='todo-item';const text=document.createElement('span');text.textContent=x.title;row.append(text);
const input=(label,value,type='text')=>{const l=document.createElement('label');l.textContent=label;const i=document.createElement('input');i.type=type;i.value=value||'';l.append(i);row.append(l);return i;};
const completed=input('Completed','','checkbox');completed.checked=x.completed;completed.onclick=(event)=>{event.preventDefault();setTimeout(()=>rpc('update',{id:x.id,patch:{completed:!x.completed}}),100);};
const title=input('Edit title',x.title),due=input('Due date',x.due,'date'),labels=input('Labels',(x.labels||[]).join(', '));
for(const value of x.labels||[]){const s=document.createElement('span');s.dataset.testid='todo-label';s.textContent=value;row.append(s);}
const save=document.createElement('button');save.textContent='Save todo';save.onclick=()=>rpc('update',{id:x.id,patch:{title:title.value,due:due.value,labels:labels.value.split(',').map(s=>s.trim()).filter(Boolean)}});row.append(save);
const del=document.createElement('button');del.textContent='Delete todo';del.onclick=()=>rpc('delete',{id:x.id});row.append(del);m.append(row);}}
document.querySelector('#add').onclick=async()=>{await rpc('add',{title:document.querySelector('#title').value});document.querySelector('#title').value='';};rpc('list');
</script>`;
http.createServer((req,res)=>{if(req.method==='GET'){res.setHeader('Content-Type','text/html');res.end(html);return;}let body='';req.on('data',x=>body+=x);req.on('end',()=>{const b=JSON.parse(body);if(b.op==='add')items.push({id:crypto.randomUUID(),title:b.title,completed:false,due:'',labels:[]});if(b.op==='update'){const item=items.find(x=>x.id===b.id);if(b.patch.labels&&process.env.BUG!=='labels')b.patch.labels=[...new Set(b.patch.labels)];if(process.env.BUG==='completion')delete b.patch.completed;Object.assign(item,b.patch);}if(b.op==='delete')items=items.filter(x=>x.id!==b.id);fs.writeFileSync('/tmp/fixture-data.json',JSON.stringify(items));res.setHeader('Content-Type','application/json');res.end(JSON.stringify(items));});}).listen(3000);
