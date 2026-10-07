/** V83.3 room AI. This is a bounded, personality-conditioned poker policy,
 * not a solved GTO strategy. The only entry to the policy is makeObservation:
 * own cards, exposed cards, public wagers, positions and public action history.
 * It never receives the live deck, burns, muck or concealed opponent holdings.
 * Sampling uses a fresh hypothetical deck and is strictly capped per decision.
 */
import {getVariant,createDeck,card,evaluate,compare} from './cards.mjs';
import {legal} from './engine.mjs';
const clamp=(v,a=0,b=1)=>Math.max(a,Math.min(b,Number(v)||0));
const num=(v,d=0)=>Number.isFinite(Number(v))?Number(v):d;
const suitIndex={'♠':0,'♥':1,'♦':2,'♣':3};
const copy=c=>({rank:c.rank,suit:c.suit,val:c.val??('23456789TJQKA'.indexOf(c.rank)+2),text:c.text||c.rank+c.suit});
const key=c=>c.rank+c.suit;
const top=(counts,exclude=[],max=5)=>{const out=[];for(let r=14;r>=2&&out.length<max;r--)if(counts[r]&&!exclude.includes(r))out.push(r);return out;};
export function hashSeed(value){let h=2166136261;for(const c of String(value))h=Math.imul(h^c.charCodeAt(0),16777619);return h>>>0;}
export function seeded(seed=1){let n=seed>>>0;return()=>{n=(n+0x6d2b79f5)|0;let t=Math.imul(n^n>>>15,1|n);t=(t+Math.imul(t^t>>>7,61|t))^t;return((t^t>>>14)>>>0)/4294967296;};}
function packed(values){let n=0;for(let k=0;k<6;k++)n=n*15+(values[k]||0);return n;}
function straight(mask,short=false){for(let r=14;r>=6;r--)if((mask&(31<<(r-4)))===(31<<(r-4)))return r;const wheel=short?[14,9,8,7,6]:[14,5,4,3,2];return wheel.every(r=>mask&(1<<r))?(short?9:5):0;}

/** Fast high evaluator for hypothetical 5–7 card hands, independently checked
 * against the rules authority. No shuffle or settlement uses this evaluator. */
export function fastHigh(cards,spec=getVariant('holdem_nl')){
 const counts=Array(15).fill(0),suits=[0,0,0,0],masks=[0,0,0,0];let mask=0;
 for(const c of cards){const r=c.val??('23456789TJQKA'.indexOf(c.rank)+2),s=suitIndex[c.suit];counts[r]++;suits[s]++;masks[s]|=1<<r;mask|=1<<r;}
 const flush=spec.flushAllowed?suits.findIndex(n=>n>=5):-1;
 if(flush>=0&&spec.straightAllowed){const r=straight(masks[flush],spec.shortDeck);if(r)return packed([8,r]);}
 const groups=[];for(let r=14;r>=2;r--)if(counts[r])groups.push(r);
 const quad=groups.find(r=>counts[r]===4);if(quad)return packed([7,quad,...top(counts,[quad],1)]);
 let flushRanks;if(flush>=0){flushRanks=groups.filter(r=>masks[flush]&(1<<r)).slice(0,5);if(spec.shortDeck)return packed([6,...flushRanks]);}
 const trip=groups.find(r=>counts[r]>=3),pair=trip&&groups.find(r=>r!==trip&&counts[r]>=2);
 if(pair)return packed([spec.shortDeck?5:6,trip,pair]);
 if(flush>=0)return packed([5,...flushRanks]);
 if(spec.straightAllowed){const r=straight(mask,spec.shortDeck);if(r)return packed([4,r]);}
 if(trip)return packed([3,trip,...top(counts,[trip],2)]);
 const pairs=groups.filter(r=>counts[r]>=2);
 if(pairs.length>=2)return packed([2,pairs[0],pairs[1],...top(counts,pairs.slice(0,2),1)]);
 if(pairs.length)return packed([1,pairs[0],...top(counts,pairs,3)]);
 return packed([0,...groups.slice(0,5)]);
}
function low8(cards){const seen=new Set(),r=[];for(const c of cards){const n=c.val===14?1:c.val;if(n<=8&&!seen.has(n)){seen.add(n);r.push(n);}}if(r.length<5)return 0;r.sort((a,b)=>a-b);return packed(r.slice(0,5).reverse().map(n=>15-n));}
export function scoreHypothetical(id,hole,board=[]){
 const spec=getVariant(id);
 if(spec.lowOnly){const e=evaluate(id,hole,board);return {high:packed(e.high),low:0};}
 if(!spec.exactlyTwo){const all=hole.concat(board);return{high:fastHigh(all,spec),low:spec.split?low8(all):0};}
 let high=0,low=0;for(let a=0;a<hole.length-1;a++)for(let b=a+1;b<hole.length;b++)for(let c=0;c<board.length-2;c++)for(let d=c+1;d<board.length-1;d++)for(let e=d+1;e<board.length;e++){
  const five=[hole[a],hole[b],board[c],board[d],board[e]],h=fastHigh(five,spec);if(h>high)high=h;if(spec.split){const l=low8(five);if(l>low)low=l;}
 }return {high,low};
}

export function normalizeProfile(input={}){
 return {id:String(input.id||''),style:String(input.style||'GTO'),vpip:clamp(num(input.vpip,26),12,48),aggro:clamp(num(input.aggro,2.65),1.3,4.3),bluff:clamp(num(input.bluff,.13),.01,.32),patience:clamp(num(input.patience,.9),.45,1),variance:clamp(num(input.variance,.5),0,1),signature:String(input.signature||'')};
}
export function makeObservation(g,actor){
 const p=g.seats[actor];if(!p)return null;const spec=getVariant(g.settings.variant),publicDead=[],ruleSeats=[];
 const foes=g.seats.map((q,seat)=>{
  // Loop over visibility flags before reading a card. Hidden values are never
  // accessed, even in open-card practice rooms or for fantasy opponents.
  const exposed=[];for(let k=0;k<q.up.length;k++)if(q.up[k]){const c=copy(q.hole[k]);exposed.push({index:k,card:c});if(seat!==actor)publicDead.push(c);}
  const visible=Array(q.up.length).fill(null);for(const e of exposed)visible[e.index]=e.card;
  ruleSeats.push({inHand:q.inHand,folded:q.folded,stack:q.stack,bet:q.bet,lastActionHigh:q.lastActionHigh,up:q.up.slice(),hole:visible});
  return {seat,id:q.id,stack:q.stack,bet:q.bet,total:q.total,folded:!!q.folded,inHand:!!q.inHand,allIn:!!q.allIn,cardCount:q.up.length,exposed};
 }).filter(q=>q.seat!==actor);
 const events=(g.events||[]).filter(e=>['action','draw','discard'].includes(e.type)).slice(-96).map(e=>({seat:e.seat,type:e.type,street:e.street,action:e.action,amount:e.amount||0,to:e.to||0,count:e.count??null}));
 // The native Stud paired-upcard option scans its hand arrays. Give its legal
 // calculation visibility-masked arrays so even that scan cannot read a
 // concealed value; wagering and exposed-card rules remain identical.
 const ruleGame={settings:{...g.settings},seats:ruleSeats,actor:g.actor,phase:g.phase,street:g.street,streetIndex:g.streetIndex,pot:g.pot,highBet:g.highBet,minRaise:g.minRaise,fullBets:g.fullBets,roundPlayers:g.roundPlayers,studFourthBig:g.studFourthBig};
 return {variant:spec.id,actor,button:g.button,bb:g.settings.bb,sb:g.settings.sb,street:g.street,streetIndex:g.streetIndex,phase:g.phase,pot:g.pot,highBet:g.highBet,stack:p.stack,bet:p.bet,total:p.total,hole:p.hole.map(copy),board:g.board.map(copy),publicDead,foes,events,drawnAfter:(g.drawnAfter||[]).slice(),discardedAfter:(g.discardedAfter||[]).slice(),legal:legal(ruleGame,actor).map(a=>({...a,targets:a.targets?.slice()})),handNo:g.handNo,turnId:g.turnId};
}

/** Starting-hand quality on an authored 0–1 scale. It is never labelled equity. */
export function preflopQuality(cards,spec=getVariant('holdem_nl')){
 if(cards.length<2)return .25;
 const pairQuality=(a,b)=>{const h=Math.max(a.val,b.val),l=Math.min(a.val,b.val),gap=h-l,suited=a.suit===b.suit;
  if(h===l)return clamp(.56+(h-2)/12*.43,.1,.995);
  return clamp(.12+.42*(h-2)/12+.18*(l-2)/12+(suited?.055:0)+(gap===1?.06:gap===2?.025:0)+(h>=10&&l>=10?.085:0)+(h===14?.03:0),.05,.96);
 };
 const qualities=[];for(let i=0;i<cards.length-1;i++)for(let j=i+1;j<cards.length;j++)qualities.push(pairQuality(cards[i],cards[j]));
 qualities.sort((a,b)=>b-a);if(!spec.exactlyTwo)return qualities[0];
 const ranks=new Set(cards.map(c=>c.val)),suits={};for(const c of cards)suits[c.suit]=(suits[c.suit]||0)+1;
 let connected=0;const order=[...ranks].sort((a,b)=>a-b);for(let i=1;i<order.length;i++)if(order[i]-order[i-1]<=2)connected++;
 const doubles=Object.values(suits).filter(n=>n>=2).length,nutSuit=cards.some(a=>a.val===14&&cards.some(b=>a!==b&&a.suit===b.suit));
 let quality=qualities[0]*.54+qualities.slice(1,4).reduce((a,b)=>a+b,0)/Math.min(3,qualities.length-1)*.28+Math.min(.11,connected*.032)+doubles*.035+(nutSuit?.045:0)-(cards.length-ranks.size>1?.045:0);
 if(spec.split){const lows=new Set(cards.map(c=>c.val===14?1:c.val).filter(n=>n<=8));quality+=lows.has(1)&&lows.has(2)?.10:lows.has(1)&&lows.has(3)?.06:0;quality+=lows.size>=3?.03:0;}
 return clamp(quality,.1,.985);
}
function flushKeep(cards){const suits={};cards.forEach((c,i)=>(suits[c.suit]||(suits[c.suit]=[])).push(i));return Object.values(suits).sort((a,b)=>b.length-a.length)[0]||[];}
function straightKeep(cards,spec){
 if(!spec.straightAllowed)return [];let best=[];
 for(let high=spec.shortDeck?14:14;high>=5;high--){const allowed=high===5?[14,2,3,4,5]:spec.shortDeck&&high===9?[14,6,7,8,9]:Array.from({length:5},(_,i)=>high-i),used=new Set(),keep=[];
  cards.forEach((c,i)=>{if(allowed.includes(c.val)&&!used.has(c.val)){used.add(c.val);keep.push(i);}});if(keep.length>best.length)best=keep;
 }return best;
}
/** Variant-native draw intentions. A made straight/flush is never broken by
 * high draw; 2–7 straights/flushes are deliberately repaired; Badugi is exact. */
export function drawPlan(id,cards,remaining=1){
 const spec=getVariant(id),drop=keep=>cards.map((_,i)=>i).filter(i=>!keep.includes(i));
 if(id==='badugi'){
  let best=[],bestRank=null;for(let mask=1;mask<(1<<cards.length);mask++){
   const indices=cards.map((_,i)=>i).filter(i=>mask&(1<<i)),subset=indices.map(i=>cards[i]),values=subset.map(c=>c.val===14?1:c.val);
   if(new Set(values).size!==values.length||new Set(subset.map(c=>c.suit)).size!==values.length)continue;
   const rank=[values.length,...values.sort((a,b)=>b-a).map(n=>15-n)];if(compare(rank,bestRank)>0){bestRank=rank;best=indices;}
  }return drop(best);
 }
 if(spec.lowOnly){
  const low=c=>spec.lowRule==='ace-to-five'&&c.val===14?1:c.val;
  const ranked=cards.map((c,i)=>({i,v:low(c)})).sort((a,b)=>a.v-b.v),keep=[],seen=new Set();
  for(const {i,v}of ranked)if(!seen.has(v)&&v<=9){seen.add(v);keep.push(i);}
  if(keep.length===5&&spec.lowRule==='deuce-to-seven'){
   const score=evaluate(id,cards).high;if(score[0]!==8)keep.splice(keep.indexOf(ranked.at(-1).i),1);
  }
  // Drawing once can preserve a clean ten-low; earlier triple-draw rounds
  // develop smoother lows instead of treating every ace as a good low card.
  if(remaining===1&&keep.length===4){const missing=ranked.find(x=>!keep.includes(x.i));if(missing?.v===10&&!seen.has(10)){const rank=evaluate(id,cards).high;if(rank[0]===(spec.lowRule==='deuce-to-seven'?8:5))return [];}}
  return drop(keep);
 }
 const counts={};cards.forEach((c,i)=>(counts[c.val]||(counts[c.val]=[])).push(i));
 const groups=Object.values(counts).sort((a,b)=>b.length-a.length||cards[b[0]].val-cards[a[0]].val),score=fastHigh(cards,spec),category=Math.floor(score/15**5);
 if(category>=4)return [];
 if(groups[0].length>=3)return drop(groups[0]);
 if(groups.filter(a=>a.length===2).length>=2)return drop(groups.filter(a=>a.length===2).flat());
 const flush=spec.flushAllowed?flushKeep(cards):[],run=straightKeep(cards,spec),pair=groups.find(a=>a.length===2);
 if(pair&&cards[pair[0]].val>=11)return drop(pair);
 if(flush.length===4)return drop(flush);
 if(run.length===4&&!pair)return drop(run);
 if(pair)return drop(pair);
 const high=cards.map((c,i)=>({i,v:c.val})).sort((a,b)=>b.v-a.v);
 return drop(high[0]?.v>=13?[high[0].i]:[]);
}
function pineappleDiscard(o){
 const spec=getVariant(o.variant);let best=-Infinity,drop=0;
 for(let i=0;i<o.hole.length;i++){
  const kept=o.hole.filter((_,k)=>k!==i),quality=preflopQuality(kept,spec),draw=drawTexture(kept,o.board,spec);
  const score=o.board.length>=3?fastHigh(kept.concat(o.board),spec)/15**5+quality*.11+draw.draw*.35:quality;
  if(score>best){best=score;drop=i;}
 }return [drop];
}
function drawTexture(hole,board,spec){
 if(spec.lowOnly)return{draw:0,blocker:0,wet:0};
 const all=hole.concat(board),flush=flushKeep(all),ownFlush=hole.filter(c=>flush.some(i=>all[i].suit===c.suit)),hasFlushDraw=board.length<5&&flush.length===4&&ownFlush.length>=(spec.exactlyTwo?2:1);
 const ranks=new Set(all.map(c=>c.val)),boardRanks=new Set(board.map(c=>c.val)),suits={};for(const c of board)suits[c.suit]=(suits[c.suit]||0)+1;
 let connected=0;for(const r of boardRanks)if(boardRanks.has(r+1)||boardRanks.has(r+2))connected++;
 const straightDraw=board.length<5&&straightKeep(all,spec).length===4&&hole.some(c=>!boardRanks.has(c.val));
 const ownAce=hole.some(c=>c.val===14&&num(suits[c.suit])>=2),wet=clamp((Math.max(0,...Object.values(suits))-1)*.25+connected*.13+((board.length-boardRanks.size)>.0?.18:0));
 return {draw:hasFlushDraw&&straightDraw?1:hasFlushDraw?.8:straightDraw?.55:0,blocker:ownAce?1:hole.some(c=>c.val>=13)?.35:0,wet};
}
function drawCountRemaining(o,spec){return spec.drawAfter.filter(st=>spec.streets.findIndex(s=>s.id===st)>=o.streetIndex&&!o.drawnAfter.includes(st)).length;}
function position(o){const n=o.foes.filter(p=>p.inHand).length+1,seatCount=o.foes.length+1,fromButton=(o.button-o.actor+seatCount)%seatCount;return{late:fromButton<=1,early:fromButton>=seatCount-3&&seatCount>=6,headsUp:n===2,n};}
function eventLine(o,seat){const es=o.events.filter(e=>e.seat===seat),pre=es.filter(e=>['PREFLOP','PREDRAW','DEAL','THIRD','SECOND'].includes(e.street));return {raises:es.filter(e=>e.action==='raise').length,streetRaises:es.filter(e=>e.street===o.street&&e.action==='raise').length,preRaises:pre.filter(e=>e.action==='raise').length,preCalls:pre.filter(e=>e.action==='call').length,lastDraw:[...es].reverse().find(e=>e.type==='draw')?.count};}
function presentEvidence(spec,hand,board,count){
 const known=spec.family==='stud'?hand.slice(0,count):hand;
 if(spec.lowOnly&&spec.family==='stud'){
  const ranks=known.map(c=>c.val===14?1:c.val),unique=[...new Set(ranks)].sort((a,b)=>a-b),best=unique.slice(0,5),smooth=best.reduce((n,v)=>n+(15-v)/14,0)/Math.max(1,best.length);
  return clamp(unique.length/Math.max(1,ranks.length)*.5+smooth*.5,.12,1);
 }
 if(spec.lowOnly)return clamp(scoreHypothetical(spec.id,known,[]).high/15**5/(spec.lowRule==='badugi'?4:spec.lowRule==='ace-to-five'?5:8),.1,1);
 if(spec.family==='community'&&board.length<3)return clamp(preflopQuality(known,spec),.1,1);
 const high=spec.exactlyTwo?scoreHypothetical(spec.id,known,board).high:fastHigh(known.concat(board),spec);
 return clamp(.22+(high/15**5)*.19,.15,1);
}

/** Monte Carlo equity against public-action-weighted hypothetical ranges.
 * No sample ever sees cards from the authoritative deck or another private hand. */
export function estimateEquity(o,rng=seeded(1),sampleOverride){
 const spec=getVariant(o.variant),foes=o.foes.filter(p=>p.inHand&&!p.folded),known=new Set(o.hole.concat(o.board,o.publicDead||[]).map(key)),deck=createDeck(spec.id).filter(c=>!known.has(key(c))),remainingDraws=drawCountRemaining(o,spec);
 if(!foes.length)return{equity:1,samples:0,stderr:0};
 const expensive=spec.exactlyTwo,samples=Math.max(8,Math.min(96,sampleOverride??(expensive?Math.max(10,Math.floor(46/(foes.length+1))):Math.max(24,Math.floor(136/(foes.length+1))))));
 let wins=0,weights=0,sumSquare=0,validSamples=0;
 const lines=foes.map(f=>eventLine(o,f.seat));
 for(let k=0;k<samples;k++){
  const available=deck.slice();let left=available.length;const take=()=>{if(!left)return null;const i=Math.floor(rng()*left),c=available[i];available[i]=available[--left];return c;};
  let board=o.board.slice(),hero=o.hole.slice(),hands=[];let weight=1,invalid=false;
  const studShared=spec.family==='stud'&&spec.holeCount===7&&!board.length&&(foes.length+1)*7+(o.publicDead||[]).filter(c=>!foes.some(f=>f.exposed.some(e=>key(e.card)===key(c)))).length>spec.deckSize;
  for(let fi=0;fi<foes.length;fi++){
   const foe=foes[fi],count=spec.family==='stud'?spec.holeCount-board.length-(studShared?1:0):spec.discardAfter?Math.max(2,Math.min(3,foe.cardCount||2)):spec.holeCount,hand=Array(count).fill(null);
   for(const e of foe.exposed)if(e.index<count)hand[e.index]=e.card;
   for(let i=0;i<count;i++)if(!hand[i]){hand[i]=take();if(!hand[i]){invalid=true;break;}}
   if(invalid)break;
   if(spec.family==='community'){
    const q=preflopQuality(hand,spec),line=lines[fi];
    if(line.preRaises)weight*=clamp(.18+Math.max(0,q-.36)*1.8+(q>.82?.25:0),.12,1);
    else if(line.preCalls)weight*=clamp(.25+Math.max(0,q-.28)*1.4,.18,1);
   }
   hands.push(hand);
  }
  if(invalid)continue;
  let currentEvidence;
  if(spec.family==='community'){
   // Every still-three-card Pineapple opponent also chooses its retained pair
   // from its hypothetical cards and the already-visible discard street.
   if(spec.discardAfter)hands=hands.map(hand=>{if(hand.length<=2)return hand;const mask=pineappleDiscard({...o,hole:hand,board:spec.discardAfter==='PREFLOP'?[]:o.board});return hand.filter((_,i)=>!mask.includes(i));});
   currentEvidence=hands.map((h,i)=>presentEvidence(spec,h,o.board,foes[i].cardCount));
   while(board.length<5){const c=take();if(!c){invalid=true;break;}board.push(c);}
   if(hero.length>2&&spec.discardAfter){const mask=pineappleDiscard({...o,hole:hero});hero=hero.filter((_,i)=>!mask.includes(i));}
  }else if(spec.family==='stud'){
   currentEvidence=hands.map((h,i)=>presentEvidence(spec,h,o.board,foes[i].cardCount));
   if(studShared){const common=take();if(common)board.push(common);else invalid=true;}
   while(hero.length+board.length<spec.holeCount){const c=take();if(!c){invalid=true;break;}hero.push(c);}
  }else if(remainingDraws){
   currentEvidence=hands.map((h,i)=>presentEvidence(spec,h,o.board,foes[i].cardCount));
   const all=[hero,...hands],muck=[];
   for(let round=remainingDraws;round>0;round--)for(let h=0;h<all.length;h++){
    // Opponent stand-pat/draw observations narrow the sampled retained hand.
    const discard=drawPlan(spec.id,all[h],round),dropped=[];for(const i of discard){if(!left&&muck.length){available.splice(0,available.length,...muck.splice(0));left=available.length;}const c=take();if(c){dropped.push(all[h][i]);all[h][i]=c;}}muck.push(...dropped);
   }
   [hero,...hands]=all;
  }
  if(invalid)continue;
  const own=scoreHypothetical(spec.id,hero,board),others=hands.map(h=>scoreHypothetical(spec.id,h,board)),scores=[own,...others];
  if(spec.family==='draw')for(let fi=0;fi<foes.length;fi++)if(lines[fi].lastDraw===0)weight*=currentEvidence?.[fi]??presentEvidence(spec,hands[fi],o.board,foes[fi].cardCount);
  // An observed raise is conditioned on that street's sampled holdings, never
  // on cards the hypothetical player will only improve to on a future street.
  if(spec.family!=='draw')for(let fi=0;fi<foes.length;fi++)if(lines[fi].streetRaises&&o.street!=='PREFLOP')weight*=currentEvidence?.[fi]??1;
  const high=Math.max(...scores.map(x=>x.high)),low=spec.split?Math.max(...scores.map(x=>x.low)):0,highTies=scores.filter(x=>x.high===high).length,lowTies=low?scores.filter(x=>x.low===low).length:0;
  const share=(own.high===high?(low?.5:1)/highTies:0)+(low&&own.low===low?.5/lowTies:0);
  weight=Math.max(.01,weight);wins+=share*weight;sumSquare+=share*share*weight;weights+=weight;validSamples++;
 }
 const equity=weights?wins/weights:.5;
 return {equity,samples:validSamples,requestedSamples:samples,stderr:Math.sqrt(Math.max(0,weights?sumSquare/weights-equity*equity:0)/Math.max(1,validSamples))};
}

function legalize(o,action){
 const a=o.legal.find(x=>x.type===action.type);if(!a){const safe=o.legal.find(x=>x.type==='check')||o.legal.find(x=>x.type==='fold')||o.legal[0];if(!safe)return null;return {type:safe.type,...(['draw','discard'].includes(safe.type)?{indices:Array.from({length:safe.minCards||0},(_,i)=>i)}:{})};}
 if(action.type==='raise'){
  let target=Math.round(clamp(action.target,a.minTo,a.maxTo));if(a.targets?.length)target=a.targets.reduce((x,y)=>Math.abs(y-target)<Math.abs(x-target)?y:x);return{type:'raise',target};
 }
 if(['draw','discard'].includes(action.type)){const indices=[...new Set(action.indices||[])].filter(i=>Number.isInteger(i)&&i>=0&&i<o.hole.length).slice(0,a.maxCards??o.hole.length);while(indices.length<(a.minCards||0)){const i=o.hole.findIndex((_,k)=>!indices.includes(k));if(i<0)break;indices.push(i);}return{type:action.type,indices:indices.sort((a,b)=>a-b)};}
 return {type:action.type};
}
function raiseSize(o,p,rng,quality,pre,bluff=false){
 const a=o.legal.find(x=>x.type==='raise');if(!a)return 0;const spec=getVariant(o.variant),call=o.legal.find(x=>x.type==='call')?.amount||0,live=o.foes.filter(f=>f.inHand&&!f.folded),effective=Math.min(o.bet+o.stack,Math.max(...live.map(f=>f.bet+f.stack),o.highBet)),high=o.highBet,ag=(p.aggro-2.6)*.12;
 let target;
 if(pre){
  const raised=high>o.bb,limpers=o.events.filter(e=>e.street===o.street&&e.action==='call').length;
  target=raised?high*(position(o).late?2.8:3.35)+Math.min(3,limpers)*high*.8:o.bb*(2.2+Math.min(4,limpers)*.85+ag+(p.style==='POWER'?.4:0));
  const depth=Math.min(o.stack,Math.max(0,effective-o.bet))/o.bb;
  if(depth<=12&&quality>.62||raised&&depth<=22&&quality>.88)target=effective;
 }else{
  let frac=quality>.82?.78:quality>.60?.62:.43;frac+=ag+(rng()-.5)*(.18+p.variance*.13);
  if(p.id==='danielnegreanu')frac*=.72;if(p.style==='POWER'||p.style==='CANNON')frac*=1.15;
  if(bluff)frac=Math.max(.43,frac);if(quality>.92&&rng()<.25)frac=1.02;
  frac=clamp(frac,.25,1.2);target=high+Math.round((o.pot+call)*frac);
  if(quality>.82&&effective-target<=Math.max(o.bb,(o.pot+call)*.24))target=effective;
 }
 if(spec.betting==='fixed-limit')target=quality>.73||p.aggro>3.4?a.maxTo:a.minTo;
 return Math.max(a.minTo,Math.min(a.maxTo,effective,Math.round(target)));
}
function preflopDecision(o,p,rng){
 const spec=getVariant(o.variant),doorMatches=o.board.length===1?o.hole.filter(c=>c.val===o.board[0].val).length:0,quality=clamp(preflopQuality(o.hole,spec)+(doorMatches>=2?.16:doorMatches===1?.025:0),0,.995),pos=position(o),call=o.legal.find(x=>x.type==='call')?.amount||0,raise=o.legal.find(x=>x.type==='raise'),check=o.legal.some(x=>x.type==='check'),facing=o.highBet>o.bb,raises=o.events.filter(e=>e.street===o.street&&e.action==='raise').length;
 const ag=(p.aggro-2.5)*.055,cut=clamp(.795-p.vpip*.0048+(pos.early?.045:0)-(pos.late?.055:0)-(pos.headsUp?.12:0),.38,.79),price=call/Math.max(1,o.pot+call),depth=o.stack/o.bb;
 let action=check?'check':'fold',reason='preflop discipline',bluff=false;
 if(!facing){
  if(quality>=cut&&raise){action=rng()<clamp(.84+ag-(p.signature==='traps'?.1:0),.55,.98)?'raise':check?'check':'call';reason='position-aware opening range';}
  else if(!check&&quality>cut-.045&&call<=o.bb&&(pos.late||price<.20)&&rng()<.32+ag){action='call';reason='small-price speculative continuation';}
  else if(raise&&pos.late&&quality>cut-.11&&rng()<p.bluff*.42){action='raise';reason='late-position mixed opening';bluff=true;}
 }else{
  const pressure=Math.min(.17,Math.log2(Math.max(1,o.highBet/o.bb))*.035)+Math.max(0,raises-1)*.04,callCut=Math.max(cut+.015+pressure-(price<.18?.09:0),o.highBet>25*o.bb?.82:0),valueCut=Math.max(.82+Math.max(0,raises-1)*.045-(pos.headsUp?.05:0),callCut+.055);
  const suited=o.hole.length===2&&o.hole[0].suit===o.hole[1].suit,ace=o.hole.some(c=>c.val===14);
  if(raise&&quality>=valueCut&&rng()<clamp(.78+ag-(p.signature==='traps'?.13:0),.5,.96)){action='raise';reason='value re-raise';}
  else if(raise&&raises<=1&&o.highBet<=6*o.bb&&depth>=35&&quality>cut-.025&&suited&&ace&&rng()<p.bluff*.45){action='raise';reason='blocker-based mixed re-raise';bluff=true;}
  else if(!check&&quality>=callCut){action='call';reason='range and price support a call';}
  else if(!check&&depth<=10&&quality>=cut+.055&&price<.40){action='call';reason='short-stack price';}
 }
 return {action:legalize(o,action==='raise'?{type:'raise',target:raiseSize(o,p,rng,quality,true,bluff)}:{type:action}),diagnostics:{model:'bounded-personality-policy',reason,quality,position:pos,information:'own-and-public'}};
}

export function decide(o,input={},rng=seeded(1)){
 if(!o?.legal?.length)return {action:null,diagnostics:{reason:'no decision'}};
 const p=normalizeProfile(input),spec=getVariant(o.variant),choice=o.legal.find(a=>a.type==='draw'||a.type==='discard');
 if(choice){const indices=choice.type==='discard'?pineappleDiscard(o):drawPlan(spec.id,o.hole,Math.max(1,(o.phase==='draw'?1:0)+drawCountRemaining(o,spec)));return{action:legalize(o,{type:choice.type,indices}),diagnostics:{reason:choice.type==='discard'?'best retained Pineapple pair':'variant-native draw plan',information:'own-and-public',samples:0}};}
 if(spec.family==='community'&&o.street==='PREFLOP'&&o.board.length<3)return preflopDecision(o,p,rng);
 const stats=estimateEquity(o,rng),eq=stats.equity,call=o.legal.find(a=>a.type==='call')?.amount||0,check=o.legal.some(a=>a.type==='check'),raise=o.legal.find(a=>a.type==='raise'),foes=o.foes.filter(f=>f.inHand&&!f.folded),count=foes.length,base=1/(count+1),price=call/Math.max(1,o.pot+call),spr=o.stack/Math.max(o.bb,o.pot),future=o.streetIndex<spec.streets.length-1,texture=drawTexture(o.hole,o.board,spec),raises=o.events.filter(e=>e.street===o.street&&e.action==='raise').length,ag=(p.aggro-2.5)*.14;
 const realization=future?Math.min(.055,.017+Math.max(0,count-1)*.011+(spr>5?.012:0)):0,need=price+realization-(future&&texture.draw>.6&&call<o.pot*.40?.025:0),strong=eq>Math.max(.54,base+.15),monster=eq>Math.max(.79,base+.37),trap=(p.signature==='traps'?.31:p.patience>.92?.14:.06)+(p.signature==='reads'?.07:0);
 let action=check?'check':'fold',reason='price discipline',bluff=false;
 if(check){
  if(monster&&raise&&rng()<clamp(.90+ag-trap*(future?1:.2),.4,.98)){action='raise';reason='strong value with occasional traps';}
  else if(strong&&raise&&rng()<clamp(.64+ag-(texture.wet<.25?trap*.35:0),.32,.94)){action='raise';reason='value and protection';}
  else if(eq>base+.065&&raise&&rng()<clamp(.25+ag,.1,.52)){action='raise';reason='thin value';}
  else if(raise&&eq<Math.max(.30,base-.05)&&count<=3&&spr>.6&&rng()<p.bluff*Math.pow(.57,count-1)*(texture.draw?1.30:texture.blocker?.95:.58)){
   action='raise';reason=texture.draw?'live-draw semi-bluff':'mixed public-line bluff';bluff=true;
  }
 }else{
  const clearCall=eq>=need+.025,close=Math.abs(eq-need)<=.025;
  if(monster&&raise&&rng()<clamp(.78+ag-trap*(future?1:.3),.36,.97)){action='raise';reason='value re-raise';}
  else if(clearCall||close&&rng()<clamp(.46+(eq-need)*9+(p.variance-.5)*.13,.05,.94)){
   action='call';reason=monster?'patient trap':future&&texture.draw?'draw clears the price':'pot odds and public range';
   if(raise&&strong&&eq>need+.19&&raises<2&&rng()<clamp(.15+ag,.04,.35)){action='raise';reason='strong range pressure';}
  }else if(raise&&future&&texture.draw>.5&&eq>need-.035&&raises<2&&count<=2&&call<o.pot*.7&&rng()<p.bluff*.65){action='raise';reason='live-draw semi-bluff';bluff=true;}
 }
 // A sampled zero-equity hand never pays a bet or puts a deep stack in as a
 // speculative raise. Sparse samples may understate equity, so checks remain.
 if(eq<.025&&!check){action='fold';reason='no sampled continuation';}
 const out=action==='raise'?{type:action,target:raiseSize(o,p,rng,eq,false,bluff)}:{type:action};
 return {action:legalize(o,out),diagnostics:{model:'bounded-personality-policy',information:'own-and-public',reason,equity:eq,potOdds:price,samples:stats.samples,stderr:stats.stderr,foes:count}};
}

export function chooseBotAction(g,actor,profile,seed=1){return decide(makeObservation(g,actor),profile,seeded(seed)).action;}
