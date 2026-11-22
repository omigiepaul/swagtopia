import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.dirname(fileURLToPath(import.meta.url));
const children=[];
let stopping=false;
const apiPort=Number(process.env.API_PORT||3001);

function start(args,extraEnv={}){
  const child=spawn(process.execPath,args,{cwd:root,stdio:'inherit',env:{...process.env,...extraEnv}});
  children.push(child);
  child.on('error',error=>{console.error('Could not start development process:',error);stop(1)});
  child.on('exit',(code)=>{if(!stopping)stop(code||0)});
  return child;
}

function stop(code=0){
  if(stopping)return;
  stopping=true;
  for(const child of children)if(!child.killed)child.kill();
  process.exitCode=code;
}

process.on('SIGINT',()=>stop(0));
process.on('SIGTERM',()=>stop(0));

async function apiIsReady(){
  try{return (await fetch(`http://127.0.0.1:${apiPort}/api/health`)).ok}catch{return false}
}

async function main(){
  if(!await apiIsReady()){
    start(['server.mjs'],{API_PORT:String(apiPort),TRUST_PROXY:'1'});
    const deadline=Date.now()+10_000;
    while(Date.now()<deadline&&!stopping){
      if(await apiIsReady())break;
      await new Promise(resolve=>setTimeout(resolve,200));
    }
    if(stopping)return;
    if(!await apiIsReady()){
      console.error(`Fan wall API did not become ready on port ${apiPort}.`);
      stop(1);return;
    }
  }else{
    console.log(`Using existing Swagtopia API on port ${apiPort}.`);
  }
  start([path.join(root,'node_modules','vite','bin','vite.js'),'--host','0.0.0.0']);
}

main().catch(error=>{console.error(error);stop(1)});
