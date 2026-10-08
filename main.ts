
/* Poker Dynasty V88 — Deno Deploy / Deno KV adapter.
 * UTF-8-safe Career snapshot and world chunking.
 * Existing storage keys and revision CAS are preserved.
 */
import { handle } from './rooms.mjs';
import { handleCareer } from './career84.mjs';

const CORS={
 'Access-Control-Allow-Origin':'*',
 'Access-Control-Allow-Methods':'GET, POST, OPTIONS',
 'Access-Control-Allow-Headers':'Content-Type, Authorization',
 'Access-Control-Max-Age':'600',
 'Cache-Control':'no-store',
 'X-Content-Type-Options':'nosniff',
 'Content-Type':'application/json; charset=utf-8'
};

const kv=await Deno.openKv();
const te=new TextEncoder();

const hex=(a:Uint8Array)=>
 Array.from(a,b=>b.toString(16).padStart(2,'0')).join('');

async function sha(s:string){
 return hex(new Uint8Array(
  await crypto.subtle.digest('SHA-256',te.encode(s))
 ));
}

function stable(x:any):any{
 if(Array.isArray(x))return x.map(stable);
 if(x&&typeof x==='object')
  return Object.fromEntries(
   Object.keys(x).sort().map(k=>[k,stable(x[k])])
  );
 return x;
}

const roomKey=(code:string)=>
 ['room',String(code).toUpperCase()] as Deno.KvKey;

const worldKey=(code:string)=>
 ['world',String(code).toUpperCase()] as Deno.KvKey;

const worldMetaKey=(code:string)=>
 ['world2',String(code).toUpperCase(),'meta'] as Deno.KvKey;

const worldChunkKey=(code:string,rev:number,n:number)=>
 ['world2',String(code).toUpperCase(),'rev',rev,'chunk',n] as Deno.KvKey;

const snapMeta=(ref:string)=>
 ['snapshot',ref,'meta'] as Deno.KvKey;

const snapChunk=(ref:string,n:number)=>
 ['snapshot',ref,'chunk',n] as Deno.KvKey;

const ENTRY_PREFIX='pd84e-entry|';

/*
 * Keep encoded UTF-8 chunks below the Deno KV value limit.
 * Never split a Unicode code point.
 */
const CHUNK=48_000;

function chunksOf(value:string):string[]{
 const parts:string[]=[];
 let start=0, index=0, bytes=0;

 for(const cp of value){
  const size=te.encode(cp).length;

  if(bytes+size>CHUNK&&index>start){
   parts.push(value.slice(start,index));
   start=index;
   bytes=0;
  }

  bytes+=size;
  index+=cp.length;
 }

 if(index>start)
  parts.push(value.slice(start,index));

 return parts;
}

async function snapshotGet(ref:string){
 const m=await kv.get<any>(snapMeta(ref));
 if(!m.value)return null;

 const parts:string[]=[];

 for(let i=0;i<m.value.chunks;i++){
  const p=await kv.get<string>(snapChunk(ref,i));

  if(typeof p.value!=='string')
   return null;

  parts.push(p.value);
 }

 return parts.join('');
}

async function snapshotPut(ref:string,text:string){
 const existing=await snapshotGet(ref);

 if(existing!==null){
  if(existing!==text)
   throw Error('Immutable snapshot reference conflict');

  return;
 }

 const parts=chunksOf(text);

 for(let i=0;i<parts.length;i++){
  const key=snapChunk(ref,i);
  const cur=await kv.get<string>(key);

  if(cur.value!==null&&cur.value!==parts[i])
   throw Error('Immutable snapshot chunk conflict');

  if(cur.value===null)
   await kv.set(key,parts[i]);
 }

 const sum=await sha(text);
 const check=await kv.get(snapMeta(ref));

 if(check.value){
  if(check.value.sha!==sum)
   throw Error('Immutable snapshot reference conflict');

  return;
 }

 await kv.atomic()
  .check(check)
  .set(
   snapMeta(ref),
   {
    chunks:parts.length,
    sha:sum,
    createdAt:Date.now()
   }
  )
  .commit();
}

/*
 * Preserve existing V84 worlds and chunked-world compatibility.
 */
async function careerLoad(code:string){
 code=String(code).toUpperCase();

 const meta=await kv.get<any>(worldMetaKey(code));

 if(meta.value){
  const parts:string[]=[];

  for(let i=0;i<meta.value.chunks;i++){
   const p=await kv.get<string>(
    worldChunkKey(code,meta.value.revision,i)
   );

   if(typeof p.value!=='string')
    throw Error('World chunk missing');

   parts.push(p.value);
  }

  return JSON.parse(parts.join(''));
 }

 return (await kv.get<any>(worldKey(code))).value??null;
}

async function careerCreate(w:any){
 const code=String(w.worldCode).toUpperCase();

 const legacy=await kv.get<any>(worldKey(code));
 const meta=await kv.get<any>(worldMetaKey(code));

 if(legacy.value||meta.value)
  return false;

 const raw=JSON.stringify(w);
 const parts=chunksOf(raw);

 const ttl=Math.max(
  60_000,
  w.expiresAt-Date.now()
 );

 for(let i=0;i<parts.length;i++){
  await kv.set(
   worldChunkKey(code,w.revision,i),
   parts[i],
   {expireIn:ttl}
  );
 }

 return (
  await kv.atomic()
   .check(meta)
   .check(legacy)
   .set(
    worldMetaKey(code),
    {
     revision:w.revision,
     chunks:parts.length
    },
    {expireIn:ttl}
   )
   .commit()
 ).ok;
}

async function careerCas(w:any,rev:number){
 const code=String(w.worldCode).toUpperCase();

 const meta=await kv.get<any>(worldMetaKey(code));
 const legacy=await kv.get<any>(worldKey(code));

 const current=
  meta.value?.revision ??
  legacy.value?.revision;

 if(current!==rev)
  return false;

 const raw=JSON.stringify(w);
 const parts=chunksOf(raw);

 const ttl=Math.max(
  60_000,
  w.expiresAt-Date.now()
 );

 for(let i=0;i<parts.length;i++){
  await kv.set(
   worldChunkKey(code,w.revision,i),
   parts[i],
   {expireIn:ttl}
  );
 }

 const tx=kv.atomic()
  .check(meta)
  .check(legacy)
  .set(
   worldMetaKey(code),
   {
    revision:w.revision,
    chunks:parts.length
   },
   {expireIn:ttl}
  );

 if(legacy.value)
  tx.delete(worldKey(code));

 return (await tx.commit()).ok;
}

const store:any={
 entryReplay:true,

 async health(){
  await kv.get(['health']);
 },

 async load(code:string){
  return (
   await kv.get<any>(roomKey(code))
  ).value??null;
 },

 async create(r:any){
  const got=await kv.get(roomKey(r.code));

  return (
   await kv.atomic()
    .check(got)
    .set(
     roomKey(r.code),
     r,
     {
      expireIn:Math.max(
       60_000,
       r.expiresAt-Date.now()
      )
     }
    )
    .commit()
  ).ok;
 },

 async cas(r:any,rev:number){
  const got=await kv.get<any>(roomKey(r.code));

  if(!got.value||got.value.revision!==rev)
   return false;

  return (
   await kv.atomic()
    .check(got)
    .set(
     roomKey(r.code),
     r,
     {
      expireIn:Math.max(
       60_000,
       r.expiresAt-Date.now()
      )
     }
    )
    .commit()
  ).ok;
 },

 async rate(
  key:string,
  max:number,
  expires:number
 ){
  const k=['rate',key] as Deno.KvKey;

  for(let n=0;n<8;n++){
   const g=await kv.get<number>(k);
   const count=(g.value??0)+1;

   const res=await kv.atomic()
    .check(g)
    .set(
     k,
     count,
     {
      expireIn:Math.max(
       1000,
       expires-Date.now()
      )
     }
    )
    .commit();

   if(res.ok)
    return count<=max;
  }

  return false;
 },

 careerLoad,
 careerCreate,
 careerCas,

 careerSnapshotPut:snapshotPut,
 careerSnapshotGet:snapshotGet,

 async prune(_now:number){}
};

function err(
 message:string,
 code:string,
 status=409
){
 return new Response(
  JSON.stringify({
   error:message,
   code
  }),
  {
   status,
   headers:CORS
  }
 );
}

async function withEntryReceipt(
 request:Request,
 handler:(r:Request)=>Promise<Response>
){
 const op=new URL(request.url).pathname;

 if(
  request.method!=='POST' ||
  ![
   '/api/career84/create',
   '/api/career84/join'
  ].includes(op)
 )
  return handler(request);

 let body:any;

 try{
  body=await request.clone().json();
 }catch{
  return handler(request);
 }

 if(body.entryKey==null)
  return handler(request);

 if(!/^[a-f0-9]{64}$/.test(body.entryKey))
  return err(
   'A 256-bit entry recovery key is required.',
   'invalid_entry_key',
   400
  );

 const keyHash=await sha(
  ENTRY_PREFIX+body.entryKey
 );

 const fingerprint=await sha(
  op+'|'+JSON.stringify(stable(body))
 );

 const rk=['entry',keyHash] as Deno.KvKey;
 const old=await kv.get<any>(rk);

 if(old.value){
  const e=old.value;

  if(
   e.fingerprint!==fingerprint ||
   e.operation!==op
  )
   return err(
    'This recovery key already belongs to a different request. Do not change the pending request.',
    'entry_conflict'
   );

  const w=await store.careerLoad(e.worldCode);

  const p=w?.players?.find(
   (x:any)=>x.playerUuid===e.playerUuid
  );

  if(!p)
   return err(
    'This entry already completed, but the original world is no longer available. No replacement world was created.',
    'entry_world_unavailable',
    410
   );

  const expected=await sha(
   'pd84-session|'+e.body.sessionToken
  );

  if(
   p.sessionHash!==expected ||
   p.sessionExpiresAt<Date.now() ||
   p.status!=='active'
  )
   return err(
    'Your world and player already exist. Sign in to that World Code and Player UUID; the old entry cannot replace a newer session.',
    'entry_session_replaced'
   );

  const fresh=await handler(
   new Request(
    request.url.replace(
     /\/(create|join)$/,
     '/world/'+e.worldCode
    ),
    {
     method:'POST',
     headers:{
      ...CORS,
      Authorization:
       'Bearer '+e.body.sessionToken
     },
     body:JSON.stringify({
      type:'poll'
     })
    }
   )
  );

  if(!fresh.ok)
   return fresh;

  const data=await fresh.json();

  return new Response(
   JSON.stringify({
    ...e.body,
    view:data.view,
    entryReplayed:true
   }),
   {headers:CORS}
  );
 }

 const result=await handler(request);

 if(!result.ok)
  return result;

 const answer=await result.clone().json();

 if(
  !answer.worldCode ||
  !answer.playerUuid ||
  !answer.sessionToken
 )
  throw Error(
   'The entry did not return a complete identity.'
  );

 const receipt={
  fingerprint,
  operation:op,
  worldCode:answer.worldCode,
  playerUuid:answer.playerUuid,
  body:answer,
  createdAt:Date.now()
 };

 const again=await kv.get(rk);

 if(again.value)
  return withEntryReceipt(
   request,
   handler
  );

 await kv.atomic()
  .check(again)
  .set(
   rk,
   receipt,
   {
    expireIn:
     31*86400000
   }
  )
  .commit();

 return result;
}

let serial=Promise.resolve();

function serialized<T>(
 fn:()=>Promise<T>
):Promise<T>{
 const p=serial
  .catch(()=>{})
  .then(fn) as Promise<T>;

 serial=p.then(
  ()=>undefined,
  ()=>undefined
 );

 return p;
}

async function route(req:Request){
 const u=new URL(req.url);
 const p=u.pathname;

 if(
  req.method==='OPTIONS' &&
  (
   p.startsWith('/api/') ||
   p==='/health'
  )
 )
  return new Response(
   null,
   {
    status:204,
    headers:CORS
   }
  );

 if(p==='/health')
  return new Response(
   JSON.stringify({
    ok:true,
    service:'PokerDynastyRooms',
    runtime:'deno-kv'
   }),
   {headers:CORS}
  );

 if(!p.startsWith('/api/'))
  return new Response(
   'Poker Dynasty multiplayer backend is online.',
   {
    status:p==='/'?200:404,
    headers:{
     'Content-Type':
      'text/plain; charset=utf-8',
     'Cache-Control':'no-store'
    }
   }
  );

 const headers=new Headers(req.headers);

 headers.set(
  'x-real-ip',
  req.headers.get('cf-connecting-ip') ||
  req.headers.get('x-forwarded-for') ||
  'deno'
 );

 const safe=new Request(
  req.url,
  {
   method:req.method,
   headers,
   body:
    ['GET','HEAD'].includes(req.method)
     ? undefined
     : req.body,

   duplex:'half' as any
  }
 );

 return serialized(
  ()=>
   p.startsWith('/api/career84/')
    ? withEntryReceipt(
       safe,
       r=>handleCareer(r,store)
      )
    : handle(safe,store)
 );
}

Deno.serve(
 async req=>{
  try{
   return await route(req);
  }catch(e){
   console.error(e);

   return new Response(
    JSON.stringify({
     error:
      'Room service temporarily unavailable.'
    }),
    {
     status:503,
     headers:CORS
    }
   );
  }
 }
);
