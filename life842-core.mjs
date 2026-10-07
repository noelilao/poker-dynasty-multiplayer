/* Poker Dynasty V84.2 Life economy. Same reducer in solo play and on the server.
 * All prices, lease rules and fitness changes are FICTIONAL gameplay policies.
 * No client-supplied balance, price, title, deposit refund, or fitness gain is accepted.
 * Caller commits the entire world by revision CAS; exceptions discard the working copy.
 */
const Life842=(()=>{'use strict';
const VERSION='84.2.0',DAY=1440,MAX=1e14;
const cp=x=>x==null?null:JSON.parse(JSON.stringify(x));
const ok=(v,m)=>{if(!v){const e=Error(m);e.code='life_rule';e.status=409;throw e;}};
const integer=(n,a,b,label='Value')=>{ok(typeof n==='number'&&Number.isSafeInteger(n)&&n>=a&&n<=b,`${label} must be an integer from ${a} to ${b}.`);return n;};
const cash=n=>{ok(typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=MAX/100&&Math.abs(n*100-Math.round(n*100))<.0001,'Use non-negative money with at most two decimal places.');return Math.round(n*100);};
const clean=(s,max=64)=>String(s||'').normalize('NFKC').replace(/[<>\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,'').trim().slice(0,max);
const hash=s=>{let h=2166136261;for(const c of String(s))h=Math.imul(h^c.charCodeAt(0),16777619);return h>>>0;};
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n)),year=w=>new Date(w.clock.minute*60000).getUTCFullYear();
const INDEX=[32.0,32.0,32.0,30.0,29.0,30.0,31.0,33.0,34.0,32.0,32.0,30.0,31.0,29.0,28.0,28.0,28.0,27.0,28.0,26.0,25.0,25.0,25.0,25.0,25.0,27.0,28.0,27.0,28.0,26.0,27.0,27.0,27.0,30.0,37.0,47.0,46.0,44.0,42.0,40.0,40.0,38.0,36.0,36.0,36.0,34.0,33.0,32.0,32.0,29.0,28.0,29.0,29.0,29.0,28.0,27.0,27.0,27.0,27.0,27.0,27.0,27.0,27.0,27.0,27.0,26.0,25.0,25.0,25.0,25.0,25.0,25.0,25.0,26.0,27.0,27.0,27.0,27.0,28.0,27.0,27.0,28.0,28.0,29.0,29.7,30.1,30.4,32.7,38.5,45.2,52.1,60.2,53.6,50.3,51.2,51.5,52.7,53.2,52.2,51.6,51.6,50.2,45.7,41.0,38.9,40.2,41.2,41.7,43.2,42.3,41.8,42.1,44.2,49.1,52.0,52.9,54.1,58.6,67.1,72.2,71.5,72.3,78.0,79.8,80.4,80.7,80.5,81.7,84.4,86.7,87.6,88.9,89.8,90.9,92.0,93.2,94.7,97.5,100.2,104.5,110.2,116.7,121.7,125.7,133.4,148.2,161.7,171.0,182.1,196.0,218.1,247.6,273.2,290.0,299.3,312.2,323.2,329.4,341.4,355.4,372.5,392.6,409.3,421.7,434.1,445.4,457.9,471.3,482.4,489.8,500.6,517.5,532.1,540.5,552.8,567.6,586.9,605.8,623.1,647.0,644.7,655.3,676.0,689.9,700.0,711.4,712.3,721.2,736.6,754.6,768.3,777.7,814.3,879.4,915.6,942.7,967.5,1004.8];
function price(base,w,city){const y=year(w),idx=y>2026?INDEX.at(-1)*Math.pow(1.025,Math.min(374,y-2026)):INDEX[clamp(y-1829,0,INDEX.length-1)],cost=city?.lifeCost||1;return Math.max(1,Math.min(MAX,Math.round(base*100*idx/INDEX.at(-1)*cost)));}
function addMonths(anchor,n){const d=new Date(anchor*60000),total=d.getUTCFullYear()*12+d.getUTCMonth()+n,y=Math.floor(total/12),m=((total%12)+12)%12,last=new Date(Date.UTC(y,m+1,0)).getUTCDate();ok(y<=9998,'This contract would extend past the supported chronology.');return Math.floor(Date.UTC(y,m,Math.min(d.getUTCDate(),last),d.getUTCHours(),d.getUTCMinutes())/60000);}
const date=m=>new Date(m*60000).toISOString().slice(0,10);
const TYPES=[
 {id:'lodging',name:'Boarding-house room',base:6500,rent:90,units:3,rooms:['Bedroom','Living'],from:1829},
 {id:'cottage',name:'Small home',base:18000,rent:210,units:1,rooms:['Living','Kitchen','Bedroom','Bathroom'],from:1829},
 {id:'rowhouse',name:'Town house',base:48000,rent:500,units:1,rooms:['Living','Kitchen','Bedroom','Bathroom','Study'],from:1829},
 {id:'apartments',name:'Four-unit residential building',base:155000,rent:430,units:4,rooms:['Living','Kitchen','Bedroom','Bathroom'],from:1850},
 {id:'villa',name:'Garden residence',base:290000,rent:2400,units:1,rooms:['Living','Kitchen','Bedroom','Bathroom','Study','Gym','Storage'],from:1829},
 {id:'penthouse',name:'Skyline residence',base:450000,rent:3300,units:1,rooms:['Living','Kitchen','Bedroom','Bathroom','Study','Gym','Storage'],from:1965}
];
function seed(w){if(!w.life842)w.life842={schema:1,revision:0,seq:0,properties:{},offers:{},leases:{},furniture:{},people:{},journal:[],games:{},lastMinute:w.clock.minute};ok(w.life842.schema===1,'Unsupported life-economy save. Keep the backup.');return w.life842;}
function actor(w,id){const p=w.players.find(x=>x.playerUuid===id);ok(p&&p.status!=='removed','Player not found in this world.');return p;}
function person(w,id){const s=seed(w);return s.people[id]||(s.people[id]={home:null,food:0,safeCents:0,clothes:[],books:[],studyMinutes:0,lastMeal:null,lastUse:{},membership:null,dayPass:null,fitness:{strength:20,cardio:20,boxing:0,mobility:25,fatigue:0,muscle:20,bodyFat:25,stamina:50,wellness:50,agingReserve:0,sessions:0,minutes:0,lastWorkout:null,lastDay:Math.floor(w.clock.minute/DAY),history:[],pending:null},effects:{rest:0,workouts:0,meals:0}});}
function id(w,prefix){const s=seed(w);return prefix+'_'+(++s.seq);}
function log(w,kind,message,people=[],delta=0){const s=seed(w);s.journal.push({id:id(w,'entry'),at:w.clock.minute,kind,message:clean(message,240),people:[...new Set(people.filter(Boolean))],deltaCents:delta});s.journal=s.journal.slice(-600);}
function bump(w){seed(w).revision++;}
function city(w,id,ctx){const c=Object.hasOwn(ctx.cities,id)?ctx.cities[id]:null;ok(c&&(!c.start||Date.parse(c.start+'T00:00:00Z')<=w.clock.minute*60000),'That city is not available in this era.');return c;}
function listing(w,c,t){const names=ctxName(c,t),key=c.id+'~'+t.id;return{id:key,city:c.id,type:t.id,name:names,owner:'npc',version:0,basisCents:0,condition:100,renovations:0,units:t.units,rooms:cp(t.rooms),boughtAt:null,mortgage:null,work:null,upkeepDue:null,upkeepArrears:0,leaseIds:[],sale:null};}
function ctxName(c,t){const n={JP:{cottage:'Machiya starter home',rowhouse:'Courtyard town house'},PH:{cottage:'Raised timber home',rowhouse:'Timber-and-masonry home'},SG:{rowhouse:'Residential shophouse'},GB:{rowhouse:'Terraced house'},NL:{rowhouse:'Canal-style town house'},BR:{rowhouse:'Sobrado town house'}};return(n[c.country]?.[t.id]||t.name)+' · '+c.name;}
function catalogue(w,cityId,ctx){const c=city(w,cityId,ctx);return TYPES.filter(t=>year(w)>=t.from).map(t=>seed(w).properties[c.id+'~'+t.id]||listing(w,c,t));}
function property(w,key,ctx,write=true){const s=seed(w);if(Object.hasOwn(s.properties,key))return s.properties[key];ok(typeof key==='string'&&key.includes('~'),'Unknown property.');const i=key.lastIndexOf('~'),c=city(w,key.slice(0,i),ctx),t=TYPES.find(x=>x.id===key.slice(i+1));ok(t&&year(w)>=t.from,'That residence is unavailable in this era.');const r=listing(w,c,t);if(write)s.properties[key]=r;return r;}
function spec(r){return TYPES.find(t=>t.id===r.type)||{base:Math.max(1000,r.importBasis/100||20000),rent:200,units:r.units,rooms:r.rooms,from:1829};}
function appraisal(w,r,ctx){if(r.importBasis)return Math.round(r.importBasis*(.7+.3*r.condition/100)*(1+r.renovations*.10));return Math.round(price(spec(r).base,w,city(w,r.city,ctx))*(.7+.3*r.condition/100)*(1+r.renovations*.10));}
function postedRent(w,r,ctx){return Math.max(1,Math.round(price(spec(r).rent,w,city(w,r.city,ctx))*(.7+.3*r.condition/100)*(1+r.renovations*.08)));}
function currentLease(w,r,u){return Object.values(seed(w).leases).find(l=>l.propertyId===r.id&&l.unit===u&&l.kind==='lease'&&['active','notice'].includes(l.status));}
function access(w,p,r,u){if(r.owner===p.playerUuid)return !currentLease(w,r,u)||currentLease(w,r,u).tenant===p.playerUuid;return Object.values(seed(w).leases).some(l=>l.propertyId===r.id&&l.unit===u&&['active','notice'].includes(l.status)&&l.tenant===p.playerUuid);}
function atCity(w,p,r){ok(p.location?.city===r.city,'Travel to this property’s city first.');}
function own(w,p,r){ok(r.owner===p.playerUuid,'Only this property’s owner can do that.');}
function unit(r,n){return integer(n,1,r.units,'Unit');}
function wallet(w,p,delta,reason,ref,ctx){if(p==='npc'||p==null)return;const a=typeof p==='string'?actor(w,p):p;ok(Number.isSafeInteger(delta)&&Math.abs(delta)<=MAX,'Invalid money change.');if(delta<0){ok(a.wallet.balanceCents>=-delta,'Not enough confirmed bankroll.');ctx.debit(w,a,-delta/100,reason,ref,ctx.now);}else if(delta>0)ctx.credit(w,a,delta/100,reason,ref,ctx.now);}
function funded(w,id,amount){return id==='npc'||actor(w,id).wallet.balanceCents>=amount;}
function transfer(w,from,to,n,reason,ref,ctx){ok(Number.isSafeInteger(n)&&n>=0&&n<=MAX,'Invalid payment.');wallet(w,from,-n,reason,ref+':out',ctx);wallet(w,to,n,reason,ref+':in',ctx);}
function entity(r,version){if(version!=null)ok(r.version===version,'This property changed. Refresh and review the new terms.');}
function freePlayer(w,p){ok(!w.clock.paused,'The shared world is paused.');ok(!p.availability,'Finish your current sleep, travel or activity first.');ok(!p.blocker?.active,'Leave the active poker table before doing this.');ok(!Object.values(w.tournaments||{}).some(t=>['running','break','day_break'].includes(t.status)&&t.participants?.[p.playerUuid]?.status==='active'),'This player is still in a shared tournament.');ok(!Object.values(seed(w).games).some(g=>g.status!=='closed'&&g.members?.[p.playerUuid]?.seated),'Cash out of the home poker game first.');}
function endLease(w,l,ctx,reason){
 if(!['active','notice'].includes(l.status))return;
 for(const sub of Object.values(seed(w).leases).filter(x=>x.parentId===l.id&&['active','notice'].includes(x.status)))endLease(w,sub,ctx,'Primary lease ended');
 const r=property(w,l.propertyId,ctx),claim=Math.min(l.depositCents,l.arrearsCents);
 wallet(w,l.landlord,claim,'lease-deposit-arrears',l.id+':deposit-claim',ctx);wallet(w,l.tenant,l.depositCents-claim,'lease-deposit-refund',l.id+':deposit-refund',ctx);
 l.depositCents=0;l.arrearsCents-=claim;l.status='ended';l.endedAt=w.clock.minute;l.endReason=reason;r.version++;
 const pp=person(w,l.tenant);if(pp.home?.leaseId===l.id)pp.home=null;
 for(const f of Object.values(seed(w).furniture))if(f.owner===l.tenant&&f.place?.propertyId===r.id&&f.place.unit===l.unit){f.place=null;f.status='stored';}
 log(w,'lease-end',reason+' · '+r.name,[l.landlord,l.tenant]);
}
function leaseTerms(w,r,a){const rent=cash(a.rent),deposit=cash(a.deposit??a.rent),months=integer(a.months??12,1,120,'Lease months');
 ok(rent>0,'Rent must be positive.');ok(deposit<=rent*3,'Deposits are limited to three months of signed rent.');return{rentCents:rent,depositCents:deposit,months,allowSublet:a.allowSublet===true,roommates:integer(a.roommates??1,0,3,'Roommate limit')};}
function proposal(w,p,a,ctx){
 const r=property(w,a.propertyId,ctx);entity(r,a.propertyVersion);const u=unit(r,a.unit??1);let kind=a.kind||'lease',landlord=r.owner,tenant=a.targetPlayerUuid,other;
 ok(['lease','renewal','roommate','sublease','sale'].includes(kind),'Unknown contract kind.');
 if(kind==='sale'){own(w,p,r);other=actor(w,a.targetPlayerUuid);ok(other.playerUuid!==p.playerUuid,'Choose another buyer.');}
 else if(kind==='renewal'){
  const l=seed(w).leases[a.leaseId];ok(l&&l.propertyId===r.id&&l.unit===u&&['active','notice'].includes(l.status)&&l.kind==='lease','Choose an active primary lease.');ok([l.landlord,l.tenant].includes(p.playerUuid),'Only the parties can propose renewal.');landlord=l.landlord;tenant=l.tenant;other=actor(w,p.playerUuid===landlord?tenant:landlord);
 }else if(['roommate','sublease'].includes(kind)){
  const l=seed(w).leases[a.leaseId];ok(l&&l.tenant===p.playerUuid&&l.propertyId===r.id&&l.unit===u&&l.kind==='lease'&&l.status==='active','Only the primary tenant can invite a roommate or sublet.');
  ok(kind==='roommate'?l.roommates>0:l.allowSublet,'The signed primary lease does not allow this arrangement.');
  ok(Object.values(seed(w).leases).filter(x=>x.parentId===l.id&&['active','notice'].includes(x.status)).length<(kind==='sublease'?1:l.roommates),'This lease has reached its permitted occupants.');
  landlord=p.playerUuid;other=actor(w,a.targetPlayerUuid);tenant=other.playerUuid;ok(tenant!==landlord&&tenant!==r.owner,'Choose another eligible occupant.');
 }else{ok(r.owner!=='npc','Use the posted NPC rental terms.');if(r.owner===p.playerUuid){other=actor(w,a.targetPlayerUuid);ok(other.playerUuid!==p.playerUuid,'Choose another tenant.');tenant=other.playerUuid;}else{tenant=p.playerUuid;other=actor(w,r.owner);}ok(!currentLease(w,r,u),'This unit already has a primary tenant.');}
 ok(other.status==='active'&&!(other.blocked||[]).includes(p.playerUuid)&&!(p.blocked||[]).includes(other.playerUuid),'That player cannot receive this contract.');
 const terms=kind==='sale'?{priceCents:cash(a.price)}:leaseTerms(w,r,a);if(kind==='sale')ok(terms.priceCents>0,'Sale price must be positive.');
 const o={id:id(w,'offer'),kind,propertyId:r.id,unit:u,propertyVersion:r.version,leaseId:a.leaseId||null,proposer:p.playerUuid,recipient:other.playerUuid,landlord,tenant,terms,at:w.clock.minute,expires:w.clock.minute+7*DAY,status:'pending'};
 seed(w).offers[o.id]=o;log(w,'offer',kind+' proposal for '+r.name,[p.playerUuid,other.playerUuid]);return o;
}
function accept(w,p,o,ctx){
 ok(o&&o.status==='pending'&&o.expires>w.clock.minute,'That offer expired or is no longer pending.');ok(o.recipient===p.playerUuid,'Only the invited player can accept.');const r=property(w,o.propertyId,ctx);entity(r,o.propertyVersion);const t=o.terms;
 if(o.kind==='sale'){
  const seller=o.seller||o.proposer,buyer=o.proposer===seller?o.recipient:o.proposer;ok(r.owner===seller,'The seller no longer owns this property.');ok(!r.work,'Finish renovation before transferring title.');ok(!Object.values(seed(w).games).some(g=>g.propertyId===r.id&&g.status!=='closed'),'Close the home poker game before transferring title.');const debt=r.mortgage?mortgageDebt(r.mortgage)+r.upkeepArrears:r.upkeepArrears;ok(t.priceCents>=debt,'Sale proceeds do not cover the remaining mortgage.');wallet(w,buyer,-t.priceCents,'property-purchase',o.id+':buyer',ctx);wallet(w,r.owner,t.priceCents-debt,'property-sale',o.id+':seller',ctx);
  const old=r.owner;r.owner=buyer;r.basisCents=t.priceCents;r.boughtAt=w.clock.minute;r.mortgage=null;r.upkeepArrears=0;r.version++;r.sale=null;
  for(const l of Object.values(seed(w).leases))if(l.propertyId===r.id&&l.kind==='lease'&&l.landlord===old&&['active','notice'].includes(l.status))l.landlord=buyer;
  for(const f of Object.values(seed(w).furniture))if(f.owner===old&&f.place?.propertyId===r.id){f.place=null;f.status='stored';}
  const prior=person(w,old);if(prior.home?.propertyId===r.id&&!prior.home.leaseId)prior.home=null;log(w,'sale','Property transferred; occupied leases and escrow continue unchanged.',[old,buyer],t.priceCents);
 }else if(o.kind==='renewal'){
  const l=seed(w).leases[o.leaseId];ok(l&&l.status==='active'&&l.kind==='lease'&&l.end>w.clock.minute,'This lease cannot be renewed.');ok(l.landlord===o.landlord&&l.tenant===o.tenant,'Lease parties changed.');ok(l.arrearsCents===0,'Cure rent arrears before renewing.');
  const end=addMonths(l.end,t.months);l.renewal={...t,start:l.end,end};r.version++;log(w,'renewal','Renewal signed; existing rent remains fixed until '+date(l.end),[l.landlord,l.tenant]);
 }else{
  if(o.kind==='lease')ok(!currentLease(w,r,o.unit)&&r.owner===o.landlord,'This unit is no longer available.');
  let parent=null;if(o.leaseId){parent=seed(w).leases[o.leaseId];ok(parent&&parent.status==='active'&&parent.tenant===o.landlord,'The parent lease is no longer active.');ok(o.kind==='roommate'?parent.roommates>0:parent.allowSublet,'The parent lease does not permit this arrangement.');const active=Object.values(seed(w).leases).filter(l=>l.parentId===parent.id&&['active','notice'].includes(l.status));ok(active.length<(o.kind==='sublease'?1:parent.roommates),'Occupancy is full.');ok(t.rentCents<=parent.rentCents,'The share cannot exceed the primary signed rent.');}
  const start=w.clock.minute,end=Math.min(addMonths(start,t.months),parent?.end??Infinity);ok(end>start,'The contract must have a future end.');
  ok(funded(w,o.tenant,t.rentCents+t.depositCents),'The tenant needs the first rent and deposit.');transfer(w,o.tenant,o.landlord,t.rentCents,'lease-rent',o.id+':first',ctx);wallet(w,o.tenant,-t.depositCents,'lease-deposit-escrow',o.id+':deposit',ctx);
  const l={id:id(w,'lease'),kind:o.kind,propertyId:r.id,unit:o.unit,landlord:o.landlord,tenant:o.tenant,parentId:parent?.id||null,status:'active',start,end,anchor:start,dueIndex:1,nextDue:addMonths(start,1),rentCents:t.rentCents,depositCents:t.depositCents,months:t.months,allowSublet:t.allowSublet,roommates:t.roommates,arrearsCents:0,missed:[],paidCents:t.rentCents,noticeAt:null,renewal:null};
  seed(w).leases[l.id]=l;r.leaseIds.push(l.id);r.version++;const landlordHome=person(w,o.landlord).home;if(o.kind==='lease'&&landlordHome?.propertyId===r.id&&landlordHome.unit===o.unit&&!landlordHome.leaseId)person(w,o.landlord).home=null;person(w,o.tenant).home={propertyId:r.id,unit:o.unit,leaseId:l.id};log(w,'lease','Lease signed; deposit is held in escrow, not paid to the landlord.',[o.landlord,o.tenant],t.rentCents);
 }
 o.status='accepted';o.acceptedAt=w.clock.minute;
}
function mortgageDebt(m){return m.principalCents+m.interestArrears;}
function mortgagePayment(principal,months,annualBps=600){const rate=annualBps/120000;return Math.ceil(principal*rate/(1-Math.pow(1+rate,-months)));}
function payMortgage(w,p,r,amount,ctx,ref){
 const m=r.mortgage;ok(m,'No mortgage remains.');ok(amount>0,'Choose a positive mortgage payment.');const n=Math.min(amount,mortgageDebt(m));wallet(w,p,-n,'mortgage-payment',ref,ctx);const interest=Math.min(n,m.interestArrears);m.interestArrears-=interest;m.principalCents-=n-interest;m.paidCents+=n;m.overdueCents=Math.max(0,m.overdueCents-n);if(!m.overdueCents){m.firstMissed=null;m.noticeAt=null;}
 if(!mortgageDebt(m)){r.mortgage=null;log(w,'mortgage','Mortgage paid off.',[p.playerUuid]);}return n;
}
function settleLease(w,l,ctx){
 let changed=false;const end=Math.min(l.end,l.terminateAt??Infinity);
 while(l.nextDue<=w.clock.minute&&l.nextDue<end){
  const n=l.rentCents,ref=l.id+':rent:'+l.dueIndex;
  if(funded(w,l.tenant,n)){transfer(w,l.tenant,l.landlord,n,'monthly-rent',ref,ctx);l.paidCents+=n;log(w,'rent','Monthly rent paid for '+l.propertyId,[l.tenant,l.landlord],n);}
  else{l.arrearsCents+=n;l.missed.push({at:l.nextDue,amountCents:n});l.missed=l.missed.slice(-120);log(w,'arrears','Rent missed; the lease and tenancy are retained.',[l.tenant,l.landlord],n);}
  l.dueIndex++;l.nextDue=addMonths(l.anchor,l.dueIndex);changed=true;
 }
 if(end<=w.clock.minute){
  if(l.renewal&&!l.terminateAt&&l.arrearsCents===0){
   const t=l.renewal,diff=t.depositCents-l.depositCents;
   if(diff<=0||funded(w,l.tenant,diff)){
    wallet(w,l.tenant,-diff,'lease-renewal-deposit',l.id+':renew:'+l.end,ctx);l.depositCents=t.depositCents;l.rentCents=t.rentCents;l.start=t.start;l.end=t.end;l.anchor=t.start;l.dueIndex=0;l.nextDue=t.start;l.allowSublet=t.allowSublet;l.roommates=t.roommates;l.renewal=null;changed=true;
    // First rent of the renewed term is billed by the same anchored schedule.
    return settleLease(w,l,ctx)||changed;
   }
  }
  endLease(w,l,ctx,l.terminateAt?'Tenant notice completed':'Lease term ended');return true;
 }
 return changed;
}
function settleProperty(w,r,ctx){
 let changed=false;if(r.work&&r.work.until<=w.clock.minute){r.condition=100;r.renovations=Math.min(3,r.renovations+1);r.work=null;r.version++;log(w,'renovation','Renovation completed: '+r.name,[r.owner]);changed=true;}
 if(r.owner!=='npc'&&r.upkeepDue!=null){
  let guard=0;while(r.upkeepDue<=w.clock.minute&&guard++<1200){
   const n=Math.max(1,Math.round(appraisal(w,r,ctx)*.00035));if(funded(w,r.owner,n))wallet(w,r.owner,-n,'property-upkeep',r.id+':upkeep:'+r.upkeepDue,ctx);else{r.upkeepArrears+=n;r.condition=Math.max(30,r.condition-2);}
   r.upkeepIndex=(r.upkeepIndex||1)+1;r.upkeepDue=addMonths(r.upkeepAnchor,r.upkeepIndex);changed=true;
  }
 }
 let m=r.mortgage;
 if(m){let guard=0;while(r.mortgage&&m.nextDue<=w.clock.minute&&guard++<600){
  const due=m.nextDue,interest=Math.ceil(m.principalCents*m.annualBps/120000);m.interestArrears+=interest;
  const amount=Math.min(mortgageDebt(m),m.dueIndex>=m.months?mortgageDebt(m):m.paymentCents);
  if(funded(w,r.owner,amount))payMortgage(w,actor(w,r.owner),r,amount,ctx,r.id+':mortgage:'+m.dueIndex);else{m.overdueCents=Math.min(mortgageDebt(m),m.overdueCents+amount);m.firstMissed=m.firstMissed??due;log(w,'mortgage-arrears','Mortgage payment missed; lender notice precedes repossession.',[r.owner],amount);}
  m.dueIndex++;m.nextDue=addMonths(m.anchor,m.dueIndex);changed=true;
 }
 m=r.mortgage;if(m&&m.firstMissed!=null&&w.clock.minute>=m.firstMissed+90*DAY&&!m.noticeAt){m.noticeAt=m.firstMissed+90*DAY;log(w,'lender-notice','Lender notice: cure overdue installments within 30 game days.',[r.owner]);changed=true;}
 if(m?.noticeAt!=null&&w.clock.minute>=m.noticeAt+30*DAY&&m.overdueCents>0){
  const former=r.owner,proceeds=Math.round(appraisal(w,r,ctx)*.8),equity=Math.max(0,proceeds-mortgageDebt(m));wallet(w,former,equity,'foreclosure-equity',r.id+':foreclosure:'+m.anchor,ctx);r.owner='npc';r.mortgage=null;r.version++;
  for(const l of Object.values(seed(w).leases))if(l.propertyId===r.id&&l.landlord===former&&l.kind==='lease'&&['active','notice'].includes(l.status))l.landlord='npc';
  if(person(w,former).home?.propertyId===r.id&&!person(w,former).home.leaseId)person(w,former).home=null;
  for(const f of Object.values(seed(w).furniture))if(f.owner===former&&f.place?.propertyId===r.id){f.place=null;f.status='stored';}r.upkeepArrears=0;log(w,'repossession','Lender repossessed '+r.name+'. Tenant leases remain protected; remaining modeled lender shortfall is written off.',[former],equity);changed=true;
 }}
 return changed;
}

const FURNITURE=[
 {id:'bed',name:'Bed',from:1829,base:240,w:3,h:2,rooms:['Bedroom'],use:'sleep'},
 {id:'sofa',name:'Settee',from:1829,base:180,w:3,h:1,rooms:['Living','Study'],use:'rest'},
 {id:'icebox',name:'Icebox',from:1850,base:180,w:1,h:1,rooms:['Kitchen'],use:'food'},
 {id:'fridge',name:'Refrigerator',from:1955,base:420,w:1,h:2,rooms:['Kitchen'],use:'food'},
 {id:'hearth',name:'Cooking hearth',from:1829,base:130,w:2,h:1,rooms:['Kitchen'],use:'cook'},
 {id:'stove',name:'Kitchen range',from:1930,base:280,w:2,h:1,rooms:['Kitchen'],use:'cook'},
 {id:'desk',name:'Writing desk',from:1829,base:150,w:2,h:1,rooms:['Study','Living','Bedroom'],use:'study'},
 {id:'radio',name:'Radio cabinet',from:1930,base:100,w:1,h:1,rooms:['Living','Bedroom','Study'],use:'media'},
 {id:'tv',name:'Television',from:1960,base:340,w:2,h:1,rooms:['Living','Bedroom'],use:'media'},
 {id:'computer',name:'Desktop computer',from:1995,base:950,w:2,h:1,rooms:['Study','Living'],use:'study'},
 {id:'poker_table',name:'Home poker table',from:1829,base:480,w:4,h:3,rooms:['Living','Study'],use:'poker'},
 {id:'wardrobe',name:'Wardrobe',from:1829,base:160,w:2,h:1,rooms:['Bedroom','Storage'],use:'clothes'},
 {id:'bookshelf',name:'Bookshelf',from:1829,base:100,w:2,h:1,rooms:['Study','Living'],use:'books'},
 {id:'trophy',name:'Trophy cabinet',from:1850,base:180,w:2,h:1,rooms:['Living','Study'],use:'trophies'},
 {id:'safe',name:'Household safe',from:1850,base:260,w:1,h:1,rooms:['Study','Bedroom','Storage'],use:'safe'},
 {id:'weights',name:'Free weights',from:1850,base:190,w:2,h:2,rooms:['Gym','Storage'],use:'strength'},
 {id:'mat',name:'Exercise mat',from:1829,base:30,w:1,h:2,rooms:['Gym','Bedroom','Living'],use:'mobility'},
 {id:'bike',name:'Exercise bicycle',from:1970,base:400,w:2,h:2,rooms:['Gym'],use:'cardio'},
 {id:'bag',name:'Punching bag',from:1900,base:150,w:1,h:2,rooms:['Gym','Storage'],use:'boxing'}
];
const TRAINING={strength:{name:'Strength training',from:1850,minutes:60,strength:.65,cardio:.08,mobility:.1,fatigue:23,muscle:.13,bodyFat:-.015},
 cardio:{name:'Cardio',from:1829,minutes:45,strength:.06,cardio:.65,mobility:.1,fatigue:20,muscle:0,bodyFat:-.045},
 boxing:{name:'Boxing practice',from:1850,minutes:60,strength:.15,cardio:.32,boxing:.7,mobility:.1,fatigue:25,muscle:.06,bodyFat:-.025},
 swimming:{name:'Pool session',from:1900,minutes:45,strength:.15,cardio:.55,mobility:.15,fatigue:18,muscle:.04,bodyFat:-.025},
 mobility:{name:'Mobility and recovery',from:1829,minutes:30,strength:0,cardio:.03,mobility:.6,fatigue:-12,muscle:0,bodyFat:0},
 sauna:{name:'Sauna recovery',from:1965,minutes:20,strength:0,cardio:0,mobility:.05,fatigue:-15,muscle:0,bodyFat:0}};
function furniture(w,id){const f=seed(w).furniture[id];ok(f,'That furnishing was not found.');return f;}
function furnishing(w,p,id){const f=furniture(w,id);ok(f.owner===p.playerUuid,'That furnishing belongs to another player.');return f;}
function home(w,p,ctx){const h=person(w,p.playerUuid).home;ok(h,'Choose an owned vacant unit or rent a home first.');const r=property(w,h.propertyId,ctx);ok(access(w,p,r,h.unit),'This character no longer has access to that unit.');atCity(w,p,r);return{...h,property:r};}
function usable(w,p,f,ctx){ok(f.status==='placed'&&f.place,'Place this furnishing in a room first.');const r=property(w,f.place.propertyId,ctx);ok(f.owner===p.playerUuid&&access(w,p,r,f.place.unit),'You do not have access to this furnishing.');atCity(w,p,r);ok(!r.work,'Renovation is still in progress.');return r;}
function dimension(f,rot){const t=FURNITURE.find(t=>t.id===f.kind);return rot%180?{w:t.h,h:t.w}:{w:t.w,h:t.h};}
function validatePlace(w,p,f,q,ctx){
 const r=property(w,q.propertyId,ctx);ok(access(w,p,r,q.unit),'No permission to decorate this unit.');atCity(w,p,r);ok(!r.work,'Wait until renovation completes.');
 ok(r.rooms.includes(q.room),'Choose an existing room.');const t=FURNITURE.find(x=>x.id===f.kind);ok(t.rooms.includes(q.room),'This furnishing does not fit the function of that room.');
 integer(q.x,0,11,'Horizontal tile');integer(q.y,0,8,'Vertical tile');ok([0,90,180,270].includes(q.rotation),'Rotation must be 0, 90, 180 or 270 degrees.');const d=dimension(f,q.rotation);
 ok(q.x+d.w<=12&&q.y+d.h<=9,'Furniture must stay inside the room.');
 const boxes=Object.values(seed(w).furniture).filter(x=>x.id!==f.id&&x.status==='placed'&&x.place?.propertyId===r.id&&x.place.unit===q.unit&&x.place.room===q.room).map(x=>({...x.place,...dimension(x,x.place.rotation)}));
 const b={...q,...d};boxes.push(b);
 const hit=(a,b)=>a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y;
 ok(!boxes.slice(0,-1).some(a=>hit(a,b)),'Furniture overlaps another item.');
 ok(!boxes.some(a=>hit(a,{x:5,y:7,w:2,h:2})),'Keep the doorway and approach clear.');
 const blocked=(x,y)=>boxes.some(b=>x>=b.x&&x<b.x+b.w&&y>=b.y&&y<b.y+b.h),seen=new Set(['5,8']),queue=[[5,8]];
 for(let i=0;i<queue.length;i++){const[x,y]=queue[i];for(const[dx,dy]of[[1,0],[-1,0],[0,1],[0,-1]]){const xx=x+dx,yy=y+dy,key=xx+','+yy;if(xx<0||yy<0||xx>=12||yy>=9||blocked(xx,yy)||seen.has(key))continue;seen.add(key);queue.push([xx,yy]);}}
 ok(boxes.every(b=>{for(let x=b.x;x<b.x+b.w;x++)if(seen.has(x+','+(b.y-1))||seen.has(x+','+(b.y+b.h)))return true;for(let y=b.y;y<b.y+b.h;y++)if(seen.has((b.x-1)+','+y)||seen.has((b.x+b.w)+','+y))return true;return false;}),'Every furnishing needs a walkable approach from the door.');
 return cp(q);
}
function gymAllowed(w,p,ctx,kind,source){
 const t=TRAINING[kind];ok(t&&year(w)>=t.from,'This workout is not offered in this era.');const s=person(w,p.playerUuid),f=s.fitness;
 ok(!f.pending,'A workout is already underway.');ok(f.fatigue<75||['mobility','sauna'].includes(kind),'Recover before another demanding workout.');
 ok(f.lastWorkout==null||w.clock.minute-f.lastWorkout>=(['mobility','sauna'].includes(kind)?4*60:18*60),'Allow recovery time before another workout.');
 if(source==='home'){
  const h=home(w,p,ctx);ok(Object.values(seed(w).furniture).some(x=>x.owner===p.playerUuid&&x.status==='placed'&&x.place?.propertyId===h.propertyId&&x.place.unit===h.unit&&FURNITURE.find(t=>t.id===x.kind)?.use===kind),'Place the corresponding home equipment first.');
 }else if(source==='outdoor'){ok(['cardio','mobility'].includes(kind),'Outdoor sessions offer cardio and mobility.');}
 else{const valid=s.membership?.active&&s.membership.city===p.location?.city&&s.membership.paidUntil>w.clock.minute||s.dayPass?.city===p.location?.city&&s.dayPass.until>w.clock.minute;ok(valid,'Buy a local gym day pass or an active membership first.');}
 return t;
}
function schedule(w,p,minutes,kind,detail,ctx){
 ok(!p.availability,'Another activity is still pending.');const a={id:id(w,'life_activity'),kind:'activity',label:detail.label||kind,from:w.clock.minute,until:w.clock.minute+minutes,startedAt:ctx.now,completion:{kind:'life842',action:kind,...cp(detail)},departureSnapshotRevision:p.snapshot?.revision||0,life842:true};
 p.availability=a;return a;
}
function completeFitness(w,p,job){
 const s=person(w,p.playerUuid),f=s.fitness,t=TRAINING[job.kind];
 for(const k of ['strength','cardio','boxing','mobility'])f[k]=Math.round(clamp(f[k]+(t[k]||0)*(1-f[k]/130),0,100)*1000)/1000;
 f.fatigue=clamp(f.fatigue+t.fatigue,0,100);f.muscle=clamp(f.muscle+t.muscle,5,80);f.bodyFat=clamp(f.bodyFat+t.bodyFat,8,45);f.stamina=clamp(30+f.cardio*.55+f.strength*.15-f.fatigue*.15,10,100);
 f.wellness=clamp(f.wellness+.18,0,100);f.agingReserve=clamp(f.agingReserve+.035,0,10);f.sessions++;f.minutes+=t.minutes;f.lastWorkout=job.until;f.history.push({id:job.id,at:job.until,kind:job.kind,minutes:t.minutes});f.history=f.history.slice(-100);f.pending=null;s.effects.workouts++;log(w,'fitness',t.name+' completed. No poker-skill modifier.',[p.playerUuid]);
}
function tickAt(w,ctx){
 const s=seed(w);let changed=false;
 for(const o of Object.values(s.offers))if(o.status==='pending'&&o.expires<=w.clock.minute){o.status='expired';changed=true;}
 // Occupant contributions are settled before the main landlord bill at the same date.
 const ls=Object.values(s.leases).filter(l=>['active','notice'].includes(l.status)).sort((a,b)=>(a.kind==='lease')-(b.kind==='lease'));
 for(const l of ls)changed=settleLease(w,l,ctx)||changed;
 for(const r of Object.values(s.properties))changed=settleProperty(w,r,ctx)||changed;
 for(const f of Object.values(s.furniture))if(f.status==='delivery'&&f.arriveAt<=w.clock.minute){f.status='stored';log(w,'delivery',FURNITURE.find(t=>t.id===f.kind)?.name+' delivered to local storage.',[f.owner]);changed=true;}
 for(const p of w.players){
  const q=person(w,p.playerUuid),f=q.fitness,day=Math.floor(w.clock.minute/DAY),days=Math.max(0,day-f.lastDay);
  if(days){f.fatigue=Math.max(0,f.fatigue-days*14);const gap=f.lastWorkout==null?0:Math.max(0,day-Math.floor(f.lastWorkout/DAY)-7);if(gap){const decline=Math.min(days,gap,365)*.035;f.strength=Math.max(10,f.strength-decline);f.cardio=Math.max(10,f.cardio-decline);f.agingReserve=Math.max(0,f.agingReserve-Math.min(days,365)*.002);}
   f.stamina=clamp(30+f.cardio*.55+f.strength*.15-f.fatigue*.15,10,100);f.lastDay=day;changed=true;}
  if(f.pending&&f.pending.until<=w.clock.minute){completeFitness(w,p,f.pending);changed=true;}
  const rest=q.restPending;if(rest&&rest.until<=w.clock.minute){f.fatigue=Math.max(0,f.fatigue-(rest.kind==='sleep'?65:18));q.effects.rest++;q.lastRestAt=rest.until;q.lastRestKind=rest.kind;q.restPending=null;log(w,'rest',rest.kind==='sleep'?'Eight-hour home rest completed.':'Home rest completed.',[p.playerUuid]);changed=true;}
  const m=q.membership;if(m?.active&&m.paidUntil<=w.clock.minute){
   let guard=0;while(m.active&&m.paidUntil<=w.clock.minute&&guard++<1200){
    if(!m.autoRenew){m.active=false;break;}if(!funded(w,p.playerUuid,m.priceCents)){m.active=false;m.lapsed=true;log(w,'gym','Gym membership lapsed without debt after a missed renewal.',[p.playerUuid]);break;}
    wallet(w,p,-m.priceCents,'gym-renewal','gym:'+p.playerUuid+':'+m.anchor+':'+m.index,ctx);m.index++;m.paidUntil=addMonths(m.anchor,m.index*(m.period||1));changed=true;
   }changed=true;
  }
 }
 s.lastMinute=w.clock.minute;if(changed)bump(w);return changed;
}
function tick(w,ctx){
 const target=w.clock.minute,s=seed(w);let cursor=Math.min(s.lastMinute??target,target),changed=false,steps=0;
 try{
  w.clock.minute=cursor;changed=tickAt(w,ctx)||changed;
  while(cursor<target){
   const event=nextEvent(w);cursor=Math.min(target,event);ok(Number.isSafeInteger(cursor),'Invalid life calendar.');
   w.clock.minute=cursor;changed=tickAt(w,ctx)||changed;
   ok(++steps<=12000,'Settle shorter calendar spans before continuing.');
  }
 }finally{w.clock.minute=target;}
 return changed;
}
function nextEvent(w){const s=seed(w),at=w.clock.minute,targets=[];
 for(const f of Object.values(s.furniture))if(f.status==='delivery')targets.push(f.arriveAt);
 for(const r of Object.values(s.properties)){if(r.work)targets.push(r.work.until);if(r.mortgage){targets.push(r.mortgage.nextDue);if(r.mortgage.firstMissed!=null)targets.push(r.mortgage.firstMissed+90*DAY);if(r.mortgage.noticeAt!=null)targets.push(r.mortgage.noticeAt+30*DAY);}if(r.upkeepDue)targets.push(r.upkeepDue);}
 for(const l of Object.values(s.leases))if(['active','notice'].includes(l.status))targets.push(l.nextDue,l.end,l.terminateAt??Infinity);
 for(const q of Object.values(s.people)){if(q.membership?.active)targets.push(q.membership.paidUntil);if(q.fitness.pending)targets.push(q.fitness.pending.until);if(q.restPending)targets.push(q.restPending.until);}
 return Math.min(...targets.filter(x=>x>at))||Infinity;
}
function handle(w,p,a,ctx){
 tick(w,ctx);const s=seed(w),q=person(w,p.playerUuid),act=a.action;ok(p.status==='active'&&p.character?.bound,'Create and save the Career first.');freePlayer(w,p);
 const ref='life:'+p.playerUuid+':'+a.requestId;let result={};
 if(act==='adopt_native'){
  const n=(ctx.nativeTitles||[]).find(x=>x.id===a.nativeId);ok(n,'Save the native Career and select an eligible owned residential title first.');
  const key='native:'+p.playerUuid+':'+n.id;ok(!s.properties[key],'This title was already transferred to the new registry.');
  const t=TYPES.find(t=>t.id===(n.kind==='rental'?'apartments':'cottage')),r={...listing(w,city(w,n.city,ctx),t),id:key,name:n.name,nativeId:n.id,nativeBuilding:n.building||null,owner:p.playerUuid,importBasis:n.valueCents,basisCents:n.valueCents,boughtAt:w.clock.minute,upkeepAnchor:w.clock.minute,upkeepIndex:1,upkeepDue:addMonths(w.clock.minute,1),version:1};s.properties[key]=r;log(w,'registry','Existing title adopted without charging a second purchase. Legacy rent/upkeep stops for this title.',[p.playerUuid]);result.propertyId=key;
 }else if(act==='let_npc'){
  const r=property(w,a.propertyId,ctx);own(w,p,r);const u=unit(r,a.unit??1);ok(!currentLease(w,r,u),'This unit is already leased.');ok(!r.work,'Finish renovation first.');
  const n=Math.round(postedRent(w,r,ctx)*.9),o={id:id(w,'offer'),kind:'lease',propertyId:r.id,unit:u,propertyVersion:r.version,proposer:p.playerUuid,recipient:'npc',landlord:p.playerUuid,tenant:'npc',status:'pending',expires:w.clock.minute+1,terms:{rentCents:n,depositCents:n,months:12,allowSublet:false,roommates:0}};s.offers[o.id]=o;accept(w,{playerUuid:'npc'},o,ctx);
 }else if(act==='buy'){
  const r=property(w,a.propertyId,ctx);entity(r,a.propertyVersion);atCity(w,p,r);ok(r.owner==='npc','This home already has an owner. Make that owner a purchase offer.');
  ok(!Object.values(s.leases).some(l=>l.propertyId===r.id&&['active','notice'].includes(l.status)),'This NPC building has active renters and is not for sale.');const total=appraisal(w,r,ctx);
  let down=total;if(a.mortgage){const pct=integer(a.downPercent??20,20,90,'Down payment percent'),months=integer(a.months??120,12,360,'Mortgage months');down=Math.ceil(total*pct/100);r.mortgage={anchor:w.clock.minute,nextDue:addMonths(w.clock.minute,1),dueIndex:1,months,annualBps:600,principalCents:total-down,interestArrears:0,overdueCents:0,paymentCents:mortgagePayment(total-down,months),paidCents:0,firstMissed:null,noticeAt:null};}
  wallet(w,p,-down,'property-down-payment',ref,ctx);r.owner=p.playerUuid;r.basisCents=total;r.boughtAt=w.clock.minute;r.upkeepAnchor=w.clock.minute;r.upkeepIndex=1;r.upkeepDue=addMonths(w.clock.minute,1);r.version++;q.home={propertyId:r.id,unit:1,leaseId:null};log(w,'purchase',r.name+(a.mortgage?' · financed':' · owned outright'),[p.playerUuid],total);result.propertyId=r.id;
 }else if(act==='rent_npc'){
  const r=property(w,a.propertyId,ctx);atCity(w,p,r);ok(r.owner==='npc','This residence has a human owner; propose a lease.');const u=unit(r,a.unit??1);ok(!currentLease(w,r,u),'That unit is already rented.');const n=postedRent(w,r,ctx),o={id:id(w,'offer'),kind:'lease',propertyId:r.id,unit:u,propertyVersion:r.version,proposer:'npc',recipient:p.playerUuid,landlord:'npc',tenant:p.playerUuid,status:'pending',expires:w.clock.minute+1,terms:{rentCents:n,depositCents:n,months:integer(a.months??3,1,24),allowSublet:false,roommates:1}};s.offers[o.id]=o;accept(w,p,o,ctx);
 }else if(act==='offer')result.offer=proposal(w,p,a,ctx);
 else if(act==='accept')accept(w,p,s.offers[a.offerId],ctx);
 else if(act==='decline'){const o=s.offers[a.offerId];ok(o&&o.status==='pending'&&[o.proposer,o.recipient].includes(p.playerUuid),'No pending offer belongs to this player.');o.status='declined';}
 else if(act==='counter'){
  const o=s.offers[a.offerId];ok(o&&o.status==='pending'&&o.recipient===p.playerUuid&&o.expires>w.clock.minute,'Only the recipient of a current offer can counter.');
  const r=property(w,o.propertyId,ctx);entity(r,o.propertyVersion);const terms=o.kind==='sale'?{priceCents:cash(a.price)}:leaseTerms(w,r,a);ok(o.kind!=='sale'||terms.priceCents>0,'Sale price must be positive.');
  o.status='countered';const next={...cp(o),id:id(w,'offer'),proposer:p.playerUuid,recipient:o.proposer,terms,status:'pending',at:w.clock.minute,expires:w.clock.minute+7*DAY};if(o.kind==='sale'){next.seller=o.seller||o.proposer;}
  s.offers[next.id]=next;result.offer=next;log(w,'counter','Counteroffer replaces prior terms.',[p.playerUuid,o.proposer]);
 }else if(act==='pay_rent'){
  const l=s.leases[a.leaseId];ok(l&&l.tenant===p.playerUuid&&l.arrearsCents>0,'No rent arrears belong to this player.');
  const n=Math.min(l.arrearsCents,a.amount==null?l.arrearsCents:cash(a.amount));ok(n>0,'Choose a positive repayment.');transfer(w,l.tenant,l.landlord,n,'rent-arrears',ref,ctx);l.arrearsCents-=n;if(!l.arrearsCents){l.noticeAt=null;if(l.status==='notice')l.status='active';}log(w,'rent-cure','Rent arrears paid.',[l.tenant,l.landlord],n);
 }else if(act==='lease_notice'){
  const l=s.leases[a.leaseId];ok(l&&['active','notice'].includes(l.status),'Choose an active lease.');
  if(l.tenant===p.playerUuid){l.terminateAt=Math.min(l.end,w.clock.minute+30*DAY);log(w,'tenant-notice','Tenant gave 30-game-day moving notice.',[l.landlord,l.tenant]);}
  else{ok(l.landlord===p.playerUuid&&l.arrearsCents>0,'Only the landlord of a delinquent lease can give notice.');if(l.noticeAt==null)l.noticeAt=w.clock.minute;l.status='notice';log(w,'arrears-notice','Seven-game-day cure notice served.',[l.landlord,l.tenant]);}
 }else if(act==='evict'){const l=s.leases[a.leaseId];ok(l&&l.landlord===p.playerUuid&&l.status==='notice'&&l.arrearsCents>0&&l.noticeAt!=null&&w.clock.minute>=l.noticeAt+7*DAY,'An unpaid lease and a completed seven-day cure notice are required.');endLease(w,l,ctx,'Eviction after unpaid cure notice');}
 else if(act==='mortgage_pay'){const r=property(w,a.propertyId,ctx);own(w,p,r);ok(r.mortgage,'No mortgage remains.');payMortgage(w,p,r,a.amount==null?mortgageDebt(r.mortgage):cash(a.amount),ctx,ref);r.version++;}
 else if(act==='upkeep_pay'){const r=property(w,a.propertyId,ctx);own(w,p,r);wallet(w,p,-r.upkeepArrears,'property-upkeep-arrears',ref,ctx);r.upkeepArrears=0;r.version++;}
 else if(act==='renovate'){
  const r=property(w,a.propertyId,ctx);own(w,p,r);atCity(w,p,r);ok(!Object.values(s.games).some(g=>g.propertyId===r.id&&g.status!=='closed'),'Close the home game before renovating.');ok(!r.work&&r.renovations<3,'No further renovation is currently available.');const n=Math.round(appraisal(w,r,ctx)*.08);wallet(w,p,-n,'property-renovation',ref,ctx);r.work={from:w.clock.minute,until:w.clock.minute+14*DAY,costCents:n};r.version++;log(w,'renovation','Fourteen-game-day renovation started; access resumes when complete.',[p.playerUuid],n);
 }else if(act==='sell_npc'){
  const r=property(w,a.propertyId,ctx);own(w,p,r);ok(!r.work,'Finish renovation before selling.');ok(!Object.values(s.games).some(g=>g.propertyId===r.id&&g.status!=='closed'),'Close the home poker game before selling.');
  const total=Math.round(appraisal(w,r,ctx)*.85),debt=r.mortgage?mortgageDebt(r.mortgage):0;ok(total>=debt+r.upkeepArrears,'Sale proceeds cannot cover the mortgage and upkeep.');wallet(w,p,total-debt-r.upkeepArrears,'property-sale',ref,ctx);r.owner='npc';r.mortgage=null;r.upkeepArrears=0;r.version++;
  for(const l of Object.values(s.leases))if(l.propertyId===r.id&&l.kind==='lease'&&l.landlord===p.playerUuid&&['active','notice'].includes(l.status))l.landlord='npc';
  if(q.home?.propertyId===r.id&&!q.home.leaseId)q.home=null;for(const f of Object.values(s.furniture))if(f.owner===p.playerUuid&&f.place?.propertyId===r.id){f.place=null;f.status='stored';}
  log(w,'sale','Property sold at 85% appraisal, net of debt; personal furnishings moved to storage.',[p.playerUuid],total);
 }else if(act==='set_home'){const r=property(w,a.propertyId,ctx),u=unit(r,a.unit??1);atCity(w,p,r);ok(access(w,p,r,u),'Own a vacant unit or sign a lease first.');const l=Object.values(s.leases).find(l=>l.propertyId===r.id&&l.unit===u&&l.tenant===p.playerUuid&&['active','notice'].includes(l.status));q.home={propertyId:r.id,unit:u,leaseId:l?.id||null};log(w,'home','Home base changed to '+r.name,[p.playerUuid]);}
 else if(act==='buy_furniture'){
  const t=FURNITURE.find(x=>x.id===a.kind);ok(t&&year(w)>=t.from,'This furnishing is unavailable in this era.');const c=city(w,p.location.city,ctx),n=price(t.base,w,c);
  ok(Object.values(s.furniture).filter(f=>f.owner===p.playerUuid&&f.status!=='sold').length<200,'The household storage limit is 200 items.');
  wallet(w,p,-n,'furniture-purchase',ref,ctx);const f={id:id(w,'furniture'),kind:t.id,owner:p.playerUuid,city:c.id,paidCents:n,boughtAt:w.clock.minute,arriveAt:w.clock.minute+(year(w)<1950?2*DAY:DAY),status:'delivery',place:null};s.furniture[f.id]=f;result.itemId=f.id;log(w,'furniture-order',t.name+' ordered; delivery is scheduled.',[p.playerUuid],n);
 }else if(act==='place'){
  const f=furnishing(w,p,a.itemId);ok(!Object.values(s.games).some(g=>g.itemId===f.id&&g.status!=='closed'),'Close the home game before moving its table.');ok(['stored','placed'].includes(f.status),'Wait for delivery before placing this item.');ok(f.city===p.location.city,'Ship the furniture to this city first.');
  const place=validatePlace(w,p,f,{propertyId:a.propertyId,unit:a.unit??1,room:a.room,x:a.x,y:a.y,rotation:a.rotation??0},ctx);f.place=place;f.status='placed';log(w,'decorate','Furnishing placement saved.',[p.playerUuid]);
 }else if(act==='store'){
  const f=furnishing(w,p,a.itemId);ok(f.status==='placed','This item is not placed.');usable(w,p,f,ctx);ok(!Object.values(s.games).some(g=>g.itemId===f.id&&g.status!=='closed'),'Close the home game before moving its table.');f.place=null;f.status='stored';
 }else if(act==='ship'){
  const f=furnishing(w,p,a.itemId);ok(['stored','placed'].includes(f.status),'An item in transit cannot be shipped again.');ok(!Object.values(s.games).some(g=>g.itemId===f.id&&g.status!=='closed'),'Close the home game first.');const c=city(w,a.toCity,ctx);ok(c.id!==f.city,'This item is already in that city.');const n=Math.max(1,Math.round(price(35,w,c)+f.paidCents*.03));wallet(w,p,-n,'furniture-moving',ref,ctx);f.place=null;f.status='delivery';f.city=c.id;f.arriveAt=w.clock.minute+(year(w)<1950?7:3)*DAY;log(w,'moving','Furniture packed and shipped to '+c.name,[p.playerUuid],n);
 }else if(act==='sell_furniture'){
  const f=furnishing(w,p,a.itemId);ok(['stored','placed'].includes(f.status)&&f.city===p.location.city,'Collect the furniture locally before selling.');ok(!Object.values(s.games).some(g=>g.itemId===f.id&&g.status!=='closed'),'Close the home game first.');
  const n=Math.floor(f.paidCents*.5);wallet(w,p,n,'furniture-resale',ref,ctx);f.status='sold';f.place=null;log(w,'furniture-sale','Used furniture sold at 50% purchase price.',[p.playerUuid],n);
 }else if(act==='use'){
  const f=furnishing(w,p,a.itemId);usable(w,p,f,ctx);const t=FURNITURE.find(t=>t.id===f.kind),use=t.use;
  if(['sleep','rest'].includes(use)){const a=schedule(w,p,use==='sleep'?480:60,use,{label:use==='sleep'?'Home sleep':'Home rest',itemId:f.id},ctx);q.restPending={id:a.id,kind:use,until:a.until};}
  else if(use==='food'){const n=price(24,w,city(w,p.location.city,ctx));ok(q.food<=16,'Fridge/icebox storage is limited to 24 meal portions.');wallet(w,p,-n,'groceries',ref,ctx);q.food+=8;log(w,'groceries','Eight meal portions stocked.',[p.playerUuid],n);}
  else if(use==='cook'){ok(q.food>=2,'Stock a fridge or icebox first.');ok(q.lastMeal==null||w.clock.minute-q.lastMeal>=4*60,'Allow four game hours between cooked meals.');q.food-=2;q.lastMeal=w.clock.minute;q.fitness.fatigue=Math.max(0,q.fitness.fatigue-4);q.fitness.wellness=clamp(q.fitness.wellness+.15,0,100);q.effects.meals++;schedule(w,p,30,'cook',{label:'Cooking a meal'},ctx);}
  else if(use==='study'){q.studyMinutes+=30;schedule(w,p,30,'study',{label:'Home study · 30 minutes'},ctx);log(w,'study','Study time recorded. Strategy remains learned, not a chair bonus.',[p.playerUuid]);}
  else if(use==='clothes'){const name=clean(a.label||'Everyday outfit',40);ok(q.clothes.length<40,'Wardrobe is full.');wallet(w,p,-price(30,w,city(w,p.location.city,ctx)),'clothing',ref,ctx);q.clothes.push({id:id(w,'outfit'),name,at:w.clock.minute});}
  else if(use==='books'){ok(q.books.length<80,'Bookshelf collection is full.');wallet(w,p,-price(12,w,city(w,p.location.city,ctx)),'book',ref,ctx);q.books.push({id:id(w,'book'),name:clean(a.label||'Poker notebook',60),at:w.clock.minute});}
  else if(use==='safe'){
   const n=cash(a.amount);ok(n>0,'Choose a positive safe transfer.');if(a.withdraw){ok(q.safeCents>=n,'Not enough stored valuables.');q.safeCents-=n;wallet(w,p,n,'safe-withdrawal',ref,ctx);}else{wallet(w,p,-n,'safe-deposit',ref,ctx);q.safeCents+=n;}log(w,'safe',a.withdraw?'Safe withdrawal':'Money stored in the safe',[p.playerUuid],n);
  }else if(use==='media'){q.lastUse[f.id]=w.clock.minute;result.media=f.kind;log(w,'media','Used '+t.name,[p.playerUuid]);}
  else if(use==='trophies'){result.trophies=true;}
  else if(use==='poker'){result.homeGame=true;}
  else{const t=gymAllowed(w,p,ctx,use,'home'),a=schedule(w,p,t.minutes,'workout',{label:t.name,workout:use},ctx);q.fitness.pending={id:a.id,kind:use,until:a.until};}
 }else if(act==='gym_pass'){
  const c=city(w,p.location.city,ctx);ok(year(w)>=1850,'This era offers outdoor cardio and recovery; the authored club opens from 1850.');wallet(w,p,-price(8,w,c),'gym-day-pass',ref,ctx);q.dayPass={city:c.id,until:w.clock.minute+DAY};log(w,'gym','24-game-hour local gym pass purchased.',[p.playerUuid]);
 }else if(act==='gym_join'){
  const c=city(w,p.location.city,ctx);ok(year(w)>=1850,'The authored gym opens from 1850.');ok(!q.membership?.active||q.membership.paidUntil<=w.clock.minute,'A paid membership is already active.');const period=a.annual?12:1,n=price(a.annual?450:45,w,c);wallet(w,p,-n,'gym-membership',ref,ctx);q.membership={city:c.id,active:true,anchor:w.clock.minute,index:1,period,paidUntil:addMonths(w.clock.minute,period),priceCents:n,autoRenew:a.autoRenew===true};log(w,'gym','Gym membership activated; renewal is opt-in.',[p.playerUuid],n);
 }else if(act==='gym_cancel'){ok(q.membership,'No membership exists.');q.membership.autoRenew=false;log(w,'gym','Renewal cancelled; paid access remains until expiry.',[p.playerUuid]);}
 else if(act==='workout'){const t=gymAllowed(w,p,ctx,a.kind,a.source||'club'),job=schedule(w,p,t.minutes,'workout',{label:t.name,workout:a.kind},ctx);q.fitness.pending={id:job.id,kind:a.kind,until:job.until};}
 else ok(false,'Unknown life-economy action.');
 tick(w,ctx);bump(w);validate(w);return result;
}
function projection(w,p,ctx){
 const s=seed(w),q=person(w,p.playerUuid),rows=catalogue(w,p.location?.city||w.settings.startingCity,ctx),ids=new Set(rows.map(r=>r.id));
 for(const r of Object.values(s.properties))if(!ids.has(r.id)&&(r.owner===p.playerUuid||Object.values(s.leases).some(l=>l.propertyId===r.id&&[l.landlord,l.tenant].includes(p.playerUuid)))){rows.push(r);ids.add(r.id);}
 const ownItems=Object.values(s.furniture).filter(f=>f.owner===p.playerUuid&&f.status!=='sold');
 return {version:VERSION,revision:s.revision,minute:w.clock.minute,playerUuid:p.playerUuid,own:cp(q),
  properties:rows.map(r=>({...cp(r),appraisalCents:appraisal(w,r,ctx),rentCents:postedRent(w,r,ctx),mortgage:r.owner===p.playerUuid?cp(r.mortgage):null,occupied:Array.from({length:r.units},(_,i)=>{const l=currentLease(w,r,i+1);return{unit:i+1,occupied:!!l,own:!!l&&l.tenant===p.playerUuid};})})),
  leases:Object.values(s.leases).filter(l=>[l.landlord,l.tenant].includes(p.playerUuid)).map(cp),
  offers:Object.values(s.offers).filter(o=>[o.proposer,o.recipient].includes(p.playerUuid)&&o.status==='pending'&&o.expires>w.clock.minute).map(cp),
  roomFurniture:Object.values(s.furniture).filter(f=>f.status==='placed'&&f.place&&q.home?.propertyId===f.place.propertyId&&q.home.unit===f.place.unit).map(f=>({id:f.id,kind:f.kind,place:cp(f.place),own:f.owner===p.playerUuid})),
  nativeTitles:cp(ctx.nativeTitles||[]),furniture:ownItems.map(cp),catalog:FURNITURE.filter(t=>year(w)>=t.from).map(t=>({...t,priceCents:price(t.base,w,ctx.cities[p.location?.city])})),
  workouts:Object.entries(TRAINING).filter(([k,t])=>year(w)>=t.from).map(([id,t])=>({id,name:t.name,minutes:t.minutes})),gymPrices:{day:price(8,w,ctx.cities[p.location?.city]),month:price(45,w,ctx.cities[p.location?.city]),annual:price(450,w,ctx.cities[p.location?.city])},
  journal:s.journal.filter(e=>e.people.includes(p.playerUuid)).slice(-100).map(cp),
  policy:'Fictional lease and fitness rules, not local law or medical guidance. Signed amounts stay fixed; household items never add poker skill.'};
}
function validate(w){
 const s=seed(w);ok(s.schema===1&&Number.isSafeInteger(s.revision),'Invalid life state revision.');
 ok(Object.keys(s.properties).length<=4096&&Object.keys(s.leases).length<=10000&&Object.keys(s.furniture).length<=50000,'Life archive limit reached. Export a server backup.');
 for(const r of Object.values(s.properties)){ok(r.owner==='npc'||w.players.some(p=>p.playerUuid===r.owner),'Unknown title owner.');ok(r.condition>=0&&r.condition<=100,'Invalid condition.');if(r.mortgage)for(const k of ['principalCents','interestArrears','overdueCents','paidCents'])integer(r.mortgage[k],0,MAX,k);}
 const occupied=new Set();for(const l of Object.values(s.leases)){for(const k of ['rentCents','depositCents','arrearsCents','paidCents'])integer(l[k],0,MAX,k);if(['active','notice'].includes(l.status)&&l.kind==='lease'){const key=l.propertyId+'|'+l.unit;ok(!occupied.has(key),'Two primary tenants occupy the same unit.');occupied.add(key);}}
 for(const q of Object.values(s.people)){integer(q.safeCents,0,MAX,'Safe balance');ok(q.food>=0&&q.food<=24,'Invalid food inventory.');for(const v of Object.values(q.fitness))if(typeof v==='number')ok(Number.isFinite(v),'Invalid fitness state.');}
 return true;
}
return Object.freeze({VERSION,DAY,MAX,TYPES,FURNITURE,TRAINING,seed,person,property,access,usable,home,appraisal,postedRent,price,addMonths,mortgagePayment,mortgageDebt,handle,tick,nextEvent,projection,validate,cp,cash,integer,ok,log,id,wallet,freePlayer});
})();
export default Life842;
