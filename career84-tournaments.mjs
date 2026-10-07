/** Poker Dynasty V84.1 authoritative multi-table Career tournaments.
 *
 * Every live table uses the existing V83.4 rules engine and public-information
 * personality AI. Humans never submit stacks, seats, decks, ranks or payouts.
 * Tables finish one hand at a time behind an automatic all-table barrier. Only
 * settled checkpoints may eliminate, balance, change stakes or advance a day.
 * Full engine snapshots live only in the persisted world; all projections pass
 * through engine.publicView for the authenticated player.
 */
import { VARIANTS, getVariant } from './cards.mjs';
import { createGame, startHand, act, tick, legal, publicView, assertGame } from './engine.mjs';
import { chooseBotAction, hashSeed, seeded } from './bot-policy.mjs';
import { legendProfile, randomPersonality, LEGEND_PROFILES } from './legend-profiles.mjs';
import BlindSchedule from './blind-schedule.mjs';
import { tournamentEraGate, legendEraGate, WORLD_CITIES, LEGEND_ERAS } from './career84-world-policy.mjs';

export const TOURNAMENT_VERSION='84.1.0';
export const TOURNAMENT_LIMITS=Object.freeze({field:90,tables:45,events:40,turnSeconds:180,heartbeatGraceSeconds:10,disconnectGraceSeconds:30,tableReviewMs:2200,breakReviewMs:15000});
const ACTIVE=new Set(['running','break','day_break']);
const COMMANDS=new Set(['tournament_create','tournament_join','tournament_unregister','tournament_start','tournament_cancel','tournament_action','tournament_table','tournament_chat','tournament_progress']);
const copy=x=>JSON.parse(JSON.stringify(x));
const values=t=>Object.values(t.participants||{});
const tables=t=>Object.values(t.tables||{}).filter(x=>x.active!==false);
const player=(w,id)=>w.players.find(p=>p.playerUuid===id);
const sum=xs=>xs.reduce((n,x)=>n+x,0);
const short=(v,fallback='',max=80)=>typeof v==='string'?v.normalize('NFKC').replace(/[<>\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,'').trim().slice(0,max)||fallback:fallback;
const randomHex=n=>Array.from(crypto.getRandomValues(new Uint8Array(n)),x=>x.toString(16).padStart(2,'0')).join('');
const randomSeed=()=>crypto.getRandomValues(new Uint32Array(1))[0];
const error=(h,m,s=400,c='tournament_rule')=>{if(h?.fail)return h.fail(m,s,c);const e=new Error(m);e.status=s;e.code=c;throw e;};
const integer=(h,v,lo,hi,label)=>{if(!Number.isSafeInteger(v)||v<lo||v>hi)error(h,`${label} must be a whole number from ${lo} to ${hi}.`);return v;};
const cash=(h,v)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<0||v>1000000||Math.abs(v*100-Math.round(v*100))>.00001)error(h,'Tournament buy-in must be a nonnegative amount with at most two decimals.');return Math.round(v*100)/100;};
const hostOnly=(w,p,h)=>{if(w.hostPlayerUuid!==p.playerUuid)error(h,'Only the current world host may manage tournament registration.',403,'host_only');};
const ownerTable=(t,id)=>tables(t).find(tb=>tb.playerIds.includes(id))||null;
const epochTurn=tb=>`${tb.epoch||'undealt'}:${tb.game?.turnId||0}`;
const connected=(p,now,h)=>!!p&&p.status!=='removed'&&(h?.connected?h.connected(p,now):now-p.lastSeen<60000);
function humanAvailable(w,t,tp,now,h){const p=player(w,tp.id);return connected(p,now,h)&&now-p.lastSeen<TOURNAMENT_LIMITS.heartbeatGraceSeconds*1000&&!p.availability&&(t.settings.source==='online'||p.location?.city===t.city);}
function note(w,t,message,now,h){
 const item={id:randomHex(6),name:'TOURNAMENT',text:short(message,'Tournament event',280),at:now,worldMinute:w.clock.minute,system:true};
 t.chat=(t.chat||[]).concat(item).slice(-80);
 if(h?.event)h.event(w,'tournament',message,now,null);
}
function normalizeSettings(input={},h){
 if(!input||typeof input!=='object'||Array.isArray(input))error(h,'Tournament settings are required.');
 const variant=input.variant||'holdem_nl';let spec;try{spec=getVariant(variant);}catch{error(h,'Choose a supported tournament game.');}
 const s={variant,maxSeats:input.maxSeats??Math.min(6,spec.seatCap),fieldSize:input.fieldSize??18,
  startingStack:input.startingStack??3000,buyIn:input.buyIn??0,sb:input.sb??10,bb:input.bb??20,
  ante:input.ante??((spec.family==='stud'||spec.anteOnly)?input.sb??10:0),turnSeconds:input.turnSeconds??30,
  blindMode:input.blindMode??'hands',blindEvery:input.blindEvery??5,blindPace:input.blindPace??'standard',
  levelsPerDay:input.levelsPerDay??8,breakEveryLevels:input.breakEveryLevels??2,breakMinutes:input.breakMinutes??15,
  dayStartHour:input.dayStartHour??12,source:input.source==='online'?'online':'live',allowSpectators:input.allowSpectators!==false};
 integer(h,s.maxSeats,2,spec.seatCap,'Seats per table');integer(h,s.fieldSize,2,TOURNAMENT_LIMITS.field,'Tournament field');
 integer(h,s.sb,1,1000000,'Opening small blind');integer(h,s.bb,s.sb+1,1000000,'Opening big blind');
 integer(h,s.ante,0,s.bb,'Opening ante');integer(h,s.startingStack,s.bb*2,100000000,'Starting tournament stack');
 integer(h,s.turnSeconds,10,180,'Turn timer');s.buyIn=cash(h,s.buyIn);
 if(!['hands','minutes'].includes(s.blindMode))error(h,'Tournament levels must advance by hands or minutes.');
 integer(h,s.blindEvery,1,s.blindMode==='minutes'?180:1000,'Level length');
 if(!['standard','turbo'].includes(s.blindPace))error(h,'Choose the standard or turbo blind ladder.');
 integer(h,s.levelsPerDay,1,24,'Levels per tournament day');integer(h,s.breakEveryLevels,0,24,'Levels between breaks');
 integer(h,s.breakMinutes,1,120,'Break duration');integer(h,s.dayStartHour,0,23,'Next-day starting hour');
 return s;
}
function validateEra(w,settings,city,minute,h){
 const g=tournamentEraGate(settings.variant,city,minute);
 if(!g.ok)error(h,g.reason,409,'tournament_era');
 if(settings.source==='online'&&new Date(minute*60000).getUTCFullYear()<Math.max(2001,g.year))error(h,'Online tournaments are not available in this timeline yet.',409,'tournament_era');
 return g;
}
function ownAppearance(p,year){
 const input=p.profile||p.character?.profile||p.snapshot?.summary?.profile;
 // Only public appearance is retained here. Never serialize an entire Career.
 const out={version:1,name:p.name,age:Math.max(18,Math.min(100,Number(p.character?.age||input?.age)||24)),year,seed:hashSeed(p.playerUuid)};
 if(input&&typeof input==='object'){
  if(input.dna&&JSON.stringify(input.dna).length<4096)out.dna=copy(input.dna);
  if(Number.isSafeInteger(input.seed)&&input.seed>=0&&input.seed<=4294967295)out.seed=input.seed;
 }
 return out;
}
function makeHuman(p,t,now,registrationNo){
 const id=p.playerUuid;
 return{id,playerUuid:id,name:p.name,kind:'human',status:'registered',stack:t.settings.startingStack,registeredAt:now,
  entryRef:`${t.id}:entry:${id}:${registrationNo}`,profile:ownAppearance(p,t.year),tableId:null,seat:null,disconnectedAt:null,disconnectState:'CONNECTED',graceUsed:false,finish:null};
}
function makeBot(t,index,choice){
 // This guard also covers an older registration saved before Career-era
 // validation, or an announced start delayed across the Legend's final year.
 const canonical=choice?.legendId&&legendEraGate(choice.legendId,t.year).ok?legendProfile(choice.legendId):null;
 const seed=randomSeed(),id=`${t.id}:ai:${index}`,aiProfile=canonical?copy(canonical):randomPersonality(seed);
 const first=['Mara','Rafael','Sofia','Nico','Mina','Adrian','Lena','Tomas','Jonah','Lucia','Ravi','Yuna','Hugo','Clara','Oscar','Nora'];
 const last=['Santos','Cross','Tan','Reyes','Quinn','Mercer','Park','Chen','Rivera','Silva','Ortiz','Blake','Mori','Lane','Vale','Lim'];
 let name=canonical?.name||`${first[seed%first.length]} ${last[(seed>>>7)%last.length]}`;
 if(values(t).some(p=>p.name===name))name+=` ${index+1}`;
 return{id,playerUuid:null,name,kind:canonical?'legend':'ai',bot:true,status:'active',stack:t.settings.startingStack,
  legendId:canonical?.id||null,aiSeed:seed,aiProfile,profile:{version:1,name,age:24+seed%38,year:t.year,seed:canonical?hashSeed(canonical.id):seed,...(canonical?{legendId:canonical.id}:{})},
  registeredAt:t.createdAt,tableId:null,seat:null,finish:null};
}
function currentBlind(t){return BlindSchedule.levelSpec({sb:t.settings.sb,bb:t.settings.bb,ante:t.settings.ante,blindPace:t.settings.blindPace},Math.max(0,t.blindLevel-1));}
function activeEntries(t){return values(t).filter(p=>p.status==='active'&&p.stack>0);}
function syncTable(t,tb){for(const seat of tb.game?.seats||[]){const p=t.participants[seat.id];if(p)p.stack=seat.stack;}}
function setPlayingBlocker(p,t){if(!p)return;p.blocker={active:true,kind:'shared_tournament',label:t.name,persistent:true,tournamentId:t.id};}
function clearPlayingBlocker(p,t){if(p?.blocker?.tournamentId===t.id)p.blocker=null;}
function clearBreakAvailability(p,t){if(p?.availability?.tournamentId===t.id)p.availability=null;}
function checkpoint(t,kind,now,minute){
 const row={id:`${t.id}:checkpoint:${++t.checkpointNo}`,kind,at:now,worldMinute:minute,round:t.roundNo,day:t.dayNo,level:t.blindLevel,
  totalChips:t.totalChips,players:values(t).map(p=>({id:p.id,stack:p.stack,status:p.status,tableId:p.tableId,seat:p.seat,place:p.finish?.place??null})),
  tables:tables(t).map(tb=>({id:tb.id,handNo:tb.game?.handNo||0,revision:tb.game?.revision||0,settled:!tb.game||tb.game.phase==='complete'}))};
 row.survivors=values(t).filter(p=>p.status==='active').length;row.tableCount=row.tables.length;
 t.checkpoints=(t.checkpoints||[]).concat(row).slice(-32);
 // Keep two complete resumable seat ledgers and compact older milestones.
 // Current table engines already contain the exact live cards and action queue.
 for(const prior of t.checkpoints.slice(0,-2)){delete prior.players;delete prior.tables;}
 t.lastCheckpoint=copy(row);return row;
}
async function archiveComplete(w,t,now,h){
 if(t.archiveRef||t.archived)return;
 if(h?.archiveTournament)t.archiveRef=await h.archiveTournament(w,t,now);
 const keep=new Set([...Object.values(t.tables||{}).flatMap(tb=>tb.game?.seats?.map(p=>p.id)||[]),...values(t).filter(p=>p.kind==='human').map(p=>p.id),t.winnerId]);
 for(const [id,p]of Object.entries(t.participants))if(!keep.has(id))delete t.participants[id];
 for(const tb of Object.values(t.tables||{}))if(tb.game){
  // Keep the latest final hand valid under the original engine's card-custody
  // assertions. Older completed tables move wholly into the immutable archive.
  tb.game.events=tb.game.events.slice(-16);tb.game.archived=true;
 }
 t.checkpoints=t.checkpoints.slice(-4);for(const c of t.checkpoints){delete c.players;delete c.tables;}
 if(t.lastCheckpoint){delete t.lastCheckpoint.players;delete t.lastCheckpoint.tables;}
 t.archived=true;
 compactHistory(w);
}
function compactHistory(w){
 const complete=Object.values(w.tournaments||{}).filter(t=>t.schema===2&&['complete','cancelled'].includes(t.status)&&t.archiveRef).sort((a,b)=>(b.completedAt||b.cancelledAt)-(a.completedAt||a.cancelledAt));
 for(const t of complete.slice(12))if(!t.historyCompacted){
  t.tables={};t.checkpoints=[];t.chat=t.chat.slice(-3);t.botChoices=[];
  t.results=t.results.filter(r=>r.kind==='human'||r.place===1);
  t.participants=Object.fromEntries(values(t).filter(p=>p.kind==='human'||p.id===t.winnerId).map(p=>[p.id,p]));
  t.historyCompacted=true;
 }
 const over=Math.max(0,Object.keys(w.tournaments||{}).length-TOURNAMENT_LIMITS.events);
 for(const t of complete.slice().reverse().slice(0,over)){
  w.tournamentArchiveIndex=Array.isArray(w.tournamentArchiveIndex)?w.tournamentArchiveIndex:[];
  if(!w.tournamentArchiveIndex.some(x=>x.id===t.id))w.tournamentArchiveIndex.push({id:t.id,name:t.name,status:t.status,year:t.year,city:t.city,field:t.fieldSize,prizePool:t.prizePoolCents/100,winner:t.participants[t.winnerId]?.name||t.results.find(r=>r.place===1)?.playerName,completedAt:t.completedAt||t.cancelledAt,archiveRef:t.archiveRef});
  w.tournamentArchiveIndex=w.tournamentArchiveIndex.slice(-128);delete w.tournaments[t.id];
 }
}
function seededShuffle(a,seed){const r=seeded(seed);for(let i=a.length-1;i>0;i--){const j=Math.floor(r()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}
function reseat(t,now,initial=false){
 const entries=activeEntries(t),cap=t.settings.maxSeats,wanted=Math.ceil(entries.length/cap),old=tables(t);
 if(entries.length<2)return;
 const targetSizes=Array.from({length:wanted},(_,i)=>Math.floor(entries.length/wanted)+(i<entries.length%wanted?1:0));
 if(initial||!old.length){
  const shuffled=seededShuffle(entries.map(p=>p.id),hashSeed(t.seed+'|initial-seating'));t.tables={};
  for(let i=0;i<wanted;i++){const id=`table_${++t.tableSeq}`,ids=shuffled.splice(0,targetSizes[i]);t.tables[id]={id,index:i+1,active:true,playerIds:ids,game:null,epoch:null,handNo:0,turnCounter:0,buttonId:null,finishedAt:null};}
 }else{
  // Keep surviving seats and table IDs whenever possible; move only enough
  // players to close short tables or restore a one-player size difference.
  for(const tb of old)tb.playerIds=tb.playerIds.filter(id=>t.participants[id]?.status==='active');
  old.sort((a,b)=>b.playerIds.length-a.playerIds.length||a.index-b.index);
  const keep=old.slice(0,wanted),closing=old.slice(wanted),pool=[];
  for(const tb of closing){pool.push(...tb.playerIds);delete t.tables[tb.id];}
  for(let i=0;i<keep.length;i++){
   const tb=keep[i];
   while(tb.playerIds.length>targetSizes[i]){
    // Prefer the player who would next owe the BB. Movement is at a settled
    // checkpoint; the engine keeps every existing blind and committed chip.
    const oldIds=tb.game?.seats?.map(p=>p.id)||tb.playerIds;const bb=tb.game?.bbSeat??-1;
    let at=-1;for(let k=1;k<=oldIds.length;k++){const id=oldIds[(bb+k+oldIds.length)%oldIds.length];at=tb.playerIds.indexOf(id);if(at>=0)break;}
    if(at<0)at=tb.playerIds.length-1;pool.push(tb.playerIds.splice(at,1)[0]);
   }
  }
  for(let i=0;i<keep.length;i++)while(keep[i].playerIds.length<targetSizes[i])keep[i].playerIds.push(pool.shift());
  if(pool.length)throw Error('Tournament seating left an unassigned funded player.');
 }
 for(const tb of tables(t))tb.playerIds.forEach((id,seat)=>{const p=t.participants[id];if(!p)throw Error('Tournament seat has no entrant.');p.tableId=tb.id;p.seat=seat;});
 if(tables(t).length===1){t.stage=entries.length===2?'heads_up':'final_table';if(!t.finalTableAt)t.finalTableAt=now;}
 else t.stage=entries.length<=t.paidPlaces+1?'bubble':entries.length<=27?'final_27':'field';
}
function newRound(w,t,now,h){
 const blind=currentBlind(t);t.status='running';t.blockClock=true;t.barrierTarget=null;t.waitingForTables=false;t.readyAt=null;t.resumeMinute=null;
 for(const tb of tables(t)){
  const old=tb.game,ids=tb.playerIds.filter(id=>t.participants[id]?.status==='active');tb.playerIds=ids;
  if(ids.length<2)throw Error('A live tournament table has fewer than two players.');
  const g=createGame({...t.settings,sb:blind.sb,bb:blind.bb,ante:blind.ante,buyin:t.settings.startingStack,allowRebuys:false,allowCheats:false},ids.map(id=>{const p=t.participants[id];return{id,name:p.name,stack:p.stack,bot:p.kind!=='human',sittingOut:false};}));
  g.handNo=tb.handNo||old?.handNo||0;g.turnId=tb.turnCounter||old?.turnId||0;
  const oldButton=old?.seats?.[old.button]?.id||tb.buttonId;
  if(old){
   const at=g.seats.findIndex(p=>p.id===oldButton);
   if(at>=0)g.button=at;
   else{for(let k=1;k<=old.seats.length;k++){const id=old.seats[(old.button+k+old.seats.length)%old.seats.length]?.id,at=g.seats.findIndex(p=>p.id===id);if(at>=0){g.button=at-1;break;}}}
  }
  tb.game=g;tb.epoch=randomHex(10);tb.finishedAt=null;tb.botTurn=null;tb.botDue=null;tb.startStacks=Object.fromEntries(ids.map(id=>[id,t.participants[id].stack]));
  startHand(g,now);tb.handNo=g.handNo;tb.turnCounter=g.turnId;tb.buttonId=g.seats[g.button]?.id||null;syncTable(t,tb);
 }
 for(const p of w.players){if(t.participants[p.playerUuid]?.status==='active'){clearBreakAvailability(p,t);setPlayingBlocker(p,t);}}
 t.lastTickAt=now;assertTournament(t);return true;
}
function payoutLadder(field,poolCents){
 const paid=field<=5?1:field<=9?2:Math.max(3,Math.ceil(field*.15));
 const weights=Array.from({length:paid},(_,i)=>Math.pow(paid-i,1.45)),total=sum(weights),out=weights.map(v=>Math.floor(poolCents*v/total));
 for(let left=poolCents-sum(out),i=0;left>0;left--,i++)out[i%out.length]++;
 return out;
}
async function result(w,t,p,place,payoutCents,now,h,tied=1){
 if(p.finish)return false;
 const points=place===1?200+Math.round(Math.sqrt(t.fieldSize)*20):payoutCents>0?Math.max(12,Math.round(90*Math.sqrt(t.fieldSize/place))):Math.max(1,Math.round(8*(1-place/t.fieldSize)));
 const r={resultId:`${t.id}:result:${p.id}`,tournamentId:t.id,event:t.name,name:t.name,playerUuid:p.playerUuid,playerName:p.name,kind:p.kind,
  place,tied,payout:payoutCents/100,payoutCents,points,field:t.fieldSize,year:t.year,completedAt:now,worldMinute:w.clock.minute,source:'shared-career-tournament'};
 p.finish=r;p.status=place===1?'winner':'eliminated';p.tableId=null;p.seat=null;t.results.push(copy(r));
 if(p.kind==='human'){
  const human=player(w,p.id);if(human){
   if(payoutCents){if(!h?.credit)error(h,'Tournament wallet authority is unavailable.',503,'wallet_unavailable');await h.credit(w,human,payoutCents/100,`${t.name} · place ${place}`,r.resultId,now);}
   human.tournamentResults=Array.isArray(human.tournamentResults)?human.tournamentResults:[];
   if(!human.tournamentResults.some(x=>x.resultId===r.resultId)){
    human.tournamentResults.push(copy(r));human.tournamentResults=human.tournamentResults.slice(-100);
    human.tournamentStats||={entries:0,wins:0,cashes:0,points:0,earnings:0};const s=human.tournamentStats;
    s.wins=(s.wins||0)+(place===1?1:0);s.cashes=(s.cashes||0)+(payoutCents>0?1:0);s.points=(s.points||0)+points;s.earnings=Math.round(((s.earnings||0)+payoutCents/100)*100)/100;
   }
   clearPlayingBlocker(human,t);clearBreakAvailability(human,t);
   if(human.tournaments?.[t.id])human.tournaments[t.id].resultId=r.resultId;
  }
 }
 return true;
}
async function finishRound(w,t,now,h){
 if(t.roundProcessed===t.roundNo)return false;
 const tbs=tables(t);if(tbs.some(tb=>tb.game?.phase!=='complete'))return false;
 for(const tb of tbs)syncTable(t,tb);
 assertTournament(t);
 const startingAlive=values(t).filter(p=>p.status==='active');
 const out=startingAlive.filter(p=>p.stack===0).map(p=>({p,start:tbs.find(tb=>Object.hasOwn(tb.startStacks||{},p.id))?.startStacks[p.id]||0}));
 out.sort((a,b)=>a.start-b.start||a.p.id.localeCompare(b.p.id));
 let remaining=startingAlive.length;
 for(let i=0;i<out.length;){let end=i+1;while(end<out.length&&out[end].start===out[i].start)end++;const group=out.slice(i,end),places=Array.from({length:group.length},(_,j)=>remaining-j),pot=sum(places.map(place=>t.payoutCents[place-1]||0)),base=Math.floor(pot/group.length),extra=pot%group.length,place=remaining-group.length+1;
  for(let k=0;k<group.length;k++)await result(w,t,group[k].p,place,base+(k<extra?1:0),now,h,group.length);
  remaining-=group.length;i=end;
 }
 t.roundProcessed=t.roundNo;t.handsInLevel++;t.handsCompleted+=tbs.length;
 const alive=activeEntries(t);
 checkpoint(t,'all_tables_settled',now,w.clock.minute);
 if(alive.length===1){
  await result(w,t,alive[0],1,t.payoutCents[0]||0,now,h);t.winnerId=alive[0].id;t.status='complete';t.stage='complete';t.blockClock=false;t.completedAt=now;t.waitingForTables=false;t.readyAt=null;
  for(const tb of tbs)tb.active=false;
  checkpoint(t,'tournament_complete',now,w.clock.minute);
  if(sum(t.results.map(r=>r.payoutCents))!==t.prizePoolCents)throw Error('Tournament payouts did not conserve the prize pool.');
  note(w,t,`${alive[0].name} wins ${t.name}. Prize ${((t.payoutCents[0]||0)/100).toLocaleString('en-US')} credited once.`,now,h);
  await archiveComplete(w,t,now,h);return true;
 }
 if(!alive.length)throw Error('A tournament cannot eliminate every entrant.');
 const oldCount=tbs.length;reseat(t,now);
 if(tables(t).length<oldCount)note(w,t,`${alive.length} players remain. Tables were balanced at a settled checkpoint${tables(t).length===1?' for the final table':''}.`,now,h);
 const due=t.settings.blindMode==='hands'?t.handsInLevel>=t.settings.blindEvery:now-t.levelStartedAt>=t.settings.blindEvery*60000;
 if(due){
  t.completedLevels++;t.blindLevel=Math.min(t.blindLevel+1,BlindSchedule.ladder(t.settings).length);t.handsInLevel=0;t.levelStartedAt=now;
  const dayDue=t.completedLevels%t.settings.levelsPerDay===0;
  const breakDue=!dayDue&&t.settings.breakEveryLevels>0&&t.completedLevels%t.settings.breakEveryLevels===0;
  if(dayDue||breakDue){
   t.status=dayDue?'day_break':'break';t.blockClock=false;t.breakNo++;t.pendingDayNo=dayDue?t.dayNo+1:null;
   t.resumeMinute=dayDue?(Math.floor(w.clock.minute/1440)+1)*1440+t.settings.dayStartHour*60:w.clock.minute+t.settings.breakMinutes;
   t.readyAt=now+TOURNAMENT_LIMITS.breakReviewMs;t.waitingForTables=false;
   t.barrierTarget={type:dayDue?'day':'break',value:dayDue?t.pendingDayNo:t.breakNo,releaseMinute:t.resumeMinute};
   for(const p of w.players){if(t.participants[p.playerUuid]?.status==='active'){
    clearPlayingBlocker(p,t);
    if(!p.availability)p.availability={id:`${t.id}:break:${t.breakNo}:${p.playerUuid}`,kind:'tournament_break',label:dayDue?`${t.name} · waiting for Day ${t.pendingDayNo}`:`${t.name} · scheduled break`,tournamentId:t.id,from:w.clock.minute,until:t.resumeMinute,startedAt:now};
   }}
   checkpoint(t,dayDue?'end_of_day':'scheduled_break',now,w.clock.minute);
   note(w,t,dayDue?`Day ${t.dayNo} is complete at every table. ${alive.length} surviving stacks are saved for Day ${t.pendingDayNo}.`:`Every table reached the break. Level ${t.blindLevel} begins after the shared break.`,now,h);return true;
  }
  note(w,t,`Every table finished Level ${t.blindLevel-1}. The next hand uses Level ${t.blindLevel} blinds.`,now,h);
 }
 t.readyAt=now+TOURNAMENT_LIMITS.tableReviewMs;t.waitingForTables=false;t.barrierTarget={type:'hand',value:t.roundNo};
 return true;
}
async function startTournament(w,t,now,h){
 if(t.status!=='registration')error(h,'Registration for this tournament is already closed.',409,'tournament_started');
 if(w.clock.paused)error(h,'The shared world is paused.',409,'world_paused');
 if(w.clock.minute<t.startMinute)error(h,'This tournament has not reached its announced start time.',409,'tournament_not_due');
 if(w.clock.minute>t.closeMinute)error(h,'The registration window has ended.',409,'tournament_closed');
 validateEra(w,t.settings,t.city,w.clock.minute,h);
 const humans=values(t).filter(p=>p.kind==='human');if(!humans.length)error(h,'At least one human player must register before the event starts.',409,'no_human_entrants');
 const otherField=sum(Object.values(w.tournaments).filter(x=>x.id!==t.id&&ACTIVE.has(x.status)).map(x=>x.fieldSize||x.settings?.fieldSize||0));
 if(otherField+t.settings.fieldSize>TOURNAMENT_LIMITS.field)error(h,'This world is already running its supported field capacity. Wait for an event to finish before starting this one.',409,'tournament_capacity');
 for(const p of humans){
  if(player(w,p.id)?.availability?.life842||Object.values(w.life842?.games||{}).some(g=>g.status!=='closed'&&g.members?.[p.id]?.seated))error(h,`${p.name} must finish the household activity or cash game before tournament start.`,409,'household_busy');
  const busy=Object.values(w.tournaments).find(x=>x.id!==t.id&&ACTIVE.has(x.status)&&x.participants?.[p.id]?.status==='active');
  if(busy)error(h,`${p.name} already has a live tournament seat.`,409,'tournament_overlap');
 }
 t.status='running';t.startedAt=now;t.startedMinute=w.clock.minute;t.year=new Date(w.clock.minute*60000).getUTCFullYear();t.levelStartedAt=now;t.roundNo=1;t.roundProcessed=0;t.handsInLevel=0;t.completedLevels=0;
 for(const p of humans){p.status='active';if(p.profile)p.profile.year=t.year;const human=player(w,p.id);if(human){human.tournamentStats||={entries:0,wins:0,cashes:0,points:0,earnings:0};human.tournamentStats.entries=(human.tournamentStats.entries||0)+1;}}
 const choices=t.botChoices||[];let unavailableLegends=0;for(let i=0;values(t).length<t.settings.fieldSize;i++){const bot=makeBot(t,i,choices[i]);if(choices[i]?.legendId&&!bot.legendId)unavailableLegends++;t.participants[bot.id]=bot;}
 t.fieldSize=values(t).length;t.totalChips=t.fieldSize*t.settings.startingStack;t.prizePoolCents=t.fieldSize*Math.round(t.settings.buyIn*100);
 t.aiEntryFundingCents=(t.fieldSize-humans.length)*Math.round(t.settings.buyIn*100);t.payoutCents=payoutLadder(t.fieldSize,t.prizePoolCents);t.paidPlaces=t.payoutCents.length;
 reseat(t,now,true);checkpoint(t,'starting_seats',now,w.clock.minute);newRound(w,t,now,h);
 if(unavailableLegends)note(w,t,`${unavailableLegends} selected Legend${unavailableLegends===1?' is':'s are'} unavailable in ${t.year}. Those seats use generated rivals.`,now,h);
 note(w,t,`${t.name} started with ${t.fieldSize} real engine entrants across ${tables(t).length} tables. ${humans.length} human${humans.length===1?'':'s'} and ${t.fieldSize-humans.length} AI rivals.`,now,h);return true;
}
async function cancel(w,t,now,h,reason){
 if(t.status!=='registration')error(h,'A live tournament cannot be cancelled or have stacks discarded.',409,'tournament_started');
 for(const p of values(t))if(p.kind==='human'){
  const human=player(w,p.id);if(human&&t.settings.buyIn){if(!h?.credit)error(h,'Wallet authority is unavailable.',503,'wallet_unavailable');await h.credit(w,human,t.settings.buyIn,`${t.name} · registration refund`,p.entryRef+':refund',now);}
  p.status='refunded';if(human?.tournaments?.[t.id])human.tournaments[t.id].cancelledAt=now;
 }
 t.status='cancelled';t.blockClock=false;t.cancelledAt=now;note(w,t,reason||'Registration cancelled. Entry fees were refunded once.',now,h);await archiveComplete(w,t,now,h);return true;
}
function safeAction(g){const list=legal(g,g.actor),choice=list.find(x=>x.type==='draw'||x.type==='discard');return choice?{type:choice.type,indices:choice.type==='discard'?[g.seats[g.actor].hole.length-1]:[]}:{type:list.some(x=>x.type==='check')?'check':'fold'};}
function connectionState(w,t,tp,now,h){
 if(tp.kind!=='human')return{state:'AI',graceRemainingMs:0};
 const human=player(w,tp.id),online=humanAvailable(w,t,tp,now,h);
 if(online)return{state:tp.lastReconnectedAt&&now-tp.lastReconnectedAt<5000?'RECONNECTED':'CONNECTED',graceRemainingMs:0};
 const since=tp.disconnectedAt??human?.availability?.startedAt??((human?.lastSeen??t.startedAt??t.createdAt)+TOURNAMENT_LIMITS.heartbeatGraceSeconds*1000);
 const graceRemainingMs=Math.max(0,TOURNAMENT_LIMITS.disconnectGraceSeconds*1000-(now-since));
 return{state:graceRemainingMs?'RECONNECT_GRACE':tp.timeoutActions?'BLIND_AWAY':'DISCONNECTED_SEATED',graceRemainingMs};
}
function refreshConnections(w,t,now,h){
 let changed=false;
 for(const tp of values(t).filter(x=>x.kind==='human'&&x.status==='active')){
  const online=humanAvailable(w,t,tp,now,h),previous=tp.disconnectState||'CONNECTED';
  if(online){
   if(!['CONNECTED','RECONNECTED'].includes(previous)){tp.lastReconnectedAt=now;tp.disconnectedAt=null;changed=true;}
  }else if(tp.disconnectedAt===null){const human=player(w,tp.id);tp.disconnectedAt=Math.min(now,human?.availability?.startedAt??((human?.lastSeen??now)+TOURNAMENT_LIMITS.heartbeatGraceSeconds*1000));changed=true;}
  const next=connectionState(w,t,tp,now,h).state;
  if(previous!==next){tp.disconnectState=next;changed=true;}
  if(next==='RECONNECT_GRACE'){
   const tb=ownerTable(t,tp.id),g=tb?.game;
   if(g&&g.actor>=0&&g.seats[g.actor]?.id===tp.id&&g.deadline!==null&&g.deadline<tp.disconnectedAt+TOURNAMENT_LIMITS.disconnectGraceSeconds*1000){
    g.deadline=tp.disconnectedAt+TOURNAMENT_LIMITS.disconnectGraceSeconds*1000;changed=true;
   }
  }
 }
 return changed;
}
function tableTick(w,t,tb,now,h){
 const g=tb.game;if(!g||g.phase==='complete')return false;let changed=false,steps=0;
 // AI-only tables receive a modest catch-up budget. They still use the exact
 // same deck/action/settlement engine and stop at the same hand barrier.
 const hasHumans=tb.playerIds.some(id=>t.participants[id]?.kind==='human'),budget=hasHumans?1:5;
 while(g.phase!=='complete'&&steps++<budget){
  const seat=g.seats[g.actor],tp=t.participants[seat.id];
  if(g.deadline!==null&&now>=g.deadline){tick(g,now);changed=true;tb.botTurn=null;}
  else if(tp.kind!=='human'){
   const key=epochTurn(tb);
   if(hasHumans&&tb.botTurn!==key){tb.botTurn=key;tb.botDue=now+330+hashSeed(key+'|'+tp.id)%191;changed=true;break;}
   if(hasHumans&&now<tb.botDue)break;
   let action;try{action=chooseBotAction(g,g.actor,tp.aiProfile,hashSeed(`${tp.aiSeed}|${g.handNo}|${g.turnId}`));}
   catch(e){t.aiFallbacks++;action=safeAction(g);}
   act(g,g.actor,action,now);tb.botTurn=null;changed=true;
  }else{
   const human=player(w,tp.id),available=humanAvailable(w,t,tp,now,h);
   if(available){if(tp.disconnectedAt!==null){tp.disconnectedAt=null;changed=true;}break;}
   const last=human?.lastSeen??t.startedAt;
   const since=human?.availability?.startedAt??(human?.status==='removed'?Math.min(now,last):last);
   if(tp.disconnectedAt===null){tp.disconnectedAt=Math.min(now,since);changed=true;}
   if(now-tp.disconnectedAt<TOURNAMENT_LIMITS.disconnectGraceSeconds*1000)break;
   // An all-in betting seat cannot be the engine actor. All-in Draw and
   // Pineapple choices use stand-pat/last-card and remain eligible at showdown.
   act(g,g.actor,safeAction(g),now);tp.graceUsed=true;tp.timeoutActions=(tp.timeoutActions||0)+1;tb.botTurn=null;changed=true;
  }
  syncTable(t,tb);tb.turnCounter=g.turnId;
 }
 if(g.phase==='complete'&&!tb.finishedAt){tb.finishedAt=now;syncTable(t,tb);changed=true;}
 return changed;
}
function pause(t,now,w){
 if(t.pausedAt!==null)return false;
 const host=player(w,w.hostPlayerUuid),at=w.clock.pauseReason==='host-disconnected'&&host?Math.min(now,host.lastSeen+90000):now;
 t.pausedAt=Math.max(t.lastTickAt||t.startedAt||at,at);t.pauseReason=w.clock.pauseReason||'world-paused';return true;
}
function resume(t,now){
 if(t.pausedAt===null)return false;const elapsed=Math.max(0,now-t.pausedAt);
 for(const tb of tables(t)){if(tb.game?.deadline!==null&&tb.game?.deadline!==undefined)tb.game.deadline+=elapsed;if(tb.botDue)tb.botDue+=elapsed;}
 if(t.levelStartedAt)t.levelStartedAt+=elapsed;if(t.readyAt)t.readyAt+=elapsed;t.pausedAt=null;t.pauseReason=null;return true;
}
export function isTournamentCommand(type){return COMMANDS.has(type);}
export async function handleTournament(w,p,body,now,h={}){
 const type=body.type;if(!COMMANDS.has(type))return false;w.tournaments||={};
 if(type==='tournament_progress')error(h,'Tournament progress is generated by settled server hands. Manual stack and barrier reports are disabled.',409,'server_tournament_authority');
 if(type==='tournament_create'){
  compactHistory(w);
  hostOnly(w,p,h);if(Object.values(w.tournaments).filter(t=>!['complete','cancelled','legacy_incomplete'].includes(t.status)).length>=8)error(h,'Finish or cancel an existing event before creating another.');
  const settings=normalizeSettings(body.settings,h),city=short(body.city||p.location?.city||w.settings?.startingCity,'',96);
  if(!WORLD_CITIES[city])error(h,'Choose a known event city.');
  const startMinute=body.startMinute??w.clock.minute;integer(h,startMinute,w.clock.minute,w.clock.minute+366*1440,'Tournament start minute');
  validateEra(w,settings,city,startMinute,h);
  const id=typeof body.tournamentId==='string'&&/^[A-Za-z0-9_-]{8,96}$/.test(body.tournamentId)?body.tournamentId:'tour_'+randomHex(12);
  if(w.tournaments[id])error(h,'That tournament identity already exists.',409,'tournament_exists');
  const raw=body.bots??[];if(!Array.isArray(raw)||raw.length>settings.fieldSize-1)error(h,'Choose fewer Legends than the tournament field.');
  const botChoices=raw.map(x=>({legendId:typeof x==='string'?x:short(x?.legendId,'',64)}));
  const eventYear=new Date(startMinute*60000).getUTCFullYear();
  for(const x of botChoices)if(x.legendId){
   const legend=legendProfile(x.legendId);if(!legend)error(h,'A selected Legend is not in this release.',400,'invalid_legend');
   const gate=legendEraGate(x.legendId,eventYear);if(!gate.ok)error(h,`${legend.name}: ${gate.reason}`,409,'tournament_legend_era');
  }
  if(new Set(botChoices.filter(x=>x.legendId).map(x=>x.legendId)).size!==botChoices.filter(x=>x.legendId).length)error(h,'A Legend may enter only once.');
  const t={schema:2,version:TOURNAMENT_VERSION,id,name:short(body.name,'Shared Championship',100),source:'host-created',settings,city,cityName:WORLD_CITIES[city].name,
   year:eventYear,createdAt:now,hostPlayerUuid:p.playerUuid,startMinute,closeMinute:startMinute+180,autoStart:body.autoStart===true,
   status:'registration',stage:'registration',participants:{},tables:{},botChoices,results:[],checkpoints:[],chat:[],seed:randomHex(16),registrationSequence:0,
   blindLevel:1,dayNo:1,breakNo:0,roundNo:0,roundProcessed:0,tableSeq:0,checkpointNo:0,handsCompleted:0,completedLevels:0,fieldSize:0,totalChips:0,prizePoolCents:0,
   blockClock:false,waitingForTables:false,barrierTarget:null,pausedAt:null,readyAt:null,resumeMinute:null,aiFallbacks:0,lastTickAt:now};
  w.tournaments[id]=t;note(w,t,`${t.name} announced in ${t.cityName}. Registration and opening stakes are fixed before the first deal.`,now,h);return true;
 }
 const t=w.tournaments[String(body.tournamentId||'')];if(!t)error(h,'That tournament was not found.',404,'tournament_missing');
 if(t.schema!==2)error(h,'This legacy entry contains only unverified checkpoints. Create a new authoritative tournament; its old data is retained.',409,'legacy_tournament');
 if(type==='tournament_join'){
  if(Object.values(w.life842?.games||{}).some(g=>g.status!=='closed'&&g.members?.[p.playerUuid]?.seated))error(h,'Cash out of the home game before joining a tournament.',409,'home_poker_active');
  if(t.status!=='registration'||w.clock.minute>t.closeMinute)error(h,'Tournament registration is closed.',409,'tournament_closed');
  if(t.participants[p.playerUuid])return false;
  if(values(t).length>=t.settings.fieldSize)error(h,'This tournament field is full.',409,'tournament_full');
  if(p.availability)error(h,'Finish your current shared activity before registering.',409,'already_unavailable');
  if(t.settings.source==='live'&&p.location?.city!==t.city)error(h,'Travel to the event city before registering.',409,'tournament_location');
  const conflict=Object.values(w.tournaments).find(x=>x.id!==t.id&&(ACTIVE.has(x.status)||x.status==='registration')&&x.participants?.[p.playerUuid]&&['active','registered'].includes(x.participants[p.playerUuid].status));
  if(conflict)error(h,'This character already has another tournament entry. Finish it or withdraw before registering again.',409,'tournament_overlap');
  const tp=makeHuman(p,t,now,++t.registrationSequence);
  if(t.settings.buyIn){if(!h?.debit)error(h,'Wallet authority is unavailable.',503,'wallet_unavailable');await h.debit(w,p,t.settings.buyIn,`${t.name} · entry`,tp.entryRef,now);}
  t.participants[p.playerUuid]=tp;p.tournaments||={};p.tournaments[t.id]={joinedAt:now,entryRef:tp.entryRef};note(w,t,`${p.name} registered. Starting chips are assigned by the tournament authority.`,now,h);return true;
 }
 if(type==='tournament_unregister'){
  if(t.status!=='registration')error(h,'A running freezeout keeps every registered seat and stack, including absent players.',409,'tournament_started');
  const tp=t.participants[p.playerUuid];if(!tp)return false;
  if(t.settings.buyIn){if(!h?.credit)error(h,'Wallet authority is unavailable.',503,'wallet_unavailable');await h.credit(w,p,t.settings.buyIn,`${t.name} · withdrawal refund`,tp.entryRef+':refund',now);}
  delete t.participants[p.playerUuid];delete p.tournaments?.[t.id];note(w,t,`${p.name} withdrew before the start. Entry refunded once.`,now,h);return true;
 }
 if(type==='tournament_start'){hostOnly(w,p,h);return startTournament(w,t,now,h);}
 if(type==='tournament_cancel'){hostOnly(w,p,h);return cancel(w,t,now,h);}
 if(type==='tournament_table'){
  p.tournamentWatch||={};const requested=body.tableId?String(body.tableId):null,own=ownerTable(t,p.playerUuid);
  if(requested&&!t.tables[requested])error(h,'That table has closed. Your view will follow the current seating.',409,'table_closed');
  if(!own&&!t.settings.allowSpectators)error(h,'Spectating is disabled for this event.',403,'spectators_disabled');
  const selected=own?.id||requested||tables(t)[0]?.id||null;
  if(p.tournamentWatch[t.id]===selected)return false;p.tournamentWatch[t.id]=selected;return true;
 }
 if(type==='tournament_chat'){
  if(p.chatMutedUntil>now)error(h,'Chat is muted for this player.',403,'chat_muted');
  if(now-(p.lastTournamentChat||0)<650)error(h,'Please wait before sending another table message.',429,'slow_down');
  const text=short(body.text,'',280);if(!text)error(h,'Write a message.');p.lastTournamentChat=now;
  t.chat.push({id:randomHex(6),name:p.name,playerUuid:p.playerUuid,text,at:now,system:false});t.chat=t.chat.slice(-80);return true;
 }
 if(type==='tournament_action'){
  if(w.clock.paused||t.pausedAt!==null)error(h,'Tournament action is paused with the shared world.',409,'world_paused');
  if(t.status!=='running')error(h,'The tournament is between rounds or complete.',409,'tournament_not_running');
  const tp=t.participants[p.playerUuid],tb=ownerTable(t,p.playerUuid);
  if(!tp||tp.status!=='active'||!tb||tb.id!==body.tableId)error(h,'This identity does not own that active tournament seat.',403,'not_your_table');
  if(!humanAvailable(w,t,tp,now,h))error(h,'Return from your shared activity to act at the tournament table.',409,'player_unavailable');
  if(typeof body.turnId!=='string'||body.turnId!==epochTurn(tb))error(h,'The table has moved on. Your latest seat and hand will reload.',409,'stale_turn');
  const at=tb.game.seats.findIndex(x=>x.id===p.playerUuid);if(at!==tb.game.actor)error(h,'Wait for your turn.',409,'not_your_turn');
  if(!body.action||typeof body.action!=='object'||Array.isArray(body.action))error(h,'Choose a legal action.');
  const action={type:body.action.type};if(action.type==='raise')action.target=body.action.target;if(['draw','discard'].includes(action.type))action.indices=body.action.indices;
  try{act(tb.game,at,action,now);}catch(e){error(h,e.message,409,'illegal_action');}
  syncTable(t,tb);tb.turnCounter=tb.game.turnId;tb.botTurn=null;if(tb.game.phase==='complete')tb.finishedAt=now;
  assertTournament(t);await finishRound(w,t,now,h);return true;
 }
 return false;
}
export async function tickTournaments(w,now,h={}){
 let changed=false;
 for(const t of Object.values(w.tournaments||{})){
  if(t.schema!==2){if(t.status==='running'){t.status='legacy_incomplete';t.blockClock=false;changed=true;}continue;}
  if(t.status==='registration'){
   if(w.clock.minute>t.closeMinute){await cancel(w,t,now,h,'The announced registration window ended. All entry fees were refunded.');changed=true;}
   else if(t.autoStart&&w.clock.minute>=t.startMinute&&values(t).some(p=>p.kind==='human')&&!w.clock.paused){
    const used=sum(Object.values(w.tournaments).filter(x=>x.id!==t.id&&ACTIVE.has(x.status)).map(x=>x.fieldSize||x.settings?.fieldSize||0));
    if(used+t.settings.fieldSize<=TOURNAMENT_LIMITS.field){await startTournament(w,t,now,h);changed=true;}
   }
   continue;
  }
  if(!ACTIVE.has(t.status))continue;
  changed=refreshConnections(w,t,now,h)||changed;
  if(w.clock.paused){changed=pause(t,now,w)||changed;continue;}
  changed=resume(t,now)||changed;
  if(t.status==='break'||t.status==='day_break'){
   if(w.clock.minute>=t.resumeMinute&&now>=t.readyAt){
    if(t.pendingDayNo){t.dayNo=t.pendingDayNo;t.pendingDayNo=null;}
    t.roundNo++;t.levelStartedAt=now;newRound(w,t,now,h);checkpoint(t,'resume_day_or_break',now,w.clock.minute);note(w,t,`Day ${t.dayNo} · Level ${t.blindLevel} resumed. Absent entrants retain their stacks and post all forced bets.`,now,h);changed=true;
   }
   continue;
  }
  if(t.readyAt!==null&&t.roundProcessed===t.roundNo){
   if(now>=t.readyAt){t.roundNo++;newRound(w,t,now,h);changed=true;}
   continue;
  }
  for(const tb of tables(t))changed=tableTick(w,t,tb,now,h)||changed;
  const all=tables(t),waiting=all.some(tb=>tb.game?.phase==='complete')&&all.some(tb=>tb.game?.phase!=='complete');
  if(t.waitingForTables!==waiting){t.waitingForTables=waiting;changed=true;}
  if(waiting)t.barrierTarget={type:'hand',value:t.roundNo,waitingTables:all.filter(tb=>tb.game?.phase!=='complete').map(tb=>tb.id)};
  changed=await finishRound(w,t,now,h)||changed;t.lastTickAt=now;
 }
 return changed;
}
export function tournamentNextEvent(w){
 const events=[];
 for(const t of Object.values(w.tournaments||{}))if(t.schema===2){
  if(['day_break','break'].includes(t.status)&&t.resumeMinute>w.clock.minute)events.push(t.resumeMinute);
  if(t.status==='registration'&&t.autoStart&&t.startMinute>w.clock.minute)events.push(t.startMinute);
 }
 return events.length?Math.min(...events):null;
}
export function tournamentBlockers(w){
 const out=[];for(const t of Object.values(w.tournaments||{}))if(t.schema===2&&t.status==='running'){
  out.push({tournamentId:t.id,kind:'shared_tournament',label:t.name});
  for(const tp of values(t))if(tp.kind==='human'&&tp.status==='active')out.push({tournamentId:t.id,playerUuid:tp.id,kind:'shared_tournament',label:t.name});
 }return out;
}
function tournamentRoom(w,t,p,now){
 const own=ownerTable(t,p.playerUuid),watch=t.tables[p.tournamentWatch?.[t.id]],tb=own||(watch?.active!==false?watch:null)||tables(t)[0]||Object.values(t.tables)[0];
 if(!tb?.game||(!own&&!t.settings.allowSpectators))return null;
 const seat=own?tb.game.seats.findIndex(x=>x.id===p.playerUuid):-1,raw=publicView(tb.game,seat),tp=t.participants[p.playerUuid];
 const paused=w.clock.paused||t.pausedAt!==null||t.status!=='running';
 const rows=(raw.players||raw.seats||[]).map(row=>{
   const entry=t.participants[row.id],connection=connectionState(w,t,entry,now);return{...row,profile:copy(entry.profile),bot:entry.kind!=='human',legendId:entry.legendId||null,style:entry.aiProfile?.style||'HUMAN',aiProfile:entry.aiProfile?copy(entry.aiProfile):null,disconnectState:connection.state,graceRemainingMs:connection.graceRemainingMs};
 });
 const table={...raw,seats:rows,name:t.name,tournament:true,career:true,practice:false,digital:t.settings.source==='online',tableId:tb.id,tournamentId:t.id,
  sbSeat:raw.positions.sb,bbSeat:raw.positions.bb,turnId:epochTurn(tb),done:tb.game.phase==='complete',paused,
  legal:paused||seat<0||!humanAvailable(w,t,tp,now)?[]:raw.legal,canAct:!paused&&seat>=0&&tb.game.actor===seat,
  youSeat:seat<0?-1:0,barrier:t.barrierTarget?copy(t.barrierTarget):null};delete table.players;
 const blind=currentBlind(t),blindProgression={schema:1,mode:t.settings.blindMode,pace:t.settings.blindPace,every:t.settings.blindEvery,
  started:!!t.startedAt,level:t.blindLevel-1,number:t.blindLevel,current:blind,next:BlindSchedule.levelSpec(t.settings,t.blindLevel),
  pending:!!t.barrierTarget,handsRemaining:Math.max(0,t.settings.blindEvery-t.handsInLevel),remainingMs:t.settings.blindMode==='minutes'?Math.max(0,t.levelStartedAt+t.settings.blindEvery*60000-now):null,
  nextAt:t.settings.blindMode==='minutes'?t.levelStartedAt+t.settings.blindEvery*60000:null,clockAt:now,catchUp:'all-table-checkpoint',capReached:blind.capReached};
 const roster=tb.game.seats.map((row,i)=>{const entry=t.participants[row.id],human=entry.kind==='human';return{id:entry.id,name:entry.name,profile:copy(entry.profile),
  seat:i,ready:true,connected:!human||connected(player(w,entry.id),now),bot:!human,host:false,spectator:false,waiting:false,stack:row.stack,
  legendId:entry.legendId||null,style:entry.aiProfile?.style||'HUMAN',aiProfile:entry.aiProfile?copy(entry.aiProfile):null,disconnectState:connectionState(w,t,entry,now).state,graceRemainingMs:connectionState(w,t,entry,now).graceRemainingMs};});
 if(!roster.some(x=>x.id===p.playerUuid))roster.push({id:p.playerUuid,name:p.name,profile:ownAppearance(p,t.year),seat:-1,spectator:true,bot:false,connected:true,ready:false,stack:0});
 const statusMessage=t.status==='complete'?`${values(t).find(x=>x.id===t.winnerId)?.name||'Champion'} won. Results and prizes are saved.`:
  t.pausedAt!==null||w.clock.paused?'Shared world paused. Cards, committed chips and turn time are preserved.':t.status==='day_break'?`Day ${t.dayNo} complete. Saved stacks resume on Day ${t.pendingDayNo}.`:
  t.status==='break'?`Scheduled break. Next: Level ${t.blindLevel}.`:tb.game.phase==='complete'?t.waitingForTables?'Your hand is complete. Waiting for the other tables.':'Hand checkpoint saved. The next deal starts automatically.':`${values(t).filter(x=>x.status==='active').length} players remain · ${tables(t).length} table${tables(t).length===1?'':'s'}.`;
 return{version:TOURNAMENT_VERSION,code:w.worldCode,revision:w.revision,youId:p.playerUuid,youSeat:seat,youWaiting:false,hostId:null,status:tb.game?'playing':'lobby',
  settings:{...t.settings,buyin:t.settings.startingStack,allowRebuys:false,autoFillBots:false,allowCheats:false},roster,table,chat:copy(t.chat.filter(m=>m.system||![...(p.muted||[]),...(p.blocked||[])].includes(m.playerUuid))),serverTime:now,blindProgression,
  careerTournament:{id:t.id,name:t.name,tableId:tb.id,tableNumber:tb.index,tableLabel:`Table ${tb.index}`,city:t.city,year:t.year,dayNo:t.dayNo,blindLevel:t.blindLevel,status:t.status,statusMessage,message:statusMessage,waitingReason:statusMessage,
   paused,waitingForTables:t.waitingForTables,resumeMinute:t.resumeMinute,entryStatus:tp?.status||'spectator',place:tp?.finish?.place||null,payout:tp?.finish?.payout??null,remaining:activeEntries(t).length,field:t.fieldSize},
  nextPollMs:paused?800:tb.game.phase==='complete'?500:350,limits:{reconnectGraceSeconds:TOURNAMENT_LIMITS.disconnectGraceSeconds,roomLifetimeHours:null},expiresAt:w.expiresAt};
}
export function tournamentViews(w,playerUuid,now){
 const p=player(w,playerUuid);if(!p)return[];
 return Object.values(w.tournaments||{}).map(t=>{
  if(t.schema!==2)return{id:t.id,name:t.name,status:'legacy_incomplete',stage:'legacy_incomplete',legacy:true,dayNo:t.dayNo||1,blindLevel:t.blindLevel||1,participants:[],roomView:null,
   notice:'This older record contains manual progress checkpoints only. It is retained without minting chips or awarding unverified results.'};
  const entry=t.participants[p.playerUuid],active=tables(t);
  return{id:t.id,name:t.name,status:t.status,stage:t.stage,dayNo:t.dayNo,blindLevel:t.blindLevel,breakNo:t.breakNo,year:t.year,city:t.city,cityName:t.cityName,createdAt:t.createdAt,
   source:t.source,hostPlayerUuid:w.hostPlayerUuid,settings:copy(t.settings),startMinute:t.startMinute,closeMinute:t.closeMinute,autoStart:t.autoStart,historyArchived:!!t.archiveRef,historyCompacted:!!t.historyCompacted,
   registered:!!entry,entryStatus:entry?.status||null,ownTableId:ownerTable(t,p.playerUuid)?.id||null,fieldSize:t.fieldSize||t.settings.fieldSize,
   humanCount:values(t).filter(x=>x.kind==='human').length,registeredCount:values(t).length,remaining:activeEntries(t).length,prizePool:t.prizePoolCents/100,
   startingChips:t.totalChips,payouts:t.payoutCents?.map(x=>x/100)||[],paidPlaces:t.paidPlaces||0,roundNo:t.roundNo,handsCompleted:t.handsCompleted,
   paused:w.clock.paused||t.pausedAt!==null,pauseReason:t.pauseReason||w.clock.pauseReason||null,waitingForTables:t.waitingForTables,barrierTarget:copy(t.barrierTarget),resumeMinute:t.resumeMinute,
   participants:values(t).map(tp=>({id:tp.id,playerUuid:tp.playerUuid,name:tp.name,kind:tp.kind,status:tp.status,stack:tp.stack,tableId:tp.tableId,seat:tp.seat,
    connected:tp.kind!=='human'||connected(player(w,tp.id),now),disconnectState:connectionState(w,t,tp,now).state,graceRemainingMs:connectionState(w,t,tp,now).graceRemainingMs,legendId:tp.legendId||null,style:tp.aiProfile?.style||'HUMAN',place:tp.finish?.place||null,payout:tp.finish?.payout||0})),
   tables:active.map(tb=>({id:tb.id,index:tb.index,players:tb.playerIds.length,handNo:tb.game?.handNo||0,done:tb.game?.phase==='complete',pot:tb.game?.pot||0})),
   results:copy(t.results).sort((a,b)=>a.place-b.place||a.playerName.localeCompare(b.playerName)),lastCheckpoint:t.lastCheckpoint?{id:t.lastCheckpoint.id,kind:t.lastCheckpoint.kind,at:t.lastCheckpoint.at,round:t.lastCheckpoint.round,day:t.lastCheckpoint.day,level:t.lastCheckpoint.level}:null,
   roomView:t.startedAt?tournamentRoom(w,t,p,now):null,limits:TOURNAMENT_LIMITS};
 });
}
export function assertTournament(t){
 if(t.schema!==2||!t.startedAt)return true;
 const active=tables(t),seen=[];
 for(const tb of active){if(tb.game)assertGame(tb.game);seen.push(...tb.playerIds);}
 if(new Set(seen).size!==seen.length)throw Error('A tournament identity is seated twice.');
 const balance=sum(values(t).map(p=>p.stack))+sum(active.map(tb=>tb.game?.pot||0));
 if(balance!==t.totalChips)throw Error(`Tournament chips were created or lost (${balance} / ${t.totalChips}).`);
 if(t.status!=='complete'&&activeEntries(t).some(p=>!seen.includes(p.id)))throw Error('An active funded entrant has no authoritative table.');
 if(t.results.length!==new Set(t.results.map(r=>r.resultId)).size)throw Error('Duplicate tournament result.');
 if(sum(t.results.map(r=>r.payoutCents))>t.prizePoolCents)throw Error('Tournament prizes exceeded their funded pool.');
 return true;
}
export const tournamentMetadata=()=>({version:TOURNAMENT_VERSION,variants:Object.values(VARIANTS).map(v=>({id:v.id,name:v.name,maxSeats:v.seatCap,family:v.family,betting:v.betting})),legends:LEGEND_PROFILES.filter(p=>Object.hasOwn(LEGEND_ERAS,p.id)).map(p=>({...p,...LEGEND_ERAS[p.id]})),legendPolicy:'native-career-active-years',allowFantasyLegends:false,limits:TOURNAMENT_LIMITS,authority:'existing-rules-engine',ai:'own-and-public-personality-policy',manualBarriers:false});
