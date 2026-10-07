/* V84.2 home cash tables. Cards/stacks remain in the existing rules engine.
 * Buy-ins and cash-outs commit in the SAME Career world CAS as table state.
 * One integer chip is one cent of fictional Career money; UI labels conversion.
 */
import Life from './life842-core.mjs';
import {createGame,startHand,act,tick,publicView,assertGame} from './engine.mjs';
import {getVariant} from './cards.mjs';
import {VARIANT_START} from './career84-world-policy.mjs';
const cp=Life.cp,ok=Life.ok,players=g=>Object.values(g.members).filter(m=>m.seated),ended=g=>!g.game||['idle','complete'].includes(g.game.phase);
function player(w,id){return w.players.find(p=>p.playerUuid===id);}
function key(g){return g.id+':'+g.epoch+':'+(g.game?.turnId||0);}
function seatedElsewhere(w,id,except){return Object.values(Life.seed(w).games).some(g=>g.id!==except&&g.status!=='closed'&&g.members[id]?.seated);}
function note(w,g,msg,ctx){Life.log(w,'home-poker',msg,players(g).map(x=>x.id));}
function sync(g){if(!g.game)return;for(const seat of g.game.seats)if(g.members[seat.id]?.seated)g.members[seat.id].stack=seat.stack;}
function eligible(w,p,g){return p?.status==='active'&&p.location?.city===g.city&&!p.availability&&!seatedElsewhere(w,p.playerUuid,g.id)&&!p.blocker?.active&&!Object.values(w.tournaments||{}).some(t=>['running','break','day_break'].includes(t.status)&&t.participants?.[p.playerUuid]?.status==='active');}
function debit(w,p,n,ref,ctx){Life.wallet(w,p,-n,'home-poker-buyin',ref,ctx);}
function cashout(w,g,m,ctx){
 if(!m?.seated)return;ok(ended(g),'Committed chips stay in the hand until settlement.');
 sync(g);Life.wallet(w,m.id,m.stack,'home-poker-cashout',g.id+':cashout:'+m.id+':'+m.entry,ctx);
 g.cashoutCents+=m.stack;m.seated=false;m.cashedAt=ctx.now;m.lastCashoutCents=m.stack;m.stack=0;g.needsRebuild=true;note(w,g,'Cash-out saved for '+m.name,ctx);
}
function verify(g){if(g.game&&!g.needsRebuild)assertGame(g.game);const pot=g.game&&!ended(g)?g.game.pot:0;
 const chips=!ended(g)?g.game.seats.reduce((n,x)=>n+x.stack,0)+pot:players(g).reduce((n,x)=>n+x.stack,0);
 ok(chips+g.cashoutCents===g.buyinCents,'Home poker escrow does not conserve chips.');return true;}
function start(w,g,ctx){
 ok(ended(g),'A hand is still running.');sync(g);for(const m of players(g))if(m.leaving)cashout(w,g,m,ctx);
 const funded=players(g).filter(x=>x.stack>0);if(funded.length<2)return false;
 // A disconnected seat remains owned, but cash games do not force a new absent hand.
 const present=funded.filter(m=>ctx.connected(player(w,m.id),ctx.now));if(present.length<2)return false;
 if(g.needsRebuild||!g.game){
  const oldButton=g.game?.seats[g.game.button]?.id;
  g.game=createGame(g.settings,funded.map(m=>({id:m.id,name:m.name,stack:m.stack})));
  if(oldButton){const i=g.game.seats.findIndex(s=>s.id===oldButton);g.game.button=i<0?-1:i;}
  g.needsRebuild=false;g.epoch++;
 }
 for(const seat of g.game.seats){const m=g.members[seat.id];seat.sittingOut=!m?.seated||m.leaving||!ctx.connected(player(w,seat.id),ctx.now);}
 if(g.game.seats.filter(s=>s.stack>0&&!s.sittingOut).length<2)return false;
 startHand(g.game,ctx.now);g.hands++;g.status='playing';g.reviewUntil=null;sync(g);verify(g);return true;
}
export function homeBlockers(w){return Object.values(w.life842?.games||{}).filter(g=>g.status!=='closed'&&players(g).length).map(g=>({kind:'home_poker',label:g.name,gameId:g.id}));}
export function homeTick(w,now,ctx){
 let changed=false;
 for(const g of Object.values(w.life842?.games||{})){
  if(g.status==='closed')continue;
  const host=player(w,g.host),f=w.life842.furniture[g.itemId],r=w.life842.properties[g.propertyId];
  if(!host||host.status==='removed'||!f||f.status!=='placed'||f.place?.propertyId!==g.propertyId||!r||!Life.access(w,host,r,g.unit)||r.work){if(!g.closing){g.closing=true;changed=true;note(w,g,'Home access ended. The committed hand will settle before cash-out.',ctx);}}
  if(w.clock.paused){if(!g.pausedAt){g.pausedAt=now;changed=true;}continue;}
  if(g.pausedAt){if(g.game?.deadline)g.game.deadline+=now-g.pausedAt;if(g.reviewUntil)g.reviewUntil+=now-g.pausedAt;g.pausedAt=null;changed=true;}
  if(g.game&&!ended(g)){
   const seat=g.game.seats[g.game.actor],p=seat?player(w,seat.id):null;
   if(p&&!ctx.connected(p,now)&&g.game.deadline<(p.lastSeen||0)+30000)g.game.deadline=(p.lastSeen||0)+30000;
   const revision=g.game.revision,turn=g.game.turnId;tick(g.game,now);if(g.game.revision!==revision||g.game.turnId!==turn){sync(g);changed=true;}
   if(g.game.phase==='complete'&&!g.reviewUntil){g.reviewUntil=now+6000;sync(g);changed=true;}
  }
  if(ended(g)){
   sync(g);for(const m of players(g))if(m.leaving||(now-(player(w,m.id)?.lastSeen||0)>180000&&!ctx.connected(player(w,m.id),now))){cashout(w,g,m,ctx);changed=true;}
   if(g.closing){for(const m of players(g))cashout(w,g,m,ctx);g.status='closed';changed=true;}
   else if(g.reviewUntil&&now>=g.reviewUntil){if(start(w,g,ctx))changed=true;}
  }
  verify(g);
 }
 return changed;
}
export function handleHome(w,p,b,ctx){
 const s=Life.seed(w),action=b.action;ok(p.character?.bound,'Create and save the Career first.');
 ok(!w.clock.paused,'The shared world is paused.');
 if(action==='create'){
  Life.freePlayer(w,p);ok(Object.values(s.games).filter(g=>g.status!=='closed').length<8,'Close an existing home game first.');
  const f=s.furniture[b.itemId];ok(f&&f.owner===p.playerUuid&&f.kind==='poker_table','Place a poker table you own first.');const r=Life.usable(w,p,f,ctx);
  const variant=getVariant(b.variant||'holdem_nl');ok(variant&&new Date(w.clock.minute*60000).getUTCFullYear()>=(VARIANT_START[variant.id]??9999),'This variant is unavailable in this era.');
  const bb=Life.cash(b.bb??2),sb=Math.max(1,Math.floor(bb/2)),buyin=Life.cash(b.buyin??100);ok(bb>=2&&buyin>=bb*20&&buyin<=bb*500,'Buy-in must be between 20 and 500 big blinds.');
  const maxSeats=Life.integer(b.maxSeats??6,2,Math.min(9,variant.seatCap),'Seats');
  const id=Life.id(w,'homegame'),g={id,itemId:f.id,propertyId:r.id,unit:f.place.unit,city:r.city,name:Life.ok&&String(b.name||'Home cash game').replace(/[<>]/g,'').slice(0,64),host:p.playerUuid,status:'lobby',settings:{variant:variant.id,maxSeats,sb,bb,ante:0,buyin,turnSeconds:30,allowCheats:false,allowRebuys:false,autoFillBots:false,blindMode:'fixed',allowSpectators:true},members:{},buyinCents:0,cashoutCents:0,game:null,epoch:0,hands:0,entry:0,needsRebuild:false,created:ctx.now,closing:false,reviewUntil:null,chat:[]};
  s.games[id]=g;return{id};
 }
 const g=s.games[b.gameId];ok(g&&g.status!=='closed','The home game is closed or missing.');const m=g.members[p.playerUuid];
 if(action==='join'){
  ok(ended(g),'Join after the current hand finishes.');ok(eligible(w,p,g),'Travel here and finish any other activity or poker table first.');
  ok(!m?.seated,'This player is already seated.');ok(players(g).length<g.settings.maxSeats,'The home table is full.');
  const f=s.furniture[g.itemId];Life.usable(w,player(w,g.host),f,ctx); // title/tenancy must still be valid
  const n=g.settings.buyin,entry=++g.entry;debit(w,p,n,g.id+':buyin:'+p.playerUuid+':'+entry,ctx);
  g.members[p.playerUuid]={id:p.playerUuid,name:p.name,stack:n,seated:true,entry,joinedAt:ctx.now,leaving:false};g.buyinCents+=n;g.needsRebuild=true;note(w,g,p.name+' bought into the home game.',ctx);
 }else if(action==='start'){ok(g.host===p.playerUuid,'Only the home-game host can start the first hand.');ok(start(w,g,ctx),'At least two funded, connected players must be seated.');}
 else if(action==='leave'){
  ok(m?.seated,'This player has no chips at this table.');m.leaving=true;if(ended(g))cashout(w,g,m,ctx);
 }else if(action==='close'){ok(g.host===p.playerUuid,'Only the home-game host can close it.');g.closing=true;if(ended(g)){for(const m of players(g))cashout(w,g,m,ctx);g.status='closed';}}
 else if(action==='act'){
  ok(m?.seated&&g.game&&!ended(g),'No active hand belongs to this player.');ok(b.turnId===key(g),'The hand has moved on; reload the current turn.');const seat=g.game.seats.findIndex(s=>s.id===p.playerUuid);ok(g.game.actor===seat,'Wait for your turn.');act(g.game,seat,b.move,ctx.now);sync(g);
  if(g.game.phase==='complete')g.reviewUntil=ctx.now+6000;
 }else if(action==='chat'){
  const msg=String(b.message||'').replace(/[<>\u0000-\u001f]/g,'').slice(0,300);ok(msg.trim(),'Enter a message.');ok(g.chat.filter(x=>x.playerUuid===p.playerUuid&&ctx.now-x.at<10000).length<5,'Please slow down the table chat.');
  g.chat.push({id:Life.id(w,'hchat'),playerUuid:p.playerUuid,name:p.name,text:msg,at:ctx.now});g.chat=g.chat.slice(-80);
 }else if(action!=='watch')ok(false,'Unknown home-game action.');
 verify(g);Life.seed(w).revision++;return{id:g.id};
}
function appearance(p,year){
 const input=p?.profile||p?.character?.profile||p?.snapshot?.summary?.profile;
 let seed=2166136261;for(const c of String(p?.playerUuid||'')){seed^=c.charCodeAt(0);seed=Math.imul(seed,16777619);}
 const out={version:1,name:p?.name||'Player',age:Math.max(18,Math.min(100,Number(p?.character?.age||input?.age)||24)),year,seed:seed>>>0,kind:'human'};
 if(input&&typeof input==='object'){if(input.dna&&JSON.stringify(input.dna).length<4096)out.dna=cp(input.dna);if(Number.isSafeInteger(input.seed)&&input.seed>=0&&input.seed<=4294967295)out.seed=input.seed;}
 return out;
}
function room(w,g,p,now,ctx){
 const year=new Date(w.clock.minute*60000).getUTCFullYear();
 if(!g.game)return null;const seat=g.members[p.playerUuid]?.seated?g.game.seats.findIndex(s=>s.id===p.playerUuid):-1,raw=publicView(g.game,seat),paused=w.clock.paused||!!g.pausedAt;
 const seats=raw.players.map(row=>({...row,bot:false,profile:appearance(player(w,row.id),year),disconnectState:ctx.connected(player(w,row.id),now)?'connected':'reconnect-grace'}));
 const roster=players(g).map((m,i)=>({id:m.id,name:m.name,seat:g.game.seats.findIndex(s=>s.id===m.id),ready:true,connected:ctx.connected(player(w,m.id),now),bot:false,host:m.id===g.host,spectator:false,stack:m.stack,profile:appearance(player(w,m.id),year)}));
 if(!roster.some(x=>x.id===p.playerUuid))roster.push({id:p.playerUuid,name:p.name,seat:-1,spectator:true,ready:false,connected:true,bot:false,profile:appearance(p,year)});
 const msg=g.closing?'Closing after the current hand. All committed chips remain eligible.':g.game.phase==='complete'?'Hand saved. Next hand follows the review pause; cash-out requests settle first.':'Home cash game · 100 chips = $1 of Career money. No rake.';
 const table={...raw,seats,career:true,practice:false,tournament:false,homeGame:true,turnId:key(g),paused,sbSeat:raw.positions.sb,bbSeat:raw.positions.bb,legal:paused||seat<0?[]:raw.legal};
 delete table.players;
 return{version:'84.2.0',code:w.worldCode,revision:w.revision,youId:p.playerUuid,youSeat:seat,hostId:null,status:'playing',settings:cp(g.settings),roster,table,serverTime:now,chat:cp(g.chat),homeGame:{id:g.id,chipValue:.01,name:g.name},careerTournament:{id:g.id,name:g.name,city:g.city,year:new Date(w.clock.minute*60000).getUTCFullYear(),dayNo:1,blindLevel:1,status:'running',statusMessage:msg,message:msg,waitingReason:msg,paused,entryStatus:seat<0?'spectator':'active',remaining:players(g).length,field:players(g).length},nextPollMs:500,limits:{reconnectGraceSeconds:30},expiresAt:w.expiresAt};
}
export function homeViews(w,p,now,ctx){return Object.values(w.life842?.games||{}).filter(g=>g.status!=='closed'&&(g.city===p.location?.city||g.members[p.playerUuid]?.seated)).map(g=>({id:g.id,name:g.name,host:g.host,city:g.city,status:g.status,propertyId:g.propertyId,unit:g.unit,buyinCents:g.settings.buyin,bbCents:g.settings.bb,variant:g.settings.variant,maxSeats:g.settings.maxSeats,ownSeated:!!g.members[p.playerUuid]?.seated,ownStack:g.members[p.playerUuid]?.stack||0,leaving:!!g.members[p.playerUuid]?.leaving,closing:g.closing,seats:players(g).length,canJoin:ended(g),handNo:g.hands,roomView:room(w,g,p,now,ctx)}));}
export {verify as assertHomeGame};
