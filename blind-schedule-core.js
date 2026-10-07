/* Poker Dynasty V83.4 progressive blind schedule.
 * Shared byte-for-byte by the server and the standalone game. Pure functions:
 * no timers, storage, networking, DOM, global poker state or random numbers.
 * Settings retain OPENING stakes. advance() returns stakes for a NEW hand.
 * Time starts at the first successful deal; a long gap queues one level only.
 */
(function (host) {
  'use strict';
  const VERSION = '83.4.0', MAX_BB = 1000000, MAX_CLOCK = 8640000000000000;
  const STANDARD = Object.freeze([20,30,40,50,60,80,100,150,200,300,400,600,800,1200,1600,2400,3200,5000,7500,10000,15000,20000,30000,40000,60000,80000,120000,160000,240000,320000,500000,750000,1000000]);
  const TURBO = Object.freeze([20,40,60,100,150,250,400,600,1000,1500,2500,4000,6000,10000,15000,25000,40000,60000,100000,150000,250000,400000,600000,1000000]);
  const integer = (v, fallback, lo, hi) => Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Math.floor(Number(v)))) : fallback;
  const clock = v => integer(v, 0, 0, MAX_CLOCK);
  function normalize(input = {}) {
    const blindMode = ['fixed','hands','minutes'].includes(input.blindMode) ? input.blindMode : 'fixed';
    const bb = integer(input.bb, 10, 2, MAX_BB);
    return {sb:integer(input.sb, Math.floor(bb / 2), 1, bb - 1),bb,
      ante:integer(input.ante, 0, 0, bb),blindMode,
      blindEvery:integer(input.blindEvery, 5, 1, blindMode === 'minutes' ? 180 : 1000),
      blindPace:input.blindPace === 'turbo' ? 'turbo' : 'standard'};
  }
  function key(input = {}) { const s = normalize(input); return JSON.stringify([s.sb,s.bb,s.ante,s.blindMode,s.blindEvery,s.blindPace]); }
  function ladder(input = {}) {
    const s = normalize(input), sequence = s.blindPace === 'turbo' ? TURBO : STANDARD;
    const values = [s.bb];
    for (let i = 1; i < 128 && values[values.length - 1] < MAX_BB; i++) {
      const prior = values[values.length - 1];
      const wanted = i < sequence.length ? Math.round(s.bb * sequence[i] / sequence[0]) : Math.ceil(prior * (s.blindPace === 'turbo' ? 1.5 : 4/3));
      values.push(Math.min(MAX_BB, Math.max(prior + 1, wanted)));
    }
    return values;
  }
  function levelSpec(input = {}, requestedLevel = 0) {
    const s = normalize(input), values = ladder(s), level = integer(requestedLevel, 0, 0, values.length - 1), bb = values[level];
    return {level,number:level + 1,sb:Math.max(1,Math.min(bb - 1,Math.round(s.sb * bb / s.bb))),bb,
      ante:s.ante === 0 ? 0 : Math.max(1,Math.min(bb,Math.round(s.ante * bb / s.bb))),capReached:level === values.length - 1};
  }
  function initial(input = {}, now = 0) {
    return {schema:1,configKey:key(input),level:0,startedAt:null,levelStartedAt:null,lastObservedAt:clock(now),handsStarted:0,levelStartHand:0,lastHandKey:null};
  }
  function readState(input, prior, now = 0) {
    if (!prior || prior.schema !== 1 || prior.configKey !== key(input)) return initial(input, now);
    const level = levelSpec(input, prior.level).level;
    const handsStarted = integer(prior.handsStarted, 0, 0, Number.MAX_SAFE_INTEGER - 1);
    return {schema:1,configKey:key(input),level,
      startedAt:prior.startedAt == null ? null : clock(prior.startedAt),
      levelStartedAt:prior.levelStartedAt == null ? null : clock(prior.levelStartedAt),
      lastObservedAt:Math.max(clock(prior.lastObservedAt),clock(now)),handsStarted,
      levelStartHand:integer(prior.levelStartHand, 0, 0, handsStarted),
      lastHandKey:prior.lastHandKey == null ? null : String(prior.lastHandKey).slice(0,128)};
  }
  function observe(input, prior, now = 0) { return readState(input, prior, now); }
  function status(input = {}, prior, options = {}) {
    const s = normalize(input), state = readState(s, prior, options.now), current = levelSpec(s, state.level);
    const started = state.startedAt !== null && state.handsStarted > 0, active = options.handActive === true;
    const handCount = started ? Math.max(0,state.handsStarted - state.levelStartHand - (active ? 1 : 0)) : 0;
    const handsRemaining = Math.max(0,s.blindEvery - handCount);
    const nextAt = started && s.blindMode === 'minutes' ? Math.min(MAX_CLOCK,state.levelStartedAt + s.blindEvery * 60000) : null;
    const remainingMs = nextAt == null ? null : Math.max(0,nextAt - state.lastObservedAt);
    const pending = started && s.blindMode !== 'fixed' && !current.capReached && (s.blindMode === 'hands' ? state.handsStarted - state.levelStartHand >= s.blindEvery : remainingMs === 0);
    return {schema:1,mode:s.blindMode,pace:s.blindPace,every:s.blindEvery,started,
      level:current.level,number:current.number,current,next:s.blindMode === 'fixed' || current.capReached ? null : levelSpec(s,state.level + 1),
      pending,handsRemaining:s.blindMode === 'hands' ? handsRemaining : null,remainingMs,nextAt,
      capReached:current.capReached,catchUp:'one-level-per-hand',clockAt:state.lastObservedAt,
      startedAt:state.startedAt,levelStartedAt:state.levelStartedAt,handsStarted:state.handsStarted};
  }
  function advance(input = {}, prior, options = {}) {
    const s = normalize(input), state = readState(s, prior, options.now), handKey = String(options.handKey == null ? state.handsStarted + 1 : options.handKey).slice(0,128);
    if (state.lastHandKey === handKey) return {state,current:levelSpec(s,state.level),changed:false};
    const now = state.lastObservedAt, first = state.startedAt === null || state.handsStarted === 0;
    const due = !first && status(s,state,{now,handActive:false}).pending;
    if (first) { state.startedAt = now; state.levelStartedAt = now; state.levelStartHand = 0; state.level = 0; }
    else if (due) { state.level = levelSpec(s,state.level + 1).level; state.levelStartedAt = now; state.levelStartHand = state.handsStarted; }
    state.handsStarted = Math.min(Number.MAX_SAFE_INTEGER - 1,state.handsStarted + 1);
    state.lastHandKey = handKey;
    return {state,current:levelSpec(s,state.level),changed:first || due};
  }
  function preview(input = {}, count = 5, fromLevel = 0) {
    const s = normalize(input), start = levelSpec(s,fromLevel).level, max = ladder(s).length;
    return Array.from({length:Math.min(integer(count,5,1,12),max - start)},(_,i)=>levelSpec(s,start + i));
  }
  const api = Object.freeze({version:VERSION,MAX_BB,MAX_CLOCK,STANDARD,TURBO,normalize,key,ladder,levelSpec,initial,observe,status,advance,preview});
  host.PDProgressiveBlinds84 = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
