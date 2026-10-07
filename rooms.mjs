/* Poker Dynasty V83.1: private room authority. Character profiles contain public
   appearance only; Career balances, progress and private saves stay local. */
import { VARIANTS } from './cards.mjs';
import { LEGEND_PROFILES, legendProfile, randomPersonality } from './legend-profiles.mjs';
import { chooseBotAction, hashSeed } from './bot-policy.mjs';
import BlindSchedule from './blind-schedule.mjs';
import { createGame, startHand, legal, act, publicView, tick } from './engine.mjs';

export const VERSION = '83.4.0';
export const DEFAULTS = Object.freeze({variant:'holdem_nl',maxSeats:6,sb:5,bb:10,ante:0,buyin:1000,turnSeconds:30,allowSpectators:true,allowCheats:false,allowRebuys:true,autoFillBots:true,blindMode:'fixed',blindEvery:5,blindPace:'standard'});
const TTL=24*60*60*1000, CONNECTED=45000, HOST_GRACE=90000;
const clone=x=>JSON.parse(JSON.stringify(x));
const variants=()=>Array.isArray(VARIANTS)?VARIANTS:Object.values(VARIANTS);
const spec=id=>variants().find(x=>x.id===id);
const randomHex=n=>Array.from(crypto.getRandomValues(new Uint8Array(n)),b=>b.toString(16).padStart(2,'0')).join('');
const roomCode=()=>Array.from(crypto.getRandomValues(new Uint8Array(8)),b=>'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b%32]).join('');
async function digest(s){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))),b=>b.toString(16).padStart(2,'0')).join('');}
function entryToken(body){
 if(body.entryKey===undefined)return randomHex(32);
 if(typeof body.entryKey!=='string'||!/^[a-f0-9]{64}$/.test(body.entryKey))fail('Invalid room recovery key. Refresh and try again.');
 return body.entryKey;
}
async function entryCode(token,attempt){
 const h=await digest('PokerDynasty:create:'+attempt+':'+token),alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
 return Array.from({length:8},(_,i)=>alphabet[parseInt(h.slice(i*2,i*2+2),16)%32]).join('');
}
function entryResponse(r,m,token,now,recovered=false){
 if(m.kicked)fail('The host removed you from this room.',403,'kicked');
 if(m.left)fail('You left this room. Join again with a new seat.',410,'left_room');
 return {roomCode:r.code,token,playerId:m.id,view:showRoom(r,m,now),recovered};
}
class RoomError extends Error {constructor(message,status=400,code='invalid_request'){super(message);this.status=status;this.code=code;}}
function fail(message,status=400,code='invalid_request'){throw new RoomError(message,status,code);}
function integer(v,min,max,label){if(!Number.isSafeInteger(v)||v<min||v>max)fail(`${label} must be a whole number from ${min} to ${max}.`);return v;}
function nameText(v,fallback){if(v===undefined)return fallback;if(typeof v!=='string')fail('Enter your player name.');return v.normalize('NFKC').replace(/<[^>]*>/g,'').replace(/[<>\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,'').trim().slice(0,32)||fallback;}
const FACE_KEYS=['faceRoundness','faceWidth','faceLength','jawWidth','jawAngle','chin','cheekbones','forehead','eyeShape','eyeSize','eyeSpacing','eyeTilt','browThickness','browArch','browTilt','noseWidth','noseLength','noseBridge','mouthWidth','lips','ears'];
const BODY_KEYS=['height','shoulderWidth','neck','neckLength','torso','waist','hips','bodyMass','muscularity','posture','chestFullness'];
const DNA_ENUMS=Object.freeze({skinTone:7,hairStyle:13,hairColor:8,hairTexture:3,hairLength:4,facialHair:7,clothing:19,accessory:8});
function seedHash(value){let h=2166136261;for(const c of String(value)){h^=c.charCodeAt(0);h=Math.imul(h,16777619);}return h>>>0;}
function characterProfile(input,name,now,seed){
 const raw=input??{};
 if(typeof raw!=='object'||Array.isArray(raw))fail('Invalid character profile.');
 if(new TextEncoder().encode(JSON.stringify(raw)).byteLength>4096)fail('Character profiles must be at most 4 KiB.',413,'profile_too_large');
 if(raw.version!==undefined&&raw.version!==1)fail('Unsupported character profile version.');
 seed=integer(raw.seed===undefined?(seed??crypto.getRandomValues(new Uint32Array(1))[0]):raw.seed,0,4294967295,'Character seed');
 const profile={version:1,name,age:integer(raw.age===undefined?24+seed%34:raw.age,18,100,'Character age'),year:integer(raw.year===undefined?Math.max(1829,Math.min(9999,new Date(now).getUTCFullYear())):raw.year,1829,9999,'Character year'),seed};
 if(raw.dna!==undefined){
   const d=raw.dna;if(!d||typeof d!=='object'||Array.isArray(d))fail('Invalid character DNA.');
   if((d.version!==undefined&&d.version!==2)||(d.bodySchema!==undefined&&d.bodySchema!==2))fail('Unsupported character DNA version.');
   if(d.gender!=='m'&&d.gender!=='f')fail('Character DNA gender must be m or f.');
   if(d.expressionBase!==undefined&&d.expressionBase!=='calm')fail('Character DNA expression must be calm.');
   const dna={version:2,bodySchema:2,seed:integer(d.seed===undefined?seed:d.seed,0,4294967295,'DNA seed'),gender:d.gender,expressionBase:'calm'};
   for(const key of FACE_KEYS.concat(BODY_KEYS)){
     const lo=key==='eyeTilt'?-.35:key==='browTilt'?-.32:0,hi=key==='eyeTilt'?.35:key==='browTilt'?.32:1,value=d[key];
     if(typeof value!=='number'||!Number.isFinite(value)||value<lo||value>hi)fail(`Character DNA ${key} must be a number from ${lo} to ${hi}.`);
     dna[key]=value;
   }
   for(const [key,max] of Object.entries(DNA_ENUMS))dna[key]=integer(d[key],0,max,`Character DNA ${key}`);
   profile.dna=dna;
 }
 return profile;
}
function playerIdentity(body,now){
 const profile=characterProfile(body.profile,'',now);
 const name=nameText(body.name,'Player '+profile.seed.toString(16).toUpperCase().padStart(8,'0'));
 profile.name=name;return {name,profile};
}
function publicProfile(m,now){return clone(m.profile||characterProfile(undefined,m.name,now,seedHash(m.id)));}
function codeText(v){if(typeof v!=='string')fail('Enter the room code.');const c=v.toUpperCase().replace(/[\s-]/g,'');if(!/^[A-HJ-NP-Z2-9]{8}$/.test(c))fail('Room codes have eight letters or numbers.');return c;}
function settings(input={},base=DEFAULTS){
  if(!input||typeof input!=='object'||Array.isArray(input))fail('Invalid room settings.');
  const out={};for(const k of Object.keys(DEFAULTS))out[k]=input[k]===undefined?(base[k]??DEFAULTS[k]):input[k];
  const v=spec(out.variant);if(!v)fail('Choose a supported poker variant.');
  const cap=v.maxSeats||v.seatCap||9;if(v.anteOnly&&out.ante===0)out.ante=out.sb;
  integer(out.maxSeats,2,Math.min(9,cap),'Seats');integer(out.sb,1,1000000,'Small blind');integer(out.bb,out.sb+1,1000000,'Big blind');
  integer(out.ante,0,out.bb,'Ante');integer(out.buyin,out.bb*2,100000000,'Buy-in');integer(out.turnSeconds,10,180,'Turn timer');
  for(const k of ['allowSpectators','allowCheats','allowRebuys','autoFillBots'])if(typeof out[k]!=='boolean')fail('Invalid '+k+' setting.');
  if(!['fixed','hands','minutes'].includes(out.blindMode))fail('Choose fixed blinds, hands, or minutes.',400,'invalid_blind_schedule');
  if(!['standard','turbo'].includes(out.blindPace))fail('Choose a Standard or Turbo blind ladder.',400,'invalid_blind_schedule');
  integer(out.blindEvery,1,out.blindMode==='minutes'?180:1000,'Blind level interval');
  return out;
}
function note(r,text,now){r.chat.push({id:randomHex(6),name:'TABLE',text,system:true,at:now});r.chat=r.chat.slice(-80);}
function liveMembers(r){return r.members.filter(m=>!m.left&&!m.kicked);}
function seated(r){return liveMembers(r).filter(m=>!m.spectator&&!m.waiting).sort((a,b)=>a.seat-b.seat);}
function waiting(r){return liveMembers(r).filter(m=>m.waiting&&!m.spectator);}
function reservedHumans(r){return liveMembers(r).filter(m=>!m.bot&&!m.spectator).length;}
function activeHand(r){return !!r.game&&!['complete','idle'].includes(r.game.phase);}
function hostOnly(r,m){if(r.hostId!==m.id)fail('Only the host can change this room.',403,'host_only');}
function betweenHands(r){if(r.game&&!['complete','idle'].includes(r.game.phase))fail('Wait for this hand to finish.',409,'hand_active');}
function gameSeat(r,m){return r.game&&!m.waiting&&!m.spectator?r.game.seats.findIndex(p=>p.id===m.id):-1;}
function syncStacks(r){if(r.game)for(const p of r.game.seats){const m=r.members.find(x=>x.id===p.id);if(m)m.stack=p.stack;}}
function resetReady(r){for(const m of r.members)m.ready=!!m.bot;}
function transferHost(r,now){
 const old=r.members.find(m=>m.id===r.hostId);
 if(old&&!old.left&&!old.kicked&&now-old.lastSeen<HOST_GRACE)return false;
 const next=liveMembers(r).find(m=>!m.bot&&!m.spectator&&!m.waiting&&now-m.lastSeen<CONNECTED)||liveMembers(r).find(m=>!m.bot&&now-m.lastSeen<CONNECTED);
 if(!next||next.id===r.hostId)return false;r.hostId=next.id;note(r,next.name+' is now the host.',now);return true;
}
function rawTurn(r){return `${r.handEpoch||'lobby'}:${r.game?.turnId??0}`;}
function emptySeat(r){const used=new Set(seated(r).map(m=>m.seat));for(let i=0;i<r.settings.maxSeats;i++)if(!used.has(i))return i;return -1;}
function retireBot(r,bot,now,text){bot.left=true;bot.ready=false;bot.lastSeen=0;note(r,text||bot.name+' (AI) left the table.',now);}
function publicBotFields(m){
 const profile=m?.bot?(m.aiProfile||randomPersonality(seedHash(m.id))):null;
 return {legendId:m?.bot?m.legendId||null:null,style:profile?.style||'HUMAN',aiProfile:profile?clone(profile):null};
}
function botIdentity(r,seat,now,legendId='',seed){
 if(legendId===undefined)legendId='';if(typeof legendId!=='string'||legendId.length>64)fail('Choose a valid Legend.',400,'invalid_legend');
 seed=seed??crypto.getRandomValues(new Uint32Array(1))[0];
 const canonical=legendId?legendProfile(legendId):null;if(legendId&&!canonical)fail('That Legend is not in this release.',400,'invalid_legend');
 if(legendId&&seated(r).some(p=>p.bot&&p.seat!==seat&&p.legendId===legendId))fail('That Legend is already seated.',409,'legend_seated');
 const used=new Set(liveMembers(r).filter(p=>p.seat!==seat||p.spectator||p.waiting).map(m=>m.name.toLocaleLowerCase()));
 const names=['River Fox','Copper Jack','Velvet Ace','Lucky June','Nora Slate','Blue Finch','Milo Quinn','Ruby Lane'];
 let name=canonical?.name||names.find(n=>!used.has(n.toLocaleLowerCase()));
 if(canonical&&used.has(name.toLocaleLowerCase()))name=nameText(name+' AI',name);
 for(let n=1;!name||used.has(name.toLocaleLowerCase());n++)name=canonical?nameText(canonical.name.slice(0,24)+' AI '+n,'Legend AI '+n):'Guest Bot '+n;
 const aiProfile=canonical?clone(canonical):randomPersonality(seed),profile=characterProfile(undefined,name,now,canonical?seedHash(canonical.id):seed);if(canonical)profile.legendId=canonical.id;
 return{name,legendId:canonical?.id||null,aiProfile,profile,aiSeed:seed};
}
function addBot(r,seat,now,legendId=''){
 const bot={id:'bot_'+randomHex(7),tokenHash:null,...botIdentity(r,seat,now,legendId),seat,stack:r.settings.buyin,ready:true,bot:true,spectator:false,waiting:false,lastSeen:now,joinedAt:now,seen:[]};
 r.members.push(bot);note(r,`${bot.name} (AI · ${bot.aiProfile.style}) joined with ${r.settings.buyin.toLocaleString('en-US')} play chips.`,now);return bot;
}
function seatHuman(r,m,now){
 let seat=emptySeat(r);
 if(seat<0){
   const bot=seated(r).find(p=>p.bot);
   if(!bot)fail('Every seat is reserved for a human player.',409,'table_full');
   seat=bot.seat;retireBot(r,bot,now,`${bot.name} (AI) yielded a seat to ${m.name}.`);
 }
 // The human keeps a fresh identity and their own balance. The old hand retains
 // its bot identity, cards and settlement until a new authoritative hand starts.
 m.seat=seat;m.waiting=false;
}
function prepareSeats(r,now){
 for(const m of waiting(r))if(m.ready&&now-m.lastSeen<CONNECTED)seatHuman(r,m,now);
 if(r.settings.autoFillBots!==false){
   if(r.settings.allowRebuys)for(const bot of seated(r).filter(m=>m.bot&&m.stack===0)){
     bot.stack=r.settings.buyin;note(r,`${bot.name} (AI) rebought ${r.settings.buyin.toLocaleString('en-US')} play chips.`,now);
   }
   for(let seat=emptySeat(r);seat>=0;seat=emptySeat(r))addBot(r,seat,now);
 }
}
function begin(r,now){
 prepareSeats(r,now);
 const members=seated(r),available=members.filter(m=>m.stack>0);
 if(available.length<2)fail('At least two players need chips before a hand can start.');
 if(available.some(m=>!m.bot&&!m.ready))fail('Every seated player with chips must ready up.');
 if(available.some(m=>!m.bot&&now-m.lastSeen>CONNECTED))fail('Wait for disconnected players to return, or remove them between hands.');
 const old=r.game,oldButtonId=old?.seats?.[old.button]?.id;
 // Tentative pure schedule advance. The room receives this state only after
 // startHand succeeds; a failed deal or CAS retry cannot spend a blind level.
 const blindPlan=BlindSchedule.advance(r.settings,r.blindProgression,{now,handKey:String((old?.handNo||0)+1)});
 members.forEach((m,i)=>m.seat=i);
 const {sb,bb,ante}=blindPlan.current;
 const g=createGame({...r.settings,sb,bb,ante},members.map(m=>({id:m.id,name:m.name,stack:m.stack,bot:!!m.bot,sittingOut:m.stack<=0})));
 if(old){
   g.handNo=old.handNo||0;g.turnId=old.turnId||0;
   const idx=g.seats.findIndex(p=>p.id===oldButtonId);
   if(idx>=0)g.button=idx;
   else{
     // A departed dealer's numeric seat no longer identifies the same position
     // after compaction. Find its next funded survivor in the previous circle.
     const prior=old.seats||[],from=old.button??-1;
     for(let step=1;step<=prior.length;step++){
       const id=prior[(from+step)%prior.length]?.id;
       const next=g.seats.findIndex(p=>p.id===id&&p.stack>0&&!p.sittingOut);
       // startHand advances once; seed the predecessor of the intended dealer.
       if(next>=0){g.button=next-1;break;}
     }
   }
 }
 for(const p of g.seats){const m=members.find(x=>x.id===p.id);Object.assign(p,{profile:publicProfile(m,now),...publicBotFields(m)});}
 startHand(g,now);
 g.blindSchedule={settings:BlindSchedule.normalize(r.settings),state:clone(blindPlan.state)};
 r.blindProgression=blindPlan.state;r.game=g;r.handEpoch=randomHex(8);g.revealedAll=g.settings.allowCheats;r.status='playing';r.botTurn=null;r.finishedAt=null;armBot(r,now);syncStacks(r);
 if(blindPlan.changed&&blindPlan.current.level>0)note(r,`Blinds Level ${blindPlan.current.number}: ${sb} / ${bb}${ante?' · ante '+ante:''}. Stakes remain fixed for this hand.`,now);
 r.members=r.members.filter(m=>!m.bot||!m.left);
 note(r,`Hand ${g.handNo} · ${spec(r.settings.variant).name}${r.settings.allowCheats?' · OPEN CARDS enabled':''}.`,now);
}
function botChoice(r,i){
 const g=r.game,p=g.seats[i],member=r.members.find(m=>m.id===p.id),profile=member?.aiProfile||randomPersonality(seedHash(p.id)),seed=hashSeed([member?.aiSeed||seedHash(p.id),g.handNo,g.turnId].join('|'));
 try{return chooseBotAction(g,i,profile,seed);}catch(err){
  console.error('PD83.3 bounded AI fallback:',String(err?.message||err));r.aiFallbacks=(r.aiFallbacks||0)+1;
  const choices=legal(g,i),draw=choices.find(a=>a.type==='draw'||a.type==='discard');
  if(draw)return {type:draw.type,indices:draw.type==='discard'?[p.hole.length-1]:[]};
  return {type:choices.some(a=>a.type==='check')?'check':'fold'};
 }
}
function armBot(r,now){
 const g=r.game;if(!g||['idle','complete'].includes(g.phase)||!g.seats[g.actor]?.bot){r.botTurn=null;r.botDue=null;return;}
 const key=rawTurn(r);if(r.botTurn===key)return;
 r.botTurn=key;r.botDue=now+330+seedHash(key+'|'+g.seats[g.actor].id)%191;
}
function nextPollMs(r,now){
 if(!activeHand(r))return 1300;
 if(r.game.seats[r.game.actor]?.bot)return Math.max(100,Math.min(600,(r.botDue||now+350)-now));
 return 450;
}
function progress(r,now){
 let changed=transferHost(r,now);
 if(r.blindProgression&&r.settings.blindMode==='minutes'){
  const observed=BlindSchedule.observe(r.settings,r.blindProgression,now);
  // Persist the clock high-water mark with accepted room requests. This never
  // changes a level, live stakes, an action deadline or any committed wager.
  if(observed.lastObservedAt!==r.blindProgression.lastObservedAt){r.blindProgression=observed;changed=true;}
 }
 const g=r.game;if(!g||['idle','complete'].includes(g.phase))return changed;
 const actor=g.seats[g.actor],member=actor&&r.members.find(m=>m.id===actor.id);
 if(g.deadline&&now>=g.deadline){const before=g.turnId;tick(g,now);changed=changed||g.turnId!==before||g.phase==='complete';r.botTurn=null;}
 else if(actor&&(member?.left||member?.kicked)){
   const actions=legal(g,g.actor),d=actions.find(a=>a.type==='draw'||a.type==='discard');
   act(g,g.actor,d?{type:d.type,indices:d.type==='discard'?[actor.hole.length-1]:[]}:{type:actions.some(a=>a.type==='check')?'check':'fold'},now);changed=true;
 }else if(actor?.bot){
   const key=rawTurn(r);if(r.botTurn!==key){armBot(r,now);changed=true;}
   else if(now>=r.botDue){act(g,g.actor,botChoice(r,g.actor),now);r.botTurn=null;changed=true;}
 }
 if(changed){armBot(r,now);syncStacks(r);if(g.phase==='complete'){r.finishedAt=now;note(r,'Hand finished. Review the result, rebuy if needed, then the host deals the next hand.',now);}}
 return changed;
}
function showRoom(r,m,now){
 const seat=gameSeat(r,m);let table=null;
 if(r.game){
   table=publicView(r.game,m.spectator?-1:seat);
   const rows=table.seats||table.players||[];
   table={...table,name:table.name||spec(r.settings.variant).name,seats:rows.map((p,i)=>({id:p.id,name:p.name,profile:clone(r.game.seats.find(q=>q.id===p.id)?.profile||publicProfile(r.members.find(m=>m.id===p.id)||p,r.createdAt)),...publicBotFields(r.game.seats.find(q=>q.id===p.id)||r.members.find(m=>m.id===p.id)||p),seatIndex:p.seatIndex??p.rawSeat??i,bot:!!p.bot,stack:p.stack??p.chips??0,bet:p.bet??0,folded:!!p.folded,allIn:!!p.allIn,cards:clone(p.cards||[]),up:p.up||[],action:p.action||p.lastAction||'',payout:p.payout||table.payouts?.[i]||0,sittingOut:!!p.sittingOut})),sbSeat:table.positions?.sb??null,bbSeat:table.positions?.bb??null,turnId:rawTurn(r),done:r.game.phase==='complete',youSeat:seat<0||m.spectator?-1:0,canAct:seat>=0&&!m.spectator&&r.game.actor===seat&&!['complete','idle'].includes(r.game.phase)};
   delete table.players;
   const schedule=r.game.blindSchedule;
   table.blindProgression=schedule?BlindSchedule.status(schedule.settings,schedule.state,{now:Math.max(now,r.blindProgression?.lastObservedAt||0),handActive:activeHand(r)}):BlindSchedule.status({...r.game.settings,blindMode:'fixed'},null,{now,handActive:activeHand(r)});
   if(!table.canAct)table.legal=[];
   if(r.game.settings.allowCheats){
     for(const row of table.seats){const p=r.game.seats.find(x=>x.id===row.id);if(p)row.cards=(p.hole||[]).map(c=>({rank:c.rank,suit:c.suit}));}
   }
 }
 return {version:VERSION,code:r.code,revision:r.revision,youId:m.id,youSeat:m.spectator||m.waiting?-1:m.seat,youWaiting:!!m.waiting,hostId:r.hostId,status:r.status,settings:clone({...DEFAULTS,...r.settings}),blindProgression:BlindSchedule.status(r.settings,r.blindProgression,{now,handActive:activeHand(r)}),roster:liveMembers(r).map(x=>({id:x.id,name:x.name,profile:publicProfile(x,r.createdAt),...publicBotFields(x),seat:x.spectator||x.waiting?-1:x.seat,ready:!!x.ready,connected:!!x.bot||now-x.lastSeen<CONNECTED,bot:!!x.bot,host:x.id===r.hostId,spectator:!!x.spectator,waiting:!!x.waiting,stack:x.stack})),table,chat:clone(r.chat),nextPollMs:nextPollMs(r,now),serverTime:now,expiresAt:r.expiresAt,limits:{reconnectGraceSeconds:HOST_GRACE/1000,roomLifetimeHours:24},left:!!m.left,kicked:!!m.kicked};
}
function removePlayer(r,target,now){target.left=true;target.ready=false;target.lastSeen=0;note(r,target.name+' left the room.',now);transferHost(r,now);}
function execute(r,m,body,now){
 const type=body.type;
 if(type==='poll')return false;
 if(type==='leave'){removePlayer(r,m,now);return true;}
 if(type==='chat'){
  if(now-(m.lastChat||0)<650)fail('Please wait a moment before sending another message.',429,'slow_down');
  if(typeof body.text!=='string')fail('Write a message.');const text=body.text.replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,'').trim().slice(0,280);if(!text)fail('Write a message.');m.lastChat=now;r.chat.push({id:randomHex(6),name:m.name,text,at:now,system:false});r.chat=r.chat.slice(-80);return true;
 }
 if(type==='ready'){if(!m.waiting)betweenHands(r);if(m.spectator)fail('Spectators do not ready up.');if(typeof body.ready!=='boolean')fail('Choose ready or not ready.');m.ready=body.ready;return true;}
 if(type==='start'||type==='next'){hostOnly(r,m);betweenHands(r);begin(r,now);return true;}
 if(type==='action'){
   if(m.spectator)fail('Spectators cannot act.',403,'spectator');if(m.waiting)fail('Your seat is queued for a future hand.',409,'waiting_for_seat');if(!r.game)fail('No hand is running.',409,'no_hand');
   if(typeof body.turnId!=='string'||body.turnId!==rawTurn(r))fail('The table has moved on. Your view is refreshing.',409,'stale_turn');
   const seat=gameSeat(r,m);if(seat<0||r.game.actor!==seat)fail('Wait for your turn.',409,'not_your_turn');
   const a=body.action;if(!a||typeof a!=='object'||Array.isArray(a))fail('Choose a legal action.');
   const allowed=legal(r.game,seat).find(x=>x.type===a.type);if(!allowed)fail('That action is not available.',409,'illegal_action');
   const safe={type:a.type};if(a.type==='raise')safe.target=integer(a.target,allowed.minTo,allowed.maxTo,'Raise total');
   if(['draw','discard'].includes(a.type)){if(!Array.isArray(a.indices)||a.indices.some(x=>!Number.isInteger(x))||new Set(a.indices).size!==a.indices.length)fail('Select each card only once.');safe.indices=[...a.indices];}
   const ok=act(r.game,seat,safe,now);if(ok===false)fail('That action could not be accepted. Refresh the table.',409,'illegal_action');syncStacks(r);r.botTurn=null;armBot(r,now);
   if(r.game.phase==='complete')r.finishedAt=now;return true;
 }
 if(type==='rebuy'){
   betweenHands(r);if(m.spectator)fail('Spectators cannot buy chips.');if(!r.settings.allowRebuys)fail('Rebuys are disabled in this room.');
   const max=r.settings.buyin-m.stack;if(max<=0)fail('Your stack is already at or above the room buy-in.');
   const amount=integer(body.amount??max,1,max,'Rebuy');m.stack+=amount;
   // A completed hand remains an immutable accounting record. New funding is
   // included when begin() constructs the next hand from member balances.
   note(r,`${m.name} added ${amount.toLocaleString('en-US')} play chips for the next hand.`,now);return true;
 }
 if(type==='settings'){
   hostOnly(r,m);betweenHands(r);const next=settings(body.settings,r.settings);if(reservedHumans(r)>next.maxSeats)fail('Remove seated or waiting players before reducing the seat limit.');
   const excess=Math.max(0,seated(r).length-next.maxSeats);
   for(const bot of seated(r).filter(m=>m.bot).reverse().slice(0,excess))retireBot(r,bot,now);
   seated(r).forEach((m,i)=>m.seat=i);
   const resetBlinds=BlindSchedule.key(next)!==BlindSchedule.key(r.settings)||next.variant!==r.settings.variant;
   r.settings=next;if(resetBlinds)r.blindProgression=null;r.status='lobby';resetReady(r);
   note(r,'Room rules changed. Everyone must ready up again.'+(resetBlinds?' The blind schedule restarts at Level 1 on the next deal.':'')+(next.allowCheats?' OPEN CARDS is enabled.':''),now);return true;
 }
 if(type==='addBot'){
   hostOnly(r,m);betweenHands(r);if(seated(r).length>=r.settings.maxSeats)fail('The table is full.');
   const used=new Set(seated(r).map(x=>x.seat));let seat=emptySeat(r);if(body.seat!==undefined){integer(body.seat,0,r.settings.maxSeats-1,'AI seat');if(used.has(body.seat))fail('That seat is already occupied.');seat=body.seat;}
   addBot(r,seat,now,body.legendId);return true;
 }
 if(type==='setBot'){
   hostOnly(r,m);betweenHands(r);const seat=integer(body.seat,0,r.settings.maxSeats-1,'AI seat'),target=seated(r).find(x=>x.bot&&x.seat===seat);
   if(!target)fail('Choose an existing AI seat.',409,'not_bot');
   const oldName=target.name,identity=botIdentity(r,seat,now,body.legendId);
   Object.assign(target,identity);r.status='lobby';resetReady(r);
   note(r,`${oldName}'s AI seat is now ${target.name} (${target.aiProfile.style}). Its ${target.stack.toLocaleString('en-US')} play chips are preserved. Ready up for the next hand.`,now);return true;
 }
 if(type==='removeBot'||type==='kick'){
   hostOnly(r,m);betweenHands(r);const target=type==='removeBot'?seated(r).find(x=>x.bot&&x.seat===body.seat):liveMembers(r).find(x=>x.id===body.playerId);
   if(!target||target.id===m.id)fail('Choose another player.');target.kicked=true;target.left=true;target.ready=false;note(r,target.name+' was removed from the room.',now);return true;
 }
 fail('Unknown room command.');
}
const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store, max-age=0','Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type, Authorization','Access-Control-Max-Age':'600','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers});}
async function readBody(request){
 if(Number(request.headers.get('content-length'))>16384)fail('Request is too large.',413);
 const text=await request.text();if(text.length>16384)fail('Request is too large.',413);
 try{const body=JSON.parse(text);if(!body||typeof body!=='object'||Array.isArray(body))fail('Invalid request.');return body;}catch(e){if(e instanceof RoomError)throw e;fail('Invalid JSON request.');}
}
export async function handle(request,store,clock=Date.now){
 const now=clock();
 try{
   const path=new URL(request.url).pathname.replace(/\/$/,'');
   if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
   if(request.method==='GET'&&path==='/api/meta')return json({service:'PokerDynastyRooms',transport:store?.transport||'hosted',version:VERSION,variants:variants().map(v=>({id:v.id,name:v.name,family:v.family,betting:v.betting,maxSeats:v.maxSeats||v.seatCap||9,holeCount:v.holeCount,rule:v.rules||v.rule||v.notes||'',anteOnly:!!v.anteOnly})),defaults:DEFAULTS,protocol:2,entryRecovery:true,features:{legendsAI:true,adaptiveBotTiming:true,progressiveBlinds:true},blindSchedule:{version:'83.4.0',maxBB:BlindSchedule.MAX_BB,maxHandsInterval:1000,maxMinutesInterval:180,catchUp:'one-level-per-hand'},legendProfiles:LEGEND_PROFILES,aiPolicy:{version:'83.3',information:'own-and-public',model:'bounded-personality-policy'}});
   if(request.method==='GET'&&path==='/api/health')return json({ok:true,version:VERSION});
   if(request.method!=='POST')fail('Use the in-game Host or Join controls.',405,'method_not_allowed');
   if(!store)fail('The room service is temporarily unavailable. Please try again.',503,'service_unavailable');
   const body=await readBody(request);
   if(path==='/api/create'||path==='/api/join'){
     const ip=request.headers.get('cf-connecting-ip')||request.headers.get('x-real-ip')||'local';
     const bucket=`${path}:${Math.floor(now/3600000)}:${(await digest(ip)).slice(0,20)}`;
     if(store.rate&&!await store.rate(bucket,path==='/api/create'?30:240,now+3600000))fail('Too many room requests. Please try again later.',429,'slow_down');
   }
   if(path==='/api/create'){
     const {name,profile}=playerIdentity(body,now),rules=settings(body.settings),token=entryToken(body),tokenHash=await digest(token),id=randomHex(12);
     for(let attempt=0;attempt<6;attempt++){
       const code=body.entryKey?await entryCode(token,attempt):roomCode();
       if(store.careerLoad&&await store.careerLoad(code))continue;
       if(body.entryKey){const prior=await store.load(code),owner=prior?.members.find(m=>m.tokenHash===tokenHash);if(prior&&owner){if(prior.expiresAt<=now)fail('That room has expired. Create a new room.',404,'room_not_found');return json(entryResponse(prior,owner,token,now,true));}if(prior)continue;}
       const r={version:1,code,revision:1,hostId:id,status:'lobby',settings:rules,createdAt:now,expiresAt:now+TTL,members:[{id,tokenHash,name,profile,seat:0,stack:rules.buyin,ready:false,bot:false,spectator:false,lastSeen:now,joinedAt:now,seen:[]}],game:null,chat:[],handEpoch:null};
       note(r,'Private room created. Share the code with the people you want to join.',now);
       if(await store.create(r)){try{await store.prune?.(now);}catch{console.warn('PD83: deferred room cleanup.');}return json(entryResponse(r,r.members[0],token,now),201);}
       if(body.entryKey){const prior=await store.load(code),owner=prior?.members.find(m=>m.tokenHash===tokenHash);if(prior&&owner&&prior.expiresAt>now)return json(entryResponse(prior,owner,token,now,true));}
     }fail('Could not create a room. Please try again.',503,'service_busy');
   }
   if(path==='/api/join'){
     const code=codeText(body.roomCode),{name,profile}=playerIdentity(body,now),token=entryToken(body),id=randomHex(12),tokenHash=await digest(token);
     for(let attempt=0;attempt<12;attempt++){
       const r=await store.load(code);if(!r||r.expiresAt<=now)fail('That room was not found or has expired.',404,'room_not_found');
       const returning=body.entryKey&&r.members.find(m=>m.tokenHash===tokenHash);
       if(returning)return json(entryResponse(r,returning,token,now,true));
       if(liveMembers(r).some(m=>m.name.toLocaleLowerCase()===name.toLocaleLowerCase()))fail('That name is already at the table. Choose another name, or reconnect in your original tab.',409,'name_taken');
       const spectator=body.spectator===true;
       if(spectator&&!r.settings.allowSpectators)fail('This room does not allow spectators.',403,'spectators_disabled');
       if(!spectator&&reservedHumans(r)>=r.settings.maxSeats)fail('Every seat is reserved for a human player. Join as a spectator if the host allows it.',409,'table_full');
       const queued=!spectator&&activeHand(r);
       const m={id,tokenHash,name,profile,seat:-1,stack:spectator?0:r.settings.buyin,ready:false,bot:false,spectator,waiting:queued,lastSeen:now,joinedAt:now,seen:[]};
       if(!spectator&&!queued)seatHuman(r,m,now);
       r.members.push(m);if(liveMembers(r).filter(p=>!p.bot).length>24)fail('This room is full.',409,'room_full');
       note(r,name+(spectator?' is watching.':queued?' is waiting to join a future hand.':' joined the table.'),now);r.revision++;
       if(await store.cas(r,r.revision-1))return json(entryResponse(r,m,token,now));
     }fail('The room is busy. Please try joining again.',409,'room_busy');
   }
   const match=path.match(/^\/api\/room\/([A-HJ-NP-Z2-9]{8})$/);if(!match)fail('Room endpoint not found.',404,'not_found');
   const auth=request.headers.get('authorization')||'';if(!/^Bearer [a-f0-9]{64}$/.test(auth))fail('Your seat could not be verified. Rejoin the room.',401,'unauthorized');
   const tokenHash=await digest(auth.slice(7)),code=match[1];
   const requestId=body.requestId;if(body.type!=='poll'&&(typeof requestId!=='string'||!/^[a-zA-Z0-9_-]{8,96}$/.test(requestId)))fail('The command needs a valid request ID.');
   for(let attempt=0;attempt<16;attempt++){
     const r=await store.load(code);if(!r||r.expiresAt<=now)fail('The room has expired. Create a new room.',404,'room_not_found');
     const m=r.members.find(x=>x.tokenHash===tokenHash);if(!m)fail('This connection does not own a seat in the room.',401,'unauthorized');
     if(m.kicked)fail('The host removed you from this room.',403,'kicked');
     if(m.left&&body.type!=='leave')fail('You left this room. Join again to return.',410,'left_room');
     const oldRevision=r.revision;let changed=false;
     if(now-m.lastSeen>=7000||m.lastSeen===0){m.lastSeen=now;changed=true;}
     const duplicate=requestId&&m.seen?.includes(requestId);
     if(!duplicate){
       changed=progress(r,now)||changed;
       if(body.type!=='poll'){
         changed=execute(r,m,body,now)||changed;m.seen=(m.seen||[]).concat(requestId).slice(-128);changed=true;
       }
     }
     if(changed){r.revision++;if(!await store.cas(r,oldRevision))continue;}
     return json({view:showRoom(r,m,now),duplicate:!!duplicate});
   }
   fail('The room is busy. Please try again.',409,'room_busy');
 }catch(e){
   if(e instanceof RoomError)return json({error:e.message,code:e.code},e.status);
   const known=/illegal|turn|raise|fold|check|call|draw|discard|card|seat|variant|bet|chip|hand|ready|limit|stack|deck|amount/i.test(e?.message||'');
   if(known)return json({error:String(e.message).slice(0,240),code:'rule_error'},400);
   console.error('PD83 room service failure:',e?.stack||e);return json({error:'The room could not be updated. Your last confirmed action is preserved. Please reconnect.',code:'service_error'},503);
 }
}

export class D1Store {
 constructor(db){this.db=typeof db?.withSession==='function'?db.withSession('first-primary'):db;}
 async load(code){const row=await this.db.prepare('SELECT state FROM poker_rooms WHERE code = ?').bind(code).first();return row?JSON.parse(row.state):null;}
 async create(room){const r=await this.db.prepare('INSERT OR IGNORE INTO poker_rooms (code, revision, state, expires_at) VALUES (?, ?, ?, ?)').bind(room.code,room.revision,JSON.stringify(room),room.expiresAt).run();return r.meta.changes===1;}
 async cas(room,revision){const r=await this.db.prepare('UPDATE poker_rooms SET state = ?, revision = ?, expires_at = ? WHERE code = ? AND revision = ?').bind(JSON.stringify(room),room.revision,room.expiresAt,room.code,revision).run();return r.meta.changes===1;}
 async rate(key,limit,expiresAt){const r=await this.db.prepare('INSERT INTO poker_request_limits (key, count, expires_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = count + 1 RETURNING count').bind(key,expiresAt).first();return r.count<=limit;}
 async prune(now){await this.db.batch([this.db.prepare('DELETE FROM poker_rooms WHERE code IN (SELECT code FROM poker_rooms WHERE expires_at < ? LIMIT 100)').bind(now),this.db.prepare('DELETE FROM poker_request_limits WHERE key IN (SELECT key FROM poker_request_limits WHERE expires_at < ? LIMIT 100)').bind(now)]);}
}
