/* V84.1 save integrity and native V47.5/V22.13 economy functions.
   Values intentionally match the attached game; this is not a new price model. */
const PRICE_DATA=Object.freeze([32.0,32.0,32.0,30.0,29.0,30.0,31.0,33.0,34.0,32.0,32.0,30.0,31.0,29.0,28.0,28.0,28.0,27.0,28.0,26.0,25.0,25.0,25.0,25.0,25.0,27.0,28.0,27.0,28.0,26.0,27.0,27.0,27.0,30.0,37.0,47.0,46.0,44.0,42.0,40.0,40.0,38.0,36.0,36.0,36.0,34.0,33.0,32.0,32.0,29.0,28.0,29.0,29.0,29.0,28.0,27.0,27.0,27.0,27.0,27.0,27.0,27.0,27.0,27.0,27.0,26.0,25.0,25.0,25.0,25.0,25.0,25.0,25.0,26.0,27.0,27.0,27.0,27.0,28.0,27.0,27.0,28.0,28.0,29.0,29.7,30.1,30.4,32.7,38.5,45.2,52.1,60.2,53.6,50.3,51.2,51.5,52.7,53.2,52.2,51.6,51.6,50.2,45.7,41.0,38.9,40.2,41.2,41.7,43.2,42.3,41.8,42.1,44.2,49.1,52.0,52.9,54.1,58.6,67.1,72.2,71.5,72.3,78.0,79.8,80.4,80.7,80.5,81.7,84.4,86.7,87.6,88.9,89.8,90.9,92.0,93.2,94.7,97.5,100.2,104.5,110.2,116.7,121.7,125.7,133.4,148.2,161.7,171.0,182.1,196.0,218.1,247.6,273.2,290.0,299.3,312.2,323.2,329.4,341.4,355.4,372.5,392.6,409.3,421.7,434.1,445.4,457.9,471.3,482.4,489.8,500.6,517.5,532.1,540.5,552.8,567.6,586.9,605.8,623.1,647.0,644.7,655.3,676.0,689.9,700.0,711.4,712.3,721.2,736.6,754.6,768.3,777.7,814.3,879.4,915.6,942.7,967.5,1004.8]);
export function priceFactor(year){
 const y=Number(year);if(!Number.isInteger(y)||y<1829||y>9998)throw Error('Unsupported Career year.');
 return y>2026?Math.pow(1.025,Math.min(y-2026,374)):PRICE_DATA[y-1829]/PRICE_DATA.at(-1);
}
function moneyStep(v,y){v=Math.abs(v);if(y<1940)return v<5?.05:v<25?.25:v<100?1:5;if(y<1970)return v<10?.10:v<50?.50:v<250?2:10;if(y<1990)return v<25?.25:v<100?1:v<500?5:25;if(y<2010)return v<50?.50:v<250?2:v<1000?10:50;return v<100?1:v<500?5:v<2500?25:100;}
function roundNominal(v,y){if(!v)return 0;const step=moneyStep(v,y);return Math.sign(v)*Math.max(step,Math.round(Math.round(Math.abs(v)/step)*step*100)/100);}
function roundStake(v){v=Math.max(.01,v);const opts=[];if(v<=.5)opts.push(.01,.02,.05,.1,.25,.5);else {const e=Math.floor(Math.log10(v));for(let k=e-1;k<=e+1;k++)for(const m of [1,2,5])opts.push(m*Math.pow(10,k));}let best=opts[0];for(const s of opts)if(Math.abs(v-s)<Math.abs(v-best)-.000001)best=s;return Math.round(best*100)/100;}
export function founderBankroll(y){const f=priceFactor(y),small=roundStake(2*f);return Math.max(roundNominal(1000*f,y),Math.round(small*400*100)/100);}
export function nativeChecksum(text){let a=2166136261,b=5381;for(let i=0;i<text.length;i++){const c=text.charCodeAt(i);a=Math.imul(a^c,16777619);b=((b<<5)+b)^c;}return text.length+':'+(a>>>0).toString(16)+':'+(b>>>0).toString(16);}
export function safeTree(v,depth=0){
 if(depth>110)throw Error('Save nesting limit exceeded.');
 if(typeof v==='number'&&!Number.isFinite(v))throw Error('Non-finite save number.');
 if(v&&typeof v==='object')for(const k of Object.keys(v)){if(['__proto__','prototype','constructor'].includes(k))throw Error('Unsafe save property.');safeTree(v[k],depth+1);}
 return v;
}
export function decodeNativeSnapshot(text){
 const raw=safeTree(JSON.parse(text));
 if(raw.game!=='Poker Dynasty'||raw.backupVersion!==1)throw Error('Use a complete native Poker Dynasty Career backup.');
 const e=raw.snapshot;if(!e||e.format!=='PokerDynastySnapshot'||e.formatVersion!==1||!Number.isSafeInteger(e.seq)||e.seq<1||typeof e.payload!=='string')throw Error('Unsupported native snapshot envelope.');
 if(nativeChecksum(e.payload)!==e.checksum)throw Error('Native snapshot payload checksum mismatch.');
 const c=safeTree(JSON.parse(e.payload));
 if(!c||typeof c!=='object'||Array.isArray(c)||c.isCreated!==true||typeof c.activeName!=='string'||!c.activeName.trim())throw Error('Native Career identity is missing.');
 if(!Number.isInteger(c.generation)||c.generation<1)throw Error('Invalid Career generation.');
 if(c._saveSchema&&c._saveSchema>221)throw Error('Unsupported future native save schema.');
 for(const k of ['bankroll','debt','bankDebt'])if((k==='bankroll'||c[k]!=null)&&(!Number.isFinite(c[k])||c[k]<0||c[k]>1e12||Math.abs(c[k]*100-Math.round(c[k]*100))>.0001))throw Error('Invalid Career money: '+k);
 if(c._dynastyId&&e.identity!==c._dynastyId)throw Error('Native snapshot identity does not match its payload.');
 if(!c.world||typeof c.world.current!=='string'||typeof c.world.seed!=='string')throw Error('Native Career world is missing.');
 const year=Number(c.currentYear),month=Number(c.currentMonth),day=Number(c.day),minute=c.dailyLife55?.minuteOfDay??1080;
 if(!Number.isInteger(year)||year<1829||year>9998||!Number.isInteger(month)||month<1||month>12||!Number.isInteger(day)||day<1||day>31||!Number.isInteger(minute)||minute<0||minute>=1440)throw Error('Invalid native Career date.');
 const d=new Date(Date.UTC(year,month-1,day));if(d.getUTCFullYear()!==year||d.getUTCMonth()+1!==month||d.getUTCDate()!==day)throw Error('Invalid native Career calendar day.');
 const instant=Math.floor(d.getTime()/60000)+minute;
 return {raw,envelope:e,career:c,minute:instant,binding:c.multiplayerCareer84};
}
