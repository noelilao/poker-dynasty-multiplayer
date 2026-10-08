/* Poker Dynasty V84.2 — persistent shared Career and life-economy authority.
 * The service owns identities, sessions, the world clock, tournament actions,
 * ordered native snapshots and exactly-once completion receipts. V84.2 property, lease, furniture, fitness and home-table transactions are
 * server-owned. Inherited jobs, NPC business and single-player simulations remain
 * cooperative client code; snapshot checks do not certify those simulations.
 */
import Life842 from './life842-core.mjs';
import {handleHome,homeTick,homeViews,homeBlockers} from './life842-homegames.mjs';
import { decodeNativeSnapshot, nativeChecksum, founderBankroll, safeTree } from './career84-integrity.mjs';
import { WORLD_CITIES, VARIANT_START, VARIANT_FORMAL } from './career84-world-policy.mjs';
import { handleTournament, tickTournaments, tournamentViews, tournamentBlockers, tournamentNextEvent, tournamentMetadata, isTournamentCommand } from './career84-tournaments.mjs';

export const CAREER_VERSION='84.2.0';
export const CAREER_PROTOCOL=2;
const WORLD_TTL=3650*86400000, SESSION_TTL=30*86400000;
const CONNECTED=60000, HEARTBEAT=15000, HOST_GRACE=90000, CHALLENGE_TTL=120000, RECOVERY_TTL=86400000;
const MAX_SNAPSHOT=8*1024*1024, MAX_CLOCK_STEP=366*1440, MAX_PLAYERS=16, MAX_MONEY=1e12;
const CODE_ALPHABET='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const encoder=new TextEncoder();
export class CareerError extends Error{constructor(message,status=400,code='invalid_request'){super(message);this.status=status;this.code=code;}}
const fail=(m,s=400,c='invalid_request')=>{throw new CareerError(m,s,c)};
const clone=x=>x==null?null:JSON.parse(JSON.stringify(x));
const randomBytes=n=>crypto.getRandomValues(new Uint8Array(n));
const hex=a=>Array.from(a,b=>b.toString(16).padStart(2,'0')).join('');
const randomHex=n=>hex(randomBytes(n));
const newCode=()=>Array.from(randomBytes(8),b=>CODE_ALPHABET[b%CODE_ALPHABET.length]).join('');
const uuid=()=>crypto.randomUUID();
async function digest(value){return hex(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(String(value)))));}
async function hmacHex(keyHex,message){const key=await crypto.subtle.importKey('raw',Uint8Array.from(keyHex.match(/../g),x=>parseInt(x,16)),{name:'HMAC',hash:'SHA-256'},false,['sign']);return hex(new Uint8Array(await crypto.subtle.sign('HMAC',key,encoder.encode(message))));}
function timingSafeHex(a,b){if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;let v=0;for(let i=0;i<a.length;i++)v|=a.charCodeAt(i)^b.charCodeAt(i);return v===0;}
function codeText(v){if(typeof v!=='string')fail('Enter the World Code.');const c=v.toUpperCase().replace(/[\s-]/g,'');if(!/^[A-HJ-NP-Z2-9]{8}$/.test(c))fail('World Codes have eight letters or numbers.');return c;}
function text(v,fallback,max=40){if(v==null)return fallback;if(typeof v!=='string')fail('Invalid text value.');return v.normalize('NFKC').replace(/[<>\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,'').trim().slice(0,max)||fallback;}
function int(v,lo,hi,label){v=Number(v);if(!Number.isSafeInteger(v)||v<lo||v>hi)fail(`${label} must be a whole number from ${lo} to ${hi}.`);return v;}
function money(v,label='Amount'){v=Number(v);if(!Number.isFinite(v)||v<0||v>MAX_MONEY||Math.abs(v*100-Math.round(v*100))>.0001)fail(label+' must be non-negative money with at most two decimal places.');return Math.round(v*100);}
function credential(input){if(!input||typeof input!=='object'||Array.isArray(input))fail('Password credential is required.');const salt=String(input.salt||'').toLowerCase(),verifier=String(input.verifier||'').toLowerCase(),iterations=Number(input.iterations);if(!/^[a-f0-9]{32,128}$/.test(salt)||salt.length%2||!/^[a-f0-9]{64}$/.test(verifier)||!Number.isSafeInteger(iterations)||iterations<100000||iterations>1000000)fail('Invalid password credential.');return{salt,verifier,iterations};}
function minuteValue(v){return int(v,Math.floor(Date.UTC(1829,0,1)/60000),Math.floor(Date.UTC(9998,11,31,23,59)/60000),'World minute');}
function calendar(minute){const d=new Date(minute*60000);return{year:d.getUTCFullYear(),month:d.getUTCMonth()+1,day:d.getUTCDate(),hour:d.getUTCHours(),minute:d.getUTCMinutes()};}
function cityId(value,fallback='us_la_neworleans'){const v=text(value,fallback,96);if(!/^[a-zA-Z0-9_.:-]{1,96}$/.test(v))fail('Invalid Career city identifier.');return v;}
function location(input){if(input==null)return null;if(typeof input==='string')return{city:cityId(input),mapId:null};if(typeof input==='object'&&!Array.isArray(input))return{city:cityId(input.city||input.id),mapId:text(input.mapId||'','',128)||null};fail('Invalid location.');}
function eraLabel(y){return y<1850?'Poker origins':y<1900?'Nineteenth century':y<1946?'Early twentieth century':y<1971?'Postwar poker':y<2003?'Modern tournament circuit':y<=2026?'Online and global poker':'Future dynasty';}
function settingsFrom(input={},fallbackMinute,validateCity=true){
 if(!input||typeof input!=='object'||Array.isArray(input))fail('Invalid world settings.');
 const old=Number.isSafeInteger(fallbackMinute)?calendar(minuteValue(fallbackMinute)):{year:1965,month:1,day:1,hour:18,minute:0};
 const year=int(input.startYear??old.year,1829,9998,'Starting year'),month=int(input.startMonth??old.month,1,12,'Starting month'),day=int(input.startDay??old.day,1,31,'Starting day'),hour=int(input.startHour??old.hour,0,23,'Starting hour'),minute=int(input.startMinute??old.minute,0,59,'Starting minute');
 const d=new Date(Date.UTC(year,month-1,day,hour,minute));if(d.getUTCFullYear()!==year||d.getUTCMonth()+1!==month||d.getUTCDate()!==day)fail('That starting calendar date does not exist.');
 const startingCity=cityId(input.startingCity,year<1931?'us_la_neworleans':'vegas');
 const city=WORLD_CITIES[startingCity];if(validateCity){if(!city)fail('Choose a supported Career starting city.');if(city.start&&Date.parse(city.start+'T00:00:00Z')>d.getTime())fail(city.name+' is not available on that starting date.');}
 const joinPolicy=input.joinPolicy??'open';if(!['open','closed'].includes(joinPolicy))fail('Choose open or closed world joining.');
 if(input.clockMode!=null&&input.clockMode!=='consensus')fail('Shared Career uses consensus clock acceleration.');
 return {startYear:year,startMonth:month,startDay:day,startHour:hour,startMinute:minute,startingCity,clockMode:'consensus',realSecondsPerGameMinute:int(input.realSecondsPerGameMinute??60,1,3600,'Seconds per Career minute'),joinPolicy,maxPlayers:int(input.maxPlayers??16,2,MAX_PLAYERS,'World player limit'),autoCohost:input.autoCohost!==false,era:eraLabel(year)};
}
function startMinute(settings){return Math.floor(Date.UTC(settings.startYear,settings.startMonth-1,settings.startDay,settings.startHour,settings.startMinute)/60000);}
function newCharacter(w,p,legacy=false){const y=calendar(w.clock.minute).year;return{schema:1,worldUuid:w.worldUuid,playerUuid:p.playerUuid,characterUuid:uuid(),worldSeed:w.seed,createdMinute:w.clock.minute,startingCity:w.settings.startingCity,startingBankroll:founderBankroll(y),startingYear:y,founderName:p.name,bound:false,legacy};}
function ensureWorld(w){
 if(!w)return null;if(w.schema!==1||!['84.0.0','84.1.0',CAREER_VERSION].includes(w.version)||!w.worldUuid||!w.worldCode||!Array.isArray(w.players))fail('Unsupported Multiplayer Career world.',409,'world_schema');
 const legacy=w.version==='84.0.0',upgrade=w.version!==CAREER_VERSION||!w.life842;w.version=CAREER_VERSION;w._migrationPending=upgrade||!!w._migrationPending;
 w.events=Array.isArray(w.events)?w.events:[];w.recoveryRequests=Array.isArray(w.recoveryRequests)?w.recoveryRequests:[];w.tournaments=w.tournaments&&typeof w.tournaments==='object'?w.tournaments:{};
 w.clock=w.clock&&typeof w.clock==='object'?w.clock:{minute:startMinute(settingsFrom()),paused:false,pauseReason:null};
 w.settings=w.settings||settingsFrom({startingCity:w.players[0]?.location?.city||'vegas'},w.clock.minute,false);
 w.start=w.start||{...calendar(startMinute(w.settings)),minute:startMinute(w.settings),city:w.settings.startingCity,era:w.settings.era};
 w.clock.lastTickAt=Number.isFinite(w.clock.lastTickAt)?w.clock.lastTickAt:(w.updatedAt||w.createdAt);w.clock.remainderMs=Number(w.clock.remainderMs)||0;
 w.chat=Array.isArray(w.chat)?w.chat:[];w.hostHistory=Array.isArray(w.hostHistory)?w.hostHistory:[];
 for(const p of w.players){p.seen=Array.isArray(p.seen)?p.seen:[];p.completions=Array.isArray(p.completions)?p.completions:[];p.muted=Array.isArray(p.muted)?p.muted:[];p.blocked=Array.isArray(p.blocked)?p.blocked:[];p.authChallenges=Array.isArray(p.authChallenges)?p.authChallenges:[];p.tournaments=p.tournaments||{};p.location=location(p.location);p.character=p.character||newCharacter(w,p,legacy&&!!p.snapshot);p.role=p.playerUuid===w.hostPlayerUuid?'host':p.role==='cohost'?'cohost':'player';if(!p.wallet)p.wallet={balanceCents:Math.round(p.character.startingBankroll*100),revision:0,ledger:[],source:'native-founder'};p.wallet.ledger=p.wallet.ledger||[];}
 Life842.seed(w);for(const p of w.players){Life842.person(w,p.playerUuid);p.life842Sequence=p.life842Sequence||0;}
 return w;
}
function findPlayer(w,id){return w.players.find(p=>p.playerUuid===id&&p.status!=='removed');}
function isConnected(p,now){return p.status==='active'&&!p.away&&!!p.sessionHash&&now-p.lastSeen<CONNECTED;}
function connectedPlayers(w,now){return w.players.filter(p=>isConnected(p,now));}
function event(w,type,message,at,playerUuid=null){w.events.push({id:randomHex(6),type,message:text(message,'Event',220),at,worldMinute:w.clock.minute,playerUuid});w.events=w.events.slice(-160);}
async function rotateSession(p,now){const token=randomHex(32);p.sessionHash=await digest('pd84-session|'+token);p.sessionGeneration=(p.sessionGeneration||0)+1;p.sessionExpiresAt=now+SESSION_TTL;p.lastSeen=now;p.away=false;return token;}
async function authenticate(w,authorization,now){
 if(typeof authorization!=='string'||!/^Bearer [a-f0-9]{64}$/.test(authorization))fail('Sign in to this Multiplayer Career world.',401,'unauthorized');
 const h=await digest('pd84-session|'+authorization.slice(7)),p=w.players.find(x=>x.sessionHash&&timingSafeHex(x.sessionHash,h)&&x.status!=='removed');
 if(!p||p.sessionExpiresAt&&p.sessionExpiresAt<now)fail('This device session expired or was replaced. Sign in again.',401,'unauthorized');
 if(p.status==='suspended')fail('The host suspended this player. Ask the host to restore access.',403,'player_suspended');
 return p;
}
function requireHost(w,p){if(p.playerUuid!==w.hostPlayerUuid)fail('Only the world host can do that.',403,'host_only');}
function requireModerator(w,p){if(p.playerUuid!==w.hostPlayerUuid&&p.role!=='cohost')fail('Only the host or a designated cohost can do that.',403,'host_only');}
function walletChange(w,p,amount,reason,ref,now){
 if(typeof p==='string')p=findPlayer(w,p);if(!p)fail('Player wallet was not found.');
 const delta=Math.round(Number(amount)*100);if(!Number.isSafeInteger(delta)||Math.abs(delta)>MAX_MONEY*100)fail('Invalid server wallet change.');
 if(typeof ref!=='string'||!ref.length||ref.length>240)fail('Wallet changes need an idempotent reference.');
 const prior=p.wallet.ledger.find(x=>x.ref===ref);if(prior){if(prior.deltaCents!==delta)fail('Wallet reference has a different amount.',409,'wallet_ref_conflict');return prior;}
 if(delta<0&&!p.character?.bound)fail('Create and save this shared Career before spending tournament entry funds.',409,'character_unbound');
 if(p.wallet.balanceCents+delta<0)fail('Not enough Career bankroll for this entry.',409,'insufficient_funds');
 p.wallet.balanceCents+=delta;p.wallet.revision++;
 const receipt={id:'wallet_'+randomHex(12),ref,kind:String(reason||'tournament'),amount:delta/100,deltaCents:delta,balance:p.wallet.balanceCents/100,revision:p.wallet.revision,at:now,worldMinute:w.clock.minute};
 p.wallet.ledger.push(receipt);return receipt;
}
const debit=(w,p,amount,reason,ref,now)=>walletChange(w,p,-money(amount)/100,reason,ref,now);
const credit=(w,p,amount,reason,ref,now)=>walletChange(w,p,money(amount)/100,reason,ref,now);
function lifeContext(store,now=Date.now()){return{...helpers(store),cities:WORLD_CITIES,now};}
function helpers(store){return{fail,event,uuid,randomHex,clone,debit,credit,connected:isConnected,findPlayer,founderBankroll,hostGraceMs:HOST_GRACE,archiveTournament:async(w,t)=>{
 if(t.archiveRef)return t.archiveRef;if(!store?.careerSnapshotPut)return null;
 const data=JSON.stringify({format:'PokerDynastyTournamentArchive',version:CAREER_VERSION,worldUuid:w.worldUuid,tournament:clone(t)}),checksum=await digest(data),ref=`${w.worldUuid}/tournaments/${t.id}/complete-${t.checkpointNo}-${checksum}`;
 await store.careerSnapshotPut(ref,data);return ref;
 }};}
function activeBlockers(w,now){
 const out=[];for(const p of w.players)if(p.status==='active'&&p.blocker?.active&&(isConnected(p,now)||p.blocker.persistent))out.push({playerUuid:p.playerUuid,kind:p.blocker.kind||'poker',label:p.blocker.label||'Active poker'});
 return [...out,...tournamentBlockers(w,now),...homeBlockers(w)];
}
function settleAvailability(w,now){
 let changed=false;
 for(const p of w.players){const a=p.availability;if(!a||a.until>w.clock.minute)continue;
  if(a.kind==='travel'&&a.destination)p.location=clone(a.destination);
  const done={...clone(a),completedAt:a.until,completedServerAt:now,acknowledgedAt:null};p.lastCompletedAvailability=done;p.completions.push(done);p.availability=null;
  p.completions=p.completions.filter(x=>!x.acknowledgedAt||now-x.acknowledgedAt<7*86400000).slice(-128);
  event(w,'activity',`${p.name} completed ${a.label||a.kind}.`,now,p.playerUuid);changed=true;
 }return changed;
}
function transferHost(w,target,now,automatic=false){
 const old=findPlayer(w,w.hostPlayerUuid);if(old&&old.playerUuid!==target.playerUuid)old.role=automatic?'cohost':'player';
 w.hostPlayerUuid=target.playerUuid;target.role='host';w.hostHistory.push({from:old?.playerUuid||null,to:target.playerUuid,at:now,automatic});w.hostHistory=w.hostHistory.slice(-64);
 if(w.clock.pauseReason==='host-disconnected'){w.clock.paused=false;w.clock.pauseReason=null;}
 event(w,'host',`${target.name} ${automatic?'assumed host authority as a designated cohost':'is now the world host'}.`,now,target.playerUuid);
}
function hostClock(w,now){
 let changed=false;let host=findPlayer(w,w.hostPlayerUuid);
 if(!host||host.status!=='active'||!host.sessionHash||now-host.lastSeen>=HOST_GRACE){
  const replacement=w.settings.autoCohost?w.players.filter(p=>p.role==='cohost'&&isConnected(p,now)).sort((a,b)=>a.joinedAt-b.joinedAt||a.playerUuid.localeCompare(b.playerUuid))[0]:null;
  if(replacement){transferHost(w,replacement,now,true);changed=true;host=replacement;}
  else if(!w.clock.paused||w.clock.pauseReason==='host-disconnected'&&w.clock.hostAbsentSince!==host?.lastSeen){if(!w.clock.paused){w.clock.paused=true;w.clock.pauseReason='host-disconnected';event(w,'clock','Shared world paused after the host connection grace period.',now);}w.clock.hostAbsentSince=host?.lastSeen||now;changed=true;}
 }else if(w.clock.paused&&w.clock.pauseReason==='host-disconnected'){w.clock.paused=false;w.clock.pauseReason=null;w.clock.hostAbsentSince=null;event(w,'clock','Host reconnected. Shared world resumed.',now,host.playerUuid);changed=true;}
 return changed;
}
async function pulse(w,now,{accelerate=true}={},store){
 let changed=hostClock(w,now);const last=w.clock.lastTickAt||now,elapsed=Math.max(0,now-last);w.clock.lastTickAt=now;
 if(!w.clock.paused&&connectedPlayers(w,now).length){
  // A long period without any poll is not offline Career income/time accrual.
  const liveElapsed=elapsed<=CONNECTED?elapsed:0,total=w.clock.remainderMs+liveElapsed,unit=w.settings.realSecondsPerGameMinute*1000,minutes=Math.floor(total/unit);w.clock.remainderMs=total%unit;
  if(minutes){w.clock.minute=minuteValue(w.clock.minute+minutes);changed=true;}
 }else w.clock.remainderMs=0;
 changed=Life842.tick(w,lifeContext(store,now))||changed;
 changed=homeTick(w,now,lifeContext(store,now))||changed;
 changed=settleAvailability(w,now)||changed;
 changed=await tickTournaments(w,now,helpers(store))||changed;
 if(accelerate&&!w.clock.paused&&!activeBlockers(w,now).length){
  const online=connectedPlayers(w,now);
  if(online.length&&online.every(p=>p.availability)){
   const all=w.players.filter(p=>p.status==='active'&&p.availability).map(p=>p.availability);
   const nextTournament=tournamentNextEvent(w);const target=Math.min(...all.map(a=>a.until),nextTournament??Infinity,Life842.nextEvent(w));
   if(target>w.clock.minute){w.clock.minute=minuteValue(target);w.clock.remainderMs=0;event(w,'clock','Shared time advanced to the next scheduled completion after every connected player became unavailable.',now);changed=true;}
   changed=Life842.tick(w,lifeContext(store,now))||changed;
   changed=settleAvailability(w,now)||changed;
  }
 }
 return changed;
}
function publicAvailability(a){return a?{id:a.id,kind:a.kind,from:a.from,until:a.until,label:a.label||a.kind,destination:clone(a.destination||null)}:null;}
function cleanPlayer(w,p,now){return{playerUuid:p.playerUuid,name:p.name,role:p.role,host:p.playerUuid===w.hostPlayerUuid,joinedAt:p.joinedAt,lastSeen:p.lastSeen,connected:isConnected(p,now),status:p.status||'active',location:clone(p.location),availability:publicAvailability(p.availability),snapshotRevision:p.snapshot?.revision||0,tournamentIds:Object.keys(p.tournaments||{}),tournamentStats:clone(p.tournamentStats||null)};}
async function view(w,p,now,includeSnapshot=false,store){
 const players=w.players.filter(x=>x.status!=='removed').map(x=>cleanPlayer(w,x,now)),own=players.find(x=>x.playerUuid===p.playerUuid)||cleanPlayer(w,p,now);
 Object.assign(own,{life842Sequence:p.life842Sequence||0,character:clone(p.character),availability:clone(p.availability),lastCompletedAvailability:clone(p.lastCompletedAvailability),completions:clone(p.completions.filter(x=>!x.acknowledgedAt)),snapshotChecksum:p.snapshot?.checksum||null,wallet:{balance:p.wallet.balanceCents/100,revision:p.wallet.revision,ledger:clone(p.wallet.ledger)},muted:clone(p.muted),blocked:clone(p.blocked),tournamentResults:clone(p.tournamentResults||[]),sessionGeneration:p.sessionGeneration||0});
 if(includeSnapshot&&p.snapshot){own.snapshot=clone(p.snapshot);if(!own.snapshot.text&&own.snapshot.storageRef){if(!store?.careerSnapshotGet)fail('Snapshot storage is not available.',503,'snapshot_storage_unavailable');own.snapshot.text=await store.careerSnapshotGet(own.snapshot.storageRef);if(!own.snapshot.text)fail('The stored Career snapshot could not be read. The saved revision is retained.',503,'snapshot_storage_unavailable');}delete own.snapshot.storageRef;}
 const hidden=new Set([...p.muted,...p.blocked]);
 const chat=w.chat.filter(m=>!m.deleted&&!hidden.has(m.playerUuid)&&(!m.recipientPlayerUuid||m.playerUuid===p.playerUuid||m.recipientPlayerUuid===p.playerUuid)&&(m.channel!=='city'||m.city===p.location?.city)).slice(-80);
 return{version:CAREER_VERSION,protocol:CAREER_PROTOCOL,world:{worldUuid:w.worldUuid,worldCode:w.worldCode,worldName:w.worldName,seed:w.seed,revision:w.revision,createdAt:w.createdAt,hostPlayerUuid:w.hostPlayerUuid,settings:clone(w.settings),start:clone(w.start)},clock:{...clone(w.clock),blockers:activeBlockers(w,now)},players,own,life:Life842.projection(w,p,{...lifeContext(store,now),nativeTitles:p.nativeTitles842||[]}),homeGames:homeViews(w,p,now,lifeContext(store,now)),tournaments:tournamentViews(w,p.playerUuid,now),chat:clone(chat),recoveryRequests:p.playerUuid===w.hostPlayerUuid||p.role==='cohost'?w.recoveryRequests.filter(x=>x.status==='pending'&&x.expiresAt>now).map(x=>({requestId:x.requestId,playerUuid:x.playerUuid,name:x.name,createdAt:x.createdAt,verificationCode:x.verificationCode})):[],events:clone(w.events.slice(-40)),serverTime:now,limits:{connectedSeconds:CONNECTED/1000,hostGraceSeconds:HOST_GRACE/1000,maxPlayers:w.settings.maxPlayers,snapshotBytes:MAX_SNAPSHOT,idempotencyWindow:128},authority:{nativeSimulation:'trusted-player-native-engine',identity:true,clock:true,tournament:true,lifeEconomy:true,legacyNativeEconomy:'trusted-owner-simulation',snapshots:'owner-bound-validated-monotonic'}};
}
function expectedRevision(body,w){if(!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision!==w.revision)fail('The shared world changed on another device. Refresh and retry this command.',409,'stale_revision');}
function commandId(body){if(typeof body.requestId!=='string'||!/^[A-Za-z0-9_-]{8,96}$/.test(body.requestId))fail('This command needs a valid request ID.');return body.requestId;}
async function operationHash(body){const b={...body};delete b.expectedRevision;delete b.requestId;delete b.includeSnapshot;return digest(JSON.stringify(b));}
function remember(p,id,hash,now){p.seen.push([id,hash,now]);p.seen=p.seen.slice(-128);}
function completionInput(body,kind){
 const value=body.completion||{};try{safeTree(value);}catch(e){fail(e.message);}
 if(encoder.encode(JSON.stringify(value)).byteLength>32768)fail('Activity completion data is too large.');
 if(kind==='sleep')return{...clone(value),kind:'sleep',hours:Math.round(Number(body.minutes))/60};
 if(kind==='travel'){
  if(!['journey60','legacy'].includes(value.adapter))fail('The travel adapter is missing. Retry from the native journey controls.');
  if(!value.quote||typeof value.quote!=='object'||Array.isArray(value.quote))fail('A native travel quote is required.');
  return{...clone(value),kind:'travel',adapter:value.adapter,quote:clone(value.quote)};
 }
 return{...clone(value),kind};
}
function scheduleAvailability(w,p,kind,minutes,now,body={}){
 if(w.clock.paused)fail('The shared world clock is paused.',409,'world_paused');
 if(p.availability)fail('Finish the current scheduled activity first.',409,'already_unavailable');
 if(p.completions.some(x=>!x.acknowledgedAt&&['sleep','travel'].includes(x.kind)))fail('Apply and save the completed activity before starting another.',409,'completion_pending');
 if(Object.values(w.life842?.games||{}).some(g=>g.status!=='closed'&&g.members?.[p.playerUuid]?.seated)||activeBlockers(w,now).some(b=>b.playerUuid===p.playerUuid)||Object.values(w.tournaments).some(t=>['running','break','day_break'].includes(t.status)&&t.participants?.[p.playerUuid]?.status==='active'))fail('Finish the active poker state before starting this activity.',409,'active_poker');
 minutes=int(minutes,1,MAX_CLOCK_STEP,'Activity duration');
 if(['sleep','travel'].includes(kind)&&!p.snapshot)fail('Save the new shared Career before starting sleep or travel.',409,'departure_snapshot_required');
 const destination=kind==='travel'?location(body.destination):null;if(kind==='travel'&&(!destination||destination.city===p.location?.city))fail('Choose a different travel destination.');
 if(destination){const city=WORLD_CITIES[destination.city];if(!city||city.start&&Date.parse(city.start+'T00:00:00Z')>w.clock.minute*60000)fail('That destination is not available in the current era.');}
 const completion=completionInput({...body,minutes},kind);
 if(kind==='travel'){
  const q=completion.quote,from=q.from||q.origin||p.location?.city,to=q.to||q.destination||destination.city;
  if(typeof from==='string'&&from!==p.location?.city||typeof to==='string'&&to!==destination.city)fail('Travel quote does not match the current location and destination.',409,'travel_quote_mismatch');
  const fare=Number(q.total??q.cost??q.fare??0);if(!Number.isFinite(fare)||fare<0||fare>p.wallet.balanceCents/100)fail('The native travel quote exceeds available bankroll.',409,'insufficient_funds');
 }
 p.availability={id:'activity_'+randomHex(12),kind,label:text(body.label,kind==='sleep'?'Sleep':kind==='travel'?'Travel':kind==='wait'?'Wait':'Career activity',120),from:w.clock.minute,until:minuteValue(w.clock.minute+minutes),startedAt:now,destination,travelKey:text(body.travelKey||'','',160)||null,completion,departureSnapshotRevision:p.snapshot?.revision||0};
 event(w,'activity',`${p.name} started ${p.availability.label}.`,now,p.playerUuid);return p.availability;
}
async function syncSnapshot(store,w,p,body,now){
 const snap=body.snapshot;if(!snap||typeof snap!=='object'||Array.isArray(snap))fail('Career snapshot is required.');
 if(typeof snap.text!=='string')fail('Native snapshot text is required.');const data=snap.text,bytes=encoder.encode(data).byteLength;if(!bytes||bytes>MAX_SNAPSHOT)fail('Career snapshot is empty or too large.',413,'snapshot_too_large');
 const base=int(snap.baseRevision??0,0,Number.MAX_SAFE_INTEGER-1,'Snapshot base revision'),current=p.snapshot?.revision||0;if(base!==current)fail('A newer Career snapshot exists. Restore it before uploading another branch.',409,'stale_snapshot');
 const revision=base+1;if(snap.revision!==undefined&&Number(snap.revision)!==revision)fail('Snapshot revision must advance exactly once.',409,'stale_snapshot');
 const checksum=String(snap.checksum||'').toLowerCase();if(!/^[a-f0-9]{64}$/.test(checksum)||!timingSafeHex(checksum,await digest(data)))fail('Snapshot SHA-256 checksum failed.',400,'snapshot_checksum');
 let decoded;try{decoded=decodeNativeSnapshot(data);}catch(e){fail(e.message,400,'native_snapshot_invalid');}
 const {career:c,binding:b,minute}=decoded,ch=p.character;
 if(!b||b.schema!==1||b.worldUuid!==w.worldUuid||b.playerUuid!==p.playerUuid||b.characterUuid!==ch.characterUuid||b.worldSeed!==w.seed)fail('This Career does not belong to this world and player. Open the bound shared Career or restore its server snapshot.',409,'snapshot_owner_mismatch');
 if(c.world.seed!==w.seed)fail('Native world seed differs from the shared world.',409,'snapshot_world_mismatch');
 const nativeIdentity=ch.dynastyId||ch.characterUuid;if(c._dynastyId!==nativeIdentity)fail('The native Dynasty identity changed.',409,'snapshot_owner_mismatch');
 if(b.createdMinute!==ch.createdMinute)fail('Character creation identity changed.',409,'snapshot_owner_mismatch');
 if(b.snapshotRevision!==revision)fail('Native snapshot revision must match the next confirmed server revision.',409,'snapshot_binding_revision');
 if(minute>w.clock.minute)fail('A local Career cannot upload a date ahead of the shared world.',409,'snapshot_clock_ahead');
 if(p.snapshot?.nativeMinute!=null&&minute<p.snapshot.nativeMinute)fail('This Career save rewinds confirmed progress.',409,'snapshot_clock_rewind');
 if(!ch.bound){
  if(!ch.legacy&&(c.generation!==1||Number(c.startingYear)!==ch.startingYear||minute<ch.createdMinute||c.world.current!==ch.startingCity||Math.round(c.bankroll*100)!==Math.round(ch.startingBankroll*100)))fail('Create the shared founder from the world start settings before syncing. Existing single-player Dynasties cannot replace this identity.',409,'fresh_character_required');
  ch.bound=true;ch.dynastyId=c._dynastyId;ch.boundAt=now;
 }
 const availabilityIds=Array.isArray(b.appliedAvailabilityIds)?b.appliedAvailabilityIds:[],walletIds=Array.isArray(b.appliedWalletIds)?b.appliedWalletIds:[];
 const ack=body.availabilityAck||snap.availabilityAck;
 const ackIds=Array.isArray(ack)?ack:ack?[ack]:[];
 for(const id of ackIds){const completion=p.completions.find(x=>x.id===id);if(!completion)fail('Activity completion does not belong to this player.',409,'completion_missing');if(!availabilityIds.includes(id))fail('Apply the activity into the native save before acknowledging it.',409,'completion_not_saved');if(minute<completion.until)fail('A completion save must include the activity arrival time.',409,'completion_not_saved');completion.acknowledgedAt=completion.acknowledgedAt||now;if(p.lastCompletedAvailability?.id===id)p.lastCompletedAvailability.acknowledgedAt=completion.acknowledgedAt;}
 for(const receipt of p.wallet.ledger)if(!walletIds.includes(receipt.id))fail('Apply the pending server wallet receipts before saving.',409,'wallet_receipts_pending');
 const expectedCity=p.location?.city;
 if(c.world.current!==expectedCity&&!p.character.legacy)fail('Career city differs from the authoritative player location. Complete shared travel before changing cities.',409,'snapshot_location_mismatch');
 const previousGeneration=p.snapshot?.summary?.generation;if(previousGeneration&&c.generation<previousGeneration)fail('A saved generation cannot be rewound.',409,'snapshot_generation_rewind');
 // Preserve the native engine's existing life/cash economy. This reconciliation
 // is authenticated owner simulation, while shared-table payouts are receipts.
 p.wallet.balanceCents=Math.round(c.bankroll*100);p.wallet.nativeSnapshotRevision=revision;
 p.nativeTitles842=(c.physicalProperties57?.holdings||[]).filter(a=>a.owned&&!a.life842Managed&&(a.building==='home'||a.building==='boarding'||/^pd82[56]_/.test(a.building))).slice(0,264).map(a=>({id:String(a.id),city:a.city,name:String(a.name||'Existing residence').slice(0,80),building:a.building,kind:a.building==='boarding'?'rental':'residence',valueCents:Math.max(1,Math.round(((Number(a.basis)||0)+(Number(a.invested)||0))*100))}));
 const summary={name:c.activeName,year:c.currentYear,month:c.currentMonth,day:c.day,bankroll:c.bankroll,city:c.world.current,generation:c.generation};
 p.snapshot={revision,checksum,bytes,updatedAt:now,slot:int(snap.slot||1,1,20,'Career slot'),summary,nativeMinute:minute,nativeIdentity:c._dynastyId};
 if(store.careerSnapshotPut){const ref=`${w.worldUuid}/${p.playerUuid}/${revision}-${checksum}`;await store.careerSnapshotPut(ref,data);p.snapshot.storageRef=ref;}else p.snapshot.text=data;
 if(p.wallet.ledger.length>32&&store.careerSnapshotPut){const retired=p.wallet.ledger.slice(0,-32),record=JSON.stringify({format:'PokerDynastyWalletArchive',worldUuid:w.worldUuid,playerUuid:p.playerUuid,previous:p.wallet.archiveHead||null,throughRevision:retired.at(-1).revision,receipts:retired}),ref=`${w.worldUuid}/${p.playerUuid}/wallet-${retired.at(-1).revision}-${await digest(record)}`;await store.careerSnapshotPut(ref,record);p.wallet.archiveHead=ref;p.wallet.compactedThrough=retired.at(-1).revision;p.wallet.ledger=p.wallet.ledger.slice(-32);}
 event(w,'save',`${p.name} saved Career revision ${revision}.`,now,p.playerUuid);
}
async function migrateLegacySnapshot(store,w,p,now){
 const ch=p.character;if(!ch.legacy||ch.bound||!p.snapshot)fail('Only an unbound original V84 server snapshot can be migrated.',409,'legacy_migration_unavailable');
 const source=p.snapshot.text||(p.snapshot.storageRef&&await store.careerSnapshotGet?.(p.snapshot.storageRef));if(!source)fail('The original server snapshot is unavailable. Its revision is retained.',503,'snapshot_storage_unavailable');
 let decoded;try{decoded=decodeNativeSnapshot(source);}catch(e){fail('The original server snapshot did not pass native validation: '+e.message,409,'native_snapshot_invalid');}
 const {career:c,raw,minute}=decoded;if(c.multiplayerCareer84)fail('The original snapshot already has a shared identity binding.',409,'legacy_migration_unavailable');
 if(minute>w.clock.minute)fail('The original Career is ahead of this world. Keep its backup and create a separate world at that date; this world cannot rewind other players or silently fast-forward them.',409,'snapshot_clock_ahead');
 if(typeof c._dynastyId!=='string'||!c._dynastyId)fail('The original native Dynasty ID is missing.',409,'native_snapshot_invalid');
 ch.dynastyId=c._dynastyId;ch.createdMinute=minute;ch.startingCity=c.world.current;ch.startingYear=Number(c.startingYear)||c.currentYear;ch.founderName=c.founderName||c.activeName;ch.startingBankroll=c.bankroll;
 p.location={city:c.world.current,mapId:p.location?.mapId||null};c.world.seed=w.seed;
 c.multiplayerCareer84={schema:1,worldUuid:w.worldUuid,playerUuid:p.playerUuid,characterUuid:ch.characterUuid,worldSeed:w.seed,createdMinute:ch.createdMinute,appliedAvailabilityIds:[],appliedWalletIds:p.wallet.ledger.map(r=>r.id),snapshotRevision:p.snapshot.revision+1,migratedFrom:'84.0.0'};
 // Existing server receipts, if any, must be reflected rather than marked paid.
 for(const r of p.wallet.ledger)c.bankroll=Math.round((c.bankroll+r.amount)*100)/100;
 raw.snapshot.payload=JSON.stringify(c);raw.snapshot.checksum=nativeChecksum(raw.snapshot.payload);raw.snapshot.seq=Math.max(1,raw.snapshot.seq+1);raw.snapshot.identity=c._dynastyId;raw.snapshot.savedAt=new Date(now).toISOString();raw.snapshot.writer='pd84-authority-migration';raw.exported=new Date(now).toISOString();
 const text=JSON.stringify(raw),base=p.snapshot.revision;await syncSnapshot(store,w,p,{snapshot:{text,checksum:await digest(text),baseRevision:base,revision:base+1,slot:p.snapshot.slot||1}},now);ch.migratedAt=now;
 event(w,'migration',`${p.name} bound their original server-held Career to its permanent Multiplayer Career identity.`,now,p.playerUuid);
}
async function mutate(store,code,authorization,body,now){
 for(let attempt=0;attempt<18;attempt++){
  const w=ensureWorld(await store.careerLoad(code));if(!w)fail('That Multiplayer Career world was not found.',404,'world_not_found');
  const p=await authenticate(w,authorization,now),old=w.revision,type=String(body.type||'poll');
  if(type==='poll'){
   const heartbeat=now-p.lastSeen>=HEARTBEAT||p.away;const priorSeen=p.lastSeen;p.lastSeen=now;p.away=false;
   const changed=await pulse(w,now,{},store);
   if(changed||heartbeat||w._migrationPending){delete w._migrationPending;w.revision++;w.updatedAt=now;w.expiresAt=now+WORLD_TTL;if(!await store.careerCas(w,old))continue;}else p.lastSeen=priorSeen;
   return{view:await view(w,p,now,body.includeSnapshot===true,store),duplicate:false};
  }
  const id=commandId(body),hash=await operationHash(body),existing=p.seen.find(x=>(Array.isArray(x)?x[0]:typeof x==='string'?x:x.id)===id);
  if(existing){const priorHash=Array.isArray(existing)?existing[1]:existing.hash;if(priorHash&&priorHash!==hash)fail('That request ID was already used for different data.',409,'request_id_conflict');return{view:await view(w,p,now,body.includeSnapshot===true,store),duplicate:true,...clone(existing.response||{})};}
  expectedRevision(body,w);p.lastSeen=now;p.away=false;p.sessionExpiresAt=now+SESSION_TTL;
  const result={};
  // Refresh clock/host state before the command, without automatic acceleration
  // that might complete an older activity while a snapshot is being validated.
  await pulse(w,now,{accelerate:false},store);
  if(type==='presence'){
   const loc=location(body.location);if(loc&&loc.city===p.location?.city)p.location={...p.location,mapId:loc.mapId};
   p.away=body.away===true;
   p.blocker=body.blocker?.active?{active:true,kind:text(body.blocker.kind,'poker',40),label:text(body.blocker.label,'Active poker',100),persistent:body.blocker.persistent===true}:null;
  }else if(type==='activity_span'){
   const minutes=body.minutes!==undefined?int(body.minutes,1,MAX_CLOCK_STEP,'Activity duration'):Math.max(0,minuteValue(body.targetMinute)-w.clock.minute);
   if(minutes)scheduleAvailability(w,p,'activity',minutes,now,body);
  }else if(['wait','sleep','travel'].includes(type))scheduleAvailability(w,p,type,body.minutes,now,body);
  else if(type==='cancel_activity'){
   if(!p.availability)fail('No scheduled activity is active.',409,'no_activity');if(p.availability.life842)fail('This paid or committed life activity completes at its scheduled time.',409,'life_activity_committed');if(p.availability.kind==='travel')fail('A booked journey completes at its arrival time.',409,'travel_in_progress');
   event(w,'activity',`${p.name} cancelled ${p.availability.label}.`,now,p.playerUuid);p.availability=null;
  }else if(type==='ack_activity'){
   const done=p.completions.find(x=>x.id===body.activityId);if(!done)fail('Completion was not found.',404,'completion_missing');if(['sleep','travel'].includes(done.kind))fail('Sleep and travel acknowledgement must be saved atomically with the native Career.',409,'completion_snapshot_required');done.acknowledgedAt=now;
  }else if(type==='sync_snapshot')await syncSnapshot(store,w,p,body,now);
  else if(type==='migrate_legacy_snapshot'){await migrateLegacySnapshot(store,w,p,now);result.migrated=true;}
  else if(type==='host_transfer'||type==='transfer_host'){
   requireHost(w,p);const target=findPlayer(w,String(body.targetPlayerUuid||body.playerUuid||''));if(!target||target.status!=='active'||target.playerUuid===p.playerUuid)fail('Choose another active player.');transferHost(w,target,now);
  }else if(type==='cohost_set'){
   requireHost(w,p);const target=findPlayer(w,String(body.targetPlayerUuid||''));if(!target||target.playerUuid===p.playerUuid||target.status!=='active')fail('Choose an active non-host player.');target.role=body.enabled?'cohost':'player';event(w,'host',`${target.name} ${body.enabled?'was appointed cohost':'is no longer a cohost'}.`,now,p.playerUuid);
  }else if(type==='world_pause'){
   requireModerator(w,p);w.clock.paused=body.paused!==false;w.clock.pauseReason=w.clock.paused?'host-paused':null;w.clock.lastTickAt=now;w.clock.remainderMs=0;event(w,'clock',w.clock.paused?'Host paused the shared world.':'Host resumed the shared world.',now,p.playerUuid);
  }else if(type==='settings_update'){
   requireHost(w,p);const s=body.settings||{};if(['startYear','startMonth','startDay','startHour','startMinute','startingCity'].some(k=>s[k]!=null&&s[k]!==w.settings[k]))fail('A created world timeline is permanent. Create a new world for a different era.',409,'timeline_immutable');
   const next=settingsFrom({...w.settings,...s});if(next.maxPlayers<w.players.filter(x=>x.status!=='removed').length)fail('The new player limit is below the existing player count.');w.settings=next;if(s.worldName)w.worldName=text(s.worldName,w.worldName,64);event(w,'settings','World joining and clock settings updated.',now,p.playerUuid);
  }else if(type==='player_suspend'||type==='kick'){
   requireModerator(w,p);const target=findPlayer(w,String(body.targetPlayerUuid||''));if(!target||target.playerUuid===w.hostPlayerUuid||target.playerUuid===p.playerUuid||p.role==='cohost'&&target.role==='cohost')fail('That player cannot be moderated by this account.',403,'moderation_target');
   target.status=type==='kick'||body.suspended!==false?'suspended':'active';if(target.status==='suspended'){target.sessionHash=null;target.away=true;target.lastSeen=0;target.blocker=null;}event(w,'moderation',`${target.name} ${target.status==='suspended'?'was suspended from':'was restored to'} this world. Saved Career progress is retained.`,now,p.playerUuid);
  }else if(type==='player_mute'||type==='player_block'){
   const target=findPlayer(w,String(body.targetPlayerUuid||''));if(!target||target.playerUuid===p.playerUuid)fail('Choose another world player.');const key=type==='player_mute'?'muted':'blocked',enabled=type==='player_mute'?body.muted!==false:body.blocked!==false;p[key]=p[key].filter(x=>x!==target.playerUuid);if(enabled)p[key].push(target.playerUuid);
  }else if(type==='moderate_chat'){
   requireModerator(w,p);const target=findPlayer(w,String(body.targetPlayerUuid||''));if(!target||target.playerUuid===w.hostPlayerUuid)fail('Choose a non-host player.');target.chatMutedUntil=now+int(body.minutes??30,0,10080,'Mute minutes')*60000;event(w,'moderation',`${target.name}'s world chat access was updated.`,now,p.playerUuid);
  }else if(type==='chat'){
   if(p.chatMutedUntil>now)fail('World chat is muted for this player.',403,'chat_muted');
   if(w.chat.filter(x=>x.playerUuid===p.playerUuid&&now-x.at<10000).length>=6)fail('Wait briefly before sending another chat message.',429,'chat_rate_limited');
   const message=text(body.message,'',500);if(!message)fail('Enter a chat message.');let recipientPlayerUuid=null;
   if(body.recipientPlayerUuid){const target=findPlayer(w,String(body.recipientPlayerUuid));if(!target||target.blocked.includes(p.playerUuid)||p.blocked.includes(target.playerUuid))fail('That direct conversation is unavailable.',403,'chat_blocked');recipientPlayerUuid=target.playerUuid;}
   const channel=body.channel==='city'?'city':'world';w.chat.push({id:'chat_'+randomHex(10),playerUuid:p.playerUuid,name:p.name,message,at:now,worldMinute:w.clock.minute,channel,city:p.location?.city||null,recipientPlayerUuid});w.chat=w.chat.slice(-200);
  }else if(type==='chat_delete'){
   const m=w.chat.find(x=>x.id===body.messageId);if(!m)fail('Chat message was not found.',404,'chat_missing');if(m.playerUuid!==p.playerUuid)requireModerator(w,p);m.deleted=true;m.message='';
  }else if(type==='recovery_approve'||type==='recovery_reject'){
   requireModerator(w,p);const r=w.recoveryRequests.find(x=>x.requestId===body.recoveryRequestId&&x.status==='pending'&&x.expiresAt>now);if(!r)fail('That recovery request expired or is no longer pending.',404,'recovery_missing');if(r.playerUuid===p.playerUuid)fail('A recovery request cannot approve itself.',403,'recovery_self_approval');r.status=type==='recovery_approve'?'approved':'rejected';r.approvedAt=now;r.approvedBy=p.playerUuid;event(w,'recovery',`${p.name} ${r.status} account recovery for ${r.name}.`,now,r.playerUuid);
  }else if(type==='change_credential'){
   p.credential=credential(body.credential);p.authChallenges=[];result.sessionToken=await rotateSession(p,now);event(w,'identity',`${p.name} changed their password and replaced the device session.`,now,p.playerUuid);
  }else if(type==='rotate_recovery'){
   const key=randomHex(32);p.recoveryHash=await digest('pd84-recovery|'+key);result.recoveryKey=key;event(w,'identity',`${p.name} replaced their recovery key.`,now,p.playerUuid);
  }else if(type==='logout'){
   p.sessionHash=null;p.sessionExpiresAt=0;p.lastSeen=0;p.away=true;result.signedOut=true;event(w,'identity',`${p.name} signed out this device.`,now,p.playerUuid);
  }else if(type==='life842'||type==='home842'){
   const sequence=int(body.lifeSequence,1,Number.MAX_SAFE_INTEGER-1,'Life command sequence');
   if(sequence!==(p.life842Sequence||0)+1)fail('This life command was already consumed or came from an older device. Refresh before retrying.',409,'stale_life_sequence');
   if(type==='life842')result.lifeResult=Life842.handle(w,p,body,{...lifeContext(store,now),nativeTitles:p.nativeTitles842||[]});
   else result.homeResult=handleHome(w,p,body,lifeContext(store,now));
   p.life842Sequence=sequence;
  }else if(type.startsWith('tournament_')){
   if(!isTournamentCommand(type))fail('Unknown shared tournament command.');await handleTournament(w,p,body,now,helpers(store));
  }else fail('Unknown Multiplayer Career command.');
  // Session/recovery secrets must never become stored operation responses.
  const safeResponse={...result};delete safeResponse.sessionToken;delete safeResponse.recoveryKey;
  remember(p,id,hash,now,safeResponse);await pulse(w,now,{},store);delete w._migrationPending;w.revision++;w.updatedAt=now;w.expiresAt=now+WORLD_TTL;
  if(await store.careerCas(w,old)){const projection=await view(w,p,now,body.includeSnapshot===true,store);if(type==='tournament_table'||type==='tournament_action')result.roomView=projection.tournaments.find(t=>t.id===body.tournamentId)?.roomView||null;return{view:projection,duplicate:false,...result};}
 }
 fail('The shared world is busy. Refresh and retry.',409,'world_busy');
}
const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store, max-age=0','Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type, Authorization','Access-Control-Max-Age':'600','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
const json=(d,s=200)=>new Response(JSON.stringify(d),{status:s,headers});
async function readBody(request,limit=MAX_SNAPSHOT*2+65536){const n=Number(request.headers.get('content-length'));if(Number.isFinite(n)&&n>limit)fail('Request is too large.',413,'request_too_large');const raw=await request.text();if(encoder.encode(raw).byteLength>limit)fail('Request is too large.',413,'request_too_large');try{const b=JSON.parse(raw);if(!b||typeof b!=='object'||Array.isArray(b))fail('Invalid request.');safeTree(b);return b;}catch(e){if(e instanceof CareerError)throw e;fail('Invalid JSON request.');}}
function newPlayer(w,{playerUuid=uuid(),name,cred,recoveryHash,now}){const p={playerUuid,name,role:'player',credential:cred,recoveryHash,sessionHash:null,sessionGeneration:0,joinedAt:now,lastSeen:now,status:'active',location:{city:w.settings.startingCity,mapId:null},availability:null,blocker:null,snapshot:null,tournaments:{},seen:[],completions:[],authChallenges:[],muted:[],blocked:[]};p.character=newCharacter(w,p);p.wallet={balanceCents:Math.round(p.character.startingBankroll*100),revision:0,ledger:[],source:'native-founder'};return p;}
async function authResult(store,w,p,token,now,extras={}){return{worldCode:w.worldCode,worldUuid:w.worldUuid,playerUuid:p.playerUuid,sessionToken:token,view:await view(w,p,now,false,store),...extras};}
async function persistIdentity(store,w,old,now){delete w._migrationPending;w.revision++;w.updatedAt=now;w.expiresAt=now+WORLD_TTL;return store.careerCas(w,old);}
export async function handleCareer(request,store,clock=Date.now){
 const now=clock();
 try{
  const path=new URL(request.url).pathname.replace(/\/$/,'');if(request.method==='OPTIONS')return new Response(null,{status:204,headers});if(!store?.careerLoad)fail('Multiplayer Career storage is not configured.',503,'storage_unavailable');
  if(request.method==='GET'&&path==='/api/career84/meta'){
   await store.health?.();return json({version:CAREER_VERSION,protocol:CAREER_PROTOCOL,ready:true,capabilities:{entryReplay:store.entryReplay===true,lifeEconomy842:true,leases:true,furniturePlacement:true,fitness:true,homeCashGames:true,worldUuid:true,playerUuid:true,passwordVerifier:'PBKDF2-SHA256',sessionTakeover:true,recoveryKey:true,hostApprovedRecovery:true,passwordRotation:true,sessionRevocation:true,revisionCAS:true,nativeCareerSnapshots:true,boundCareerSnapshots:true,sharedClock:true,hostTimeline:true,persistentCompletions:true,sleepAvailability:true,travelAvailability:true,tournamentBarriers:true,authoritativeTournamentEngine:true,disconnectPreservation:true,exactlyOnceCommands:true,cohostFailover:true,chat:true,moderation:true},tournaments:tournamentMetadata(),catalog:{cities:Object.values(WORLD_CITIES),variantStart:VARIANT_START,variantFormal:VARIANT_FORMAL},limits:{players:MAX_PLAYERS,snapshotBytes:MAX_SNAPSHOT,idempotencyWindow:128,hostGraceSeconds:HOST_GRACE/1000,minYear:1829,maxYear:9998}});
  }
  if(request.method!=='POST')fail('Use Multiplayer Career controls.',405,'method_not_allowed');
  const identityLimits={'/api/career84/create':20,'/api/career84/join':80,'/api/career84/auth/challenge':240,'/api/career84/auth/login':120,'/api/career84/recover-key':80,'/api/career84/recovery/request':60,'/api/career84/recovery/claim':120};
  if(identityLimits[path]&&store.rate){await store.prune?.(now);const ip=String(request.headers.get('x-real-ip')||'unknown').slice(0,120);if(!await store.rate('career84|'+path+'|'+ip,identityLimits[path],now+3600000))fail('Too many identity requests from this network. Try later.',429,'rate_limited');}
  const b=await readBody(request);
  if(path==='/api/career84/create'){
   const cred=credential(b.credential),name=text(b.playerName,'Founder',40),worldName=text(b.worldName,`${name}'s World`,64),recovery=String(b.recoveryKey||'').toLowerCase();if(!/^[a-f0-9]{64}$/.test(recovery))fail('A 256-bit recovery key is required.');
   const settings=settingsFrom(b.worldSettings||{startingCity:b.location?.city},b.clockMinute),worldUuid=uuid(),seed=randomHex(16),playerUuid=uuid(),recoveryHash=await digest('pd84-recovery|'+recovery);
   for(let attempt=0;attempt<8;attempt++){
    const w={schema:1,version:CAREER_VERSION,worldUuid,worldCode:newCode(),worldName,seed,revision:1,createdAt:now,updatedAt:now,expiresAt:now+WORLD_TTL,hostPlayerUuid:playerUuid,settings,start:{...calendar(startMinute(settings)),minute:startMinute(settings),city:settings.startingCity,era:settings.era},clock:{minute:startMinute(settings),paused:false,pauseReason:null,lastTickAt:now,remainderMs:0},players:[],tournaments:{},recoveryRequests:[],events:[],chat:[],hostHistory:[]};
    if(store.load&&await store.load(w.worldCode))continue;
    const p=newPlayer(w,{playerUuid,name,cred,recoveryHash,now});p.role='host';const token=await rotateSession(p,now);w.players.push(p);event(w,'world',`${worldName} created in ${settings.startYear}, ${settings.startingCity}.`,now,playerUuid);
    if(await store.careerCreate(w))return json(await authResult(store,w,p,token,now,{recoveryKey:recovery}),201);
   }fail('Could not allocate a World Code. Try again.',503,'service_busy');
  }
  if(path==='/api/career84/lookup'){
   const w=ensureWorld(await store.careerLoad(codeText(b.worldCode)));if(!w)fail('That world was not found.',404,'world_not_found');return json({worldCode:w.worldCode,worldUuid:w.worldUuid,worldName:w.worldName,settings:w.settings,clock:{minute:w.clock.minute,paused:w.clock.paused},playerCount:w.players.filter(p=>p.status!=='removed').length});
  }
  if(path==='/api/career84/join'){
   const code=codeText(b.worldCode),cred=credential(b.credential),name=text(b.playerName,'Player',40),recovery=String(b.recoveryKey||'').toLowerCase();if(!/^[a-f0-9]{64}$/.test(recovery))fail('A 256-bit recovery key is required.');
   const recoveryHash=await digest('pd84-recovery|'+recovery);
   for(let attempt=0;attempt<16;attempt++){
    const w=ensureWorld(await store.careerLoad(code));if(!w)fail('That world was not found.',404,'world_not_found');if(w.settings.joinPolicy==='closed')fail('The host closed new-player registration. Existing players can still sign in.',403,'world_closed');if(w.players.filter(p=>p.status!=='removed').length>=w.settings.maxPlayers)fail('This shared world is full.',409,'world_full');if(w.players.some(p=>p.status!=='removed'&&p.name.toLocaleLowerCase()===name.toLocaleLowerCase()))fail('That name already has a player identity. Sign in or choose another name.',409,'name_taken');
    const old=w.revision,p=newPlayer(w,{name,cred,recoveryHash,now}),token=await rotateSession(p,now);w.players.push(p);event(w,'join',`${name} joined the shared Career world.`,now,p.playerUuid);if(await persistIdentity(store,w,old,now))return json(await authResult(store,w,p,token,now,{recoveryKey:recovery}),201);
   }fail('The world is busy. Try joining again.',409,'world_busy');
  }
  if(path==='/api/career84/auth/challenge'){
   const code=codeText(b.worldCode);
   for(let attempt=0;attempt<16;attempt++){
    const w=ensureWorld(await store.careerLoad(code));if(!w)fail('That world was not found.',404,'world_not_found');const p=findPlayer(w,String(b.playerUuid||''));if(!p)fail('Player ID was not found.',404,'player_not_found');if(p.status!=='active')fail('This player is suspended.',403,'player_suspended');
    const old=w.revision,nonce=randomHex(32);p.authChallenges=p.authChallenges.filter(x=>x.expiresAt>now&&!x.used).slice(-7);p.authChallenges.push({nonce,createdAt:now,expiresAt:now+CHALLENGE_TTL,attempts:0});
    if(await persistIdentity(store,w,old,now))return json({worldCode:code,worldUuid:w.worldUuid,playerUuid:p.playerUuid,name:p.name,salt:p.credential.salt,iterations:p.credential.iterations,nonce});
   }fail('Could not issue a sign-in challenge. Try again.',409,'world_busy');
  }
  if(path==='/api/career84/auth/login'){
   const code=codeText(b.worldCode),proof=String(b.proof||'').toLowerCase();
   for(let attempt=0;attempt<16;attempt++){
    const w=ensureWorld(await store.careerLoad(code));if(!w)fail('That world was not found.',404,'world_not_found');const p=findPlayer(w,String(b.playerUuid||''));if(!p)fail('Player ID was not found.',404,'player_not_found');if(p.status!=='active')fail('This player is suspended.',403,'player_suspended');
    const old=w.revision,candidates=p.authChallenges.filter(x=>x.expiresAt>now&&!x.used&&x.attempts<8&&(!b.nonce||x.nonce===b.nonce));if(!candidates.length)fail('Sign-in challenge expired. Enter the password again.',409,'challenge_expired');
    let selected=null;for(const ch of candidates){const wanted=await hmacHex(p.credential.verifier,`pd84-login|${code}|${p.playerUuid}|${ch.nonce}`);if(/^[a-f0-9]{64}$/.test(proof)&&timingSafeHex(wanted,proof)){selected=ch;break;}}
    if(!selected){for(const ch of candidates)ch.attempts++;if(!await persistIdentity(store,w,old,now))continue;fail('Incorrect password.',401,'bad_password');}
    selected.used=true;const token=await rotateSession(p,now);event(w,'login',`${p.name} signed in. Previous device sessions were replaced.`,now,p.playerUuid);if(await persistIdentity(store,w,old,now))return json(await authResult(store,w,p,token,now));
   }fail('The world changed while signing in. Try again.',409,'world_busy');
  }
  if(path==='/api/career84/recover-key'){
   const code=codeText(b.worldCode),recovery=String(b.recoveryKey||'').toLowerCase();if(!/^[a-f0-9]{64}$/.test(recovery))fail('Recovery key is invalid.',401,'bad_recovery_key');const hash=await digest('pd84-recovery|'+recovery);
   for(let attempt=0;attempt<16;attempt++){
    const w=ensureWorld(await store.careerLoad(code));if(!w)fail('That world was not found.',404,'world_not_found');const p=findPlayer(w,String(b.playerUuid||''));if(!p)fail('Player ID was not found.',404,'player_not_found');if(p.status!=='active')fail('The player is suspended.',403,'player_suspended');if(!timingSafeHex(hash,p.recoveryHash))fail('Recovery key is incorrect.',401,'bad_recovery_key');
    const old=w.revision,token=await rotateSession(p,now);p.authChallenges=[];event(w,'recovery',`${p.name} recovered access with their recovery key.`,now,p.playerUuid);if(await persistIdentity(store,w,old,now))return json(await authResult(store,w,p,token,now));
   }fail('The world changed during recovery. Try again.',409,'world_busy');
  }
  if(path==='/api/career84/recovery/request'){
   const code=codeText(b.worldCode);
   for(let attempt=0;attempt<16;attempt++){
    const w=ensureWorld(await store.careerLoad(code));if(!w)fail('That world was not found.',404,'world_not_found');const p=findPlayer(w,String(b.playerUuid||''));if(!p)fail('Player ID was not found.',404,'player_not_found');if(p.status!=='active')fail('The player is suspended.',403,'player_suspended');
    const old=w.revision;w.recoveryRequests=w.recoveryRequests.filter(x=>(x.expiresAt||x.createdAt+RECOVERY_TTL)>now).slice(-63);
    if(w.recoveryRequests.filter(x=>x.playerUuid===p.playerUuid&&x.status==='pending').length>=3)fail('This player already has pending recovery requests.',429,'recovery_rate_limited');
    const claimToken=randomHex(32),requestId=randomHex(10),verificationCode=String(Number.parseInt(randomHex(3),16)%1000000).padStart(6,'0');w.recoveryRequests.push({requestId,playerUuid:p.playerUuid,name:p.name,claimHash:await digest('pd84-claim|'+claimToken),status:'pending',createdAt:now,expiresAt:now+RECOVERY_TTL,verificationCode});event(w,'recovery',`${p.name} requested host-approved recovery.`,now,p.playerUuid);
    if(await persistIdentity(store,w,old,now))return json({requestId,claimToken,status:'pending',verificationCode,expiresAt:now+RECOVERY_TTL});
   }fail('The world is busy. Try again.',409,'world_busy');
  }
  if(path==='/api/career84/recovery/claim'){
   const code=codeText(b.worldCode),requestId=String(b.requestId||''),claimToken=String(b.claimToken||'').toLowerCase();if(!/^[a-f0-9]{64}$/.test(claimToken))fail('Recovery claim is invalid.',401,'bad_recovery_claim');const hash=await digest('pd84-claim|'+claimToken);
   for(let attempt=0;attempt<16;attempt++){
    const w=ensureWorld(await store.careerLoad(code));if(!w)fail('That world was not found.',404,'world_not_found');const r=w.recoveryRequests.find(x=>x.requestId===requestId);if(!r)fail('Recovery request was not found.',404,'recovery_missing');if(!timingSafeHex(hash,r.claimHash))fail('Recovery claim is invalid.',401,'bad_recovery_claim');if((r.expiresAt||r.createdAt+RECOVERY_TTL)<=now)fail('Recovery request expired.',410,'recovery_expired');if(r.status==='pending')return json({status:'pending'});if(r.status!=='approved')fail('Recovery request is closed.',410,'recovery_closed');
    const p=findPlayer(w,r.playerUuid);if(!p||p.status!=='active')fail('Player recovery is unavailable.',403,'player_suspended');const old=w.revision,token=await rotateSession(p,now);p.authChallenges=[];r.status='claimed';r.claimedAt=now;event(w,'recovery',`${p.name} completed host-approved recovery.`,now,p.playerUuid);if(await persistIdentity(store,w,old,now))return json(await authResult(store,w,p,token,now,{status:'claimed'}));
   }fail('The world changed during recovery. Try again.',409,'world_busy');
  }
  const m=path.match(/^\/api\/career84\/world\/([A-HJ-NP-Z2-9]{8})$/);if(m)return json(await mutate(store,m[1],request.headers.get('authorization')||'',b,now));
  fail('Multiplayer Career endpoint was not found.',404,'not_found');
 }catch(e){if(e instanceof CareerError||Number.isInteger(e?.status)&&e?.code)return json({error:e.message,code:e.code},e.status);console.error('PD84 Career service failure:',e?.stack||e);return json({error:'The shared world could not be updated. The last confirmed revision is retained.',code:'service_error'},503);}
}
