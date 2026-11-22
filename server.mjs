import {createServer} from 'node:http';
import {readFile, mkdir, rename, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.SWAGTOPIA_DATA_DIR || path.join(root, 'data');
const dataFile = path.join(dataDir, 'store.json');
const mailingListFile = path.join(dataDir, 'zen-mailing-list.csv');
const port = Number(process.env.API_PORT || process.env.PORT || 3001);
const maxBodyBytes = 16 * 1024;
const latestCount = 50;
const rateWindowMs = 60_000;
const allRequestLimit = 120_000;
const apiRequestLimit = 60_000;
const submissionLimit = 20;
const trustProxy = process.env.TRUST_PROXY === '1';
const requestRates = new Map();
const apiRates = new Map();
const submissionRates = new Map();
const staticCache = new Map();
let writes = Promise.resolve();
let storeCache;

async function readStore(){
  if(storeCache)return storeCache;
  await mkdir(dataDir, {recursive:true});
  try {
    const store=JSON.parse(await readFile(dataFile, 'utf8'));
    store.posts=Array.isArray(store.posts)?store.posts:[];
    store.signups=Array.isArray(store.signups)?store.signups:[];
    storeCache=store;
    return storeCache;
  }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const fresh = {posts:[], signups:[]};
    await writeFile(dataFile, JSON.stringify(fresh, null, 2), {encoding:'utf8', flag:'wx'}).catch(e=>{if(e.code!=='EEXIST')throw e});
    storeCache=fresh;
    return storeCache;
  }
}

async function updateStore(change,{syncMailingList=false}={}){
  const operation = writes.then(async()=>{
    const store = structuredClone(await readStore());
    const result = change(store);
    const tempFile = `${dataFile}.tmp`;
    await writeFile(tempFile, JSON.stringify(store, null, 2), 'utf8');
    await rename(tempFile, dataFile);
    storeCache=store;
    if(syncMailingList)await writeMailingList(store.signups);
    return result;
  });
  writes = operation.catch(()=>{});
  return operation;
}

function csvCell(value){
  let text=String(value??'');
  if(/^[=+\-@\t\r]/.test(text))text=`'${text}`;
  return `"${text.replaceAll('"','""')}"`;
}

async function writeMailingList(signups){
  const rows=[['Name','Email'],...signups.map(({n,e})=>[n,e])];
  const temporary=`${mailingListFile}.tmp`;
  await writeFile(temporary,rows.map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n','utf8');
  await rename(temporary,mailingListFile);
}

function json(res, status, value, extraHeaders={}){
  const body = JSON.stringify(value);
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(body),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...extraHeaders});
  res.end(body);
}

function clientKey(req){
  if(trustProxy){
    const forwarded=req.headers['x-forwarded-for'];
    if(typeof forwarded==='string'&&forwarded.trim())return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress||'unknown';
}

function consumeRateLimit(map,key,limit){
  const now = Date.now();
  const entry = map.get(key);
  if(!entry||now>=entry.resetAt){
    map.set(key,{resetAt:now+rateWindowMs,count:1});
    if(map.size>20_000){for(const [client,bucket] of map)if(now>=bucket.resetAt)map.delete(client)}
    return {allowed:true,retryAfter:0};
  }
  if(entry.count>=limit)return {allowed:false,retryAfter:Math.max(1,Math.ceil((entry.resetAt-now)/1000))};
  entry.count+=1;
  return {allowed:true,retryAfter:0};
}

async function bodyJson(req){
  const chunks=[]; let size=0;
  for await (const chunk of req) {
    size+=chunk.length;
    if(size>maxBodyBytes) throw Object.assign(new Error('Request too large'),{status:413});
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON'),{status:400}); }
}

function clean(value, max){ return typeof value==='string' ? value.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max) : ''; }
function validEmail(value){ return value.length<=254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }

const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.mp4':'video/mp4'};
async function staticFile(urlPath, res){
  const decoded=decodeURIComponent(urlPath);
  let target=path.resolve(root,'dist', decoded==='/'?'index.html':`.${decoded}`);
  const dist=path.resolve(root,'dist')+path.sep;
  if(target!==path.resolve(root,'dist','index.html')&&!target.startsWith(dist)) return false;
  try {
    let contents=staticCache.get(target);
    if(!contents){
      try { contents=await readFile(target); }
      catch(error) {
        if(path.extname(decoded))return false;
        target=path.join(root,'dist','index.html');
        contents=staticCache.get(target)||await readFile(target);
      }
      staticCache.set(target,contents);
    }
    const cache=target.includes(`${path.sep}assets${path.sep}`)?'public, max-age=31536000, immutable':target.endsWith('index.html')?'no-cache':'public, max-age=3600';
    res.writeHead(200,{'Content-Type':mime[path.extname(target)]||'application/octet-stream','Content-Length':contents.length,'Cache-Control':cache,'X-Content-Type-Options':'nosniff'});
    res.end(contents); return true;
  } catch { return false; }
}

await writeMailingList((await readStore()).signups);

const server=createServer(async(req,res)=>{
  const url=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`);
  const key=clientKey(req);
  try {
    const globalRate=consumeRateLimit(requestRates,key,allRequestLimit);
    if(!globalRate.allowed)return json(res,429,{ok:false,error:'rate_limited',message:'Request limit reached. Try again shortly.'},{'Retry-After':String(globalRate.retryAfter)});
    const isApi=url.pathname==='/api'||url.pathname.startsWith('/api/');
    if(isApi){
      const apiRate=consumeRateLimit(apiRates,key,apiRequestLimit);
      if(!apiRate.allowed)return json(res,429,{ok:false,error:'api_rate_limited',message:'API request limit reached. Try again shortly.'},{'Retry-After':String(apiRate.retryAfter)});
    }
    if(url.pathname==='/api/health'&&req.method==='GET') return json(res,200,{ok:true});
    if(url.pathname==='/api/posts'&&req.method==='GET') {
      const store=await readStore();
      const posts=store.posts.filter(p=>p.visible!==false).slice(-latestCount).reverse().map(({n,t,createdAt})=>({n,t,createdAt}));
      return json(res,200,{posts});
    }
    if(url.pathname==='/api/posts'&&req.method==='POST') {
      const writeRate=consumeRateLimit(submissionRates,key,submissionLimit);
      if(!writeRate.allowed)return json(res,429,{ok:false,error:'submission_rate_limited',message:'Please wait before submitting again.'},{'Retry-After':String(writeRate.retryAfter)});
      const body=await bodyJson(req); const n=clean(body.n,30); const t=clean(body.t,240);
      if(!n||!t) return json(res,400,{ok:false,error:'name_and_message_required'});
      const post={id:randomUUID(),n,t,createdAt:new Date().toISOString(),visible:true};
      await updateStore(store=>{store.posts.push(post);store.posts=store.posts.slice(-5000)});
      return json(res,201,{ok:true,post:{n:post.n,t:post.t,createdAt:post.createdAt}});
    }
    if(url.pathname==='/api/signups'&&req.method==='POST') {
      const writeRate=consumeRateLimit(submissionRates,key,submissionLimit);
      if(!writeRate.allowed)return json(res,429,{ok:false,error:'submission_rate_limited',message:'Please wait before submitting again.'},{'Retry-After':String(writeRate.retryAfter)});
      const body=await bodyJson(req); const n=clean(body.n,30); const e=clean(body.e,254).toLowerCase();
      if(!n||!validEmail(e)) return json(res,400,{ok:false,error:'valid_name_and_email_required'});
      const entry={id:randomUUID(),n,e,createdAt:new Date().toISOString()};
      const created=await updateStore(store=>{if(store.signups.some(s=>s.e===e))return false;store.signups.push(entry);store.signups=store.signups.slice(-10000);return true},{syncMailingList:true});
      return json(res,created?201:200,{ok:true,duplicate:!created});
    }
    if(req.method==='GET'&&!url.pathname.startsWith('/api/')) {
      if(await staticFile(url.pathname,res))return;
    }
    return json(res,404,{ok:false,error:'not_found'});
  } catch(error) {
    console.error(error);
    return json(res,error.status||500,{ok:false,error:error.status?error.message:'server_error'});
  }
});

server.keepAliveTimeout=65_000;
server.headersTimeout=70_000;
server.requestTimeout=30_000;
server.maxRequestsPerSocket=1_000;
server.maxConnections=20_000;
server.listen({port,host:'0.0.0.0',backlog:10_000},()=>console.log(`Swagtopia server listening on http://localhost:${port}`));
