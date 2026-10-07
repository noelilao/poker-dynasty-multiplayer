/** Poker Dynasty multiplayer rules authority. All monetary values are integer chips.
 * This module is independent of the single-player globals and never accepts a client
 * deck, payout, private-card replacement, turn deadline or stack balance.
 */
import { getVariant, createDeck, shuffle, evaluate, compare, exposedRank } from './cards.mjs';

const MAX_CHIPS = 1_000_000_000_000;
const EVENT_LIMIT = 240;
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const copyCard = c => ({ rank: c.rank, suit: c.suit, val: c.val, text: c.text || c.rank + c.suit });
const sum = xs => xs.reduce((n, x) => n + x, 0);
const specFor = g => getVariant(g.settings.variant);
const liveIndices = g => g.seats.flatMap((p, i) => p.inHand && !p.folded ? [i] : []);
const fundedIndices = g => liveIndices(g).filter(i => g.seats[i].stack > 0);

function integer(v, label, min = 0, max = MAX_CHIPS) {
  if (!Number.isSafeInteger(v) || v < min || v > max) throw new Error(`${label} must be an integer from ${min} to ${max}.`);
  return v;
}
function nowValue(now) { return integer(Math.trunc(now), 'Clock', 0, Number.MAX_SAFE_INTEGER); }
function nextAmong(g, from, indices) {
  const wanted = new Set(indices);
  for (let k = 1; k <= g.seats.length; k++) {
    const i = (from + k + g.seats.length) % g.seats.length;
    if (wanted.has(i)) return i;
  }
  return -1;
}
function clockwise(g, indices, from = g.button) {
  const n = g.seats.length;
  return indices.slice().sort((a, b) => ((a - from - 1 + n) % n) - ((b - from - 1 + n) % n));
}
function emit(g, type, now, extra = {}) {
  const event = { seq: ++g.eventSeq, handNo: g.handNo, type, street: g.street, at: now, ...extra };
  g.events.push(event);
  if (g.events.length > EVENT_LIMIT) g.events.splice(0, g.events.length - EVENT_LIMIT);
  return event;
}
function setDecision(g, phase, actor, now) {
  g.phase = phase;
  g.actor = actor;
  g.turnId++;
  g.deadline = now + g.settings.turnSeconds * 1000;
  g.decisionStarted = now;
  return g;
}
function post(g, seat, value, streetBet) {
  const p = g.seats[seat], amount = Math.min(p.stack, integer(value, 'Wager'));
  p.stack -= amount;
  p.total += amount;
  if (streetBet) p.bet += amount;
  p.allIn = p.stack === 0;
  g.pot += amount;
  return amount;
}
function take(g) {
  const c = g.deck.pop();
  if (!c) throw new Error('The legal deck cannot supply another card.');
  return c;
}
function burn(g, now, reason) {
  const c = take(g);
  g.burned.push(c);
  g.burnCount++;
  emit(g, 'burn', now, { count: 1, text: `One card burned before ${reason}.` });
}
function streetSpec(g) { return specFor(g).streets[g.streetIndex]; }
function isFixed(g) { return specFor(g).betting === 'fixed-limit'; }
function fourthStreetOption(g) {
  return g.settings.variant === 'stud7' && g.street === 'FOURTH' && liveIndices(g).some(i => {
    const p = g.seats[i], cards = p.hole.filter((_, k) => p.up[k]);
    return new Set(cards.map(c => c.val)).size < cards.length;
  });
}
function betUnit(g) {
  const spec = specFor(g);
  if (!isFixed(g)) return g.settings.bb;
  let big;
  if (g.settings.variant === 'stud7' && g.street === 'FOURTH' && g.studFourthBig) return g.settings.bb * 2;
  if (spec.bigBetFrom) big = g.streetIndex >= spec.streets.findIndex(s => s.id === spec.bigBetFrom);
  else if (spec.family === 'draw') big = g.streetIndex >= 2;
  else big = ['TURN', 'RIVER'].includes(g.street);
  return g.settings.bb * (big ? 2 : 1);
}
function callTarget(g, seat) {
  const others = liveIndices(g).filter(i => i !== seat);
  if (others.length && !others.some(i => g.seats[i].stack > 0)) {
    return Math.min(g.highBet, Math.max(0, ...others.map(i => g.seats[i].bet)));
  }
  return g.highBet;
}
function owed(g, seat) { return Math.max(0, callTarget(g, seat) - g.seats[seat].bet); }
function canReopen(g, p) {
  if (p.lastActionHigh === null || p.lastActionHigh === undefined) return true;
  if (p.lastActionHigh === 0 && g.highBet > 0) return true;
  const threshold = isFixed(g) ? Math.ceil(betUnit(g) / 2) : g.minRaise;
  return g.highBet - p.lastActionHigh >= threshold;
}
function normalizeSettings(input, spec) {
  const sb = integer(input.sb ?? 5, 'Small blind', 1, 1_000_000_000);
  const bb = integer(input.bb ?? 10, 'Big blind / small fixed bet', sb + 1, 2_000_000_000);
  return {
    variant: spec.id,
    sb, bb,
    ante: integer(input.ante ?? ((spec.family === 'stud' || spec.anteOnly) ? sb : 0), 'Ante', 0, bb),
    // Opening funding cap stays independent of later progressive blind levels.
    // Room creation still validates its initial buy-in against opening blinds.
    buyin: integer(input.buyin ?? bb * 100, 'Buy-in', 1, MAX_CHIPS),
    turnSeconds: integer(input.turnSeconds ?? 30, 'Decision timer', 10, 180),
    allowCheats: input.allowCheats === true,
    allowRebuys: input.allowRebuys !== false,
    limitRaiseCap: 4,
    runouts: 1,
    limitReopen: 'half-bet',
    oddChip: 'high-half-then-clockwise-left-of-button',
    uncalled: 'returned',
    drawTimeout: 'stand-pat',
    discardTimeout: 'last-card',
    tableMoney: 'play-chips'
  };
}

export function createGame(settings = {}, seats = []) {
  const spec = getVariant(settings.variant || 'holdem_nl');
  if (!spec) throw new Error('Unknown poker variant.');
  if (!Array.isArray(seats) || seats.length < 2 || seats.length > 9) throw new Error('A room needs between two and nine seats.');
  const normalized = normalizeSettings(settings, spec);
  const ids = new Set();
  const roster = seats.map((seat, i) => {
    const id = String(seat.id || `seat-${i}`).slice(0, 120);
    if (ids.has(id)) throw new Error('Every room seat needs a unique identity.');
    ids.add(id);
    return {
      id, name: String(seat.name || `Player ${i + 1}`).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 32),
      stack: integer(seat.stack ?? normalized.buyin, 'Starting stack'),
      bot: seat.bot === true, sittingOut: seat.sittingOut === true,
      bet: 0, total: 0, hole: [], up: [], folded: false, allIn: false,
      inHand: false, acted: false, lastActionHigh: null, action: '', draws: 0
    };
  });
  if (roster.filter(p => p.stack > 0 && !p.sittingOut).length > spec.seatCap) throw new Error(`${spec.name} allows ${spec.seatCap} active players under its deck rules.`);
  integer(sum(roster.map(p => p.stack)), 'Total table chips');
  return {
    schema: 1, settings: normalized, seats: roster,
    phase: 'idle', street: '', streetIndex: 0, board: [], deck: [], discards: [], burned: [],
    button: -1, sbSeat: null, bbSeat: null, bringInSeat: null,
    actor: -1, highBet: 0, minRaise: normalized.bb, turnId: 0, deadline: null,
    decisionStarted: null, handNo: 0, events: [], eventSeq: 0,
    settlement: null, pot: 0, bankTotal: sum(roster.map(p => p.stack)),
    startStacks: [], queue: [], drawnAfter: [], discardedAfter: [],
    fullBets: 0, roundPlayers: 0, burnCount: 0, sharedRiver: false,
    revealedAll: false, studFourthBig: false, revision: 0
  };
}

function resetRound(g) {
  for (const p of g.seats) {
    p.bet = 0;
    p.acted = false;
    p.lastActionHigh = null;
    p.action = p.folded ? 'FOLD' : p.allIn ? 'ALL-IN' : '';
  }
  g.highBet = 0;
  g.minRaise = betUnit(g);
  g.fullBets = 0;
  g.roundPlayers = liveIndices(g).length;
  g.studFourthBig = false;
}
function studBringIn(g) {
  const lowGame = specFor(g).id === 'razz';
  const suitValue = { '♣': 0, '♦': 1, '♥': 2, '♠': 3, c: 0, d: 1, h: 2, s: 3 };
  const candidates = liveIndices(g).filter(i => g.seats[i].hole.some((_, k) => g.seats[i].up[k]));
  candidates.sort((a, b) => {
    const A = g.seats[a].hole.find((_, k) => g.seats[a].up[k]);
    const B = g.seats[b].hole.find((_, k) => g.seats[b].up[k]);
    const av = lowGame && A.val === 14 ? 1 : A.val;
    const bv = lowGame && B.val === 14 ? 1 : B.val;
    return (lowGame ? bv - av : av - bv) || (lowGame ? suitValue[B.suit] - suitValue[A.suit] : suitValue[A.suit] - suitValue[B.suit]) || a - b;
  });
  return candidates[0] ?? -1;
}
function studFirst(g) {
  const low = specFor(g).id === 'razz';
  const candidates = clockwise(g, fundedIndices(g));
  let best = -1, rank = null;
  for (const i of candidates) {
    const p = g.seats[i], r = exposedRank(p.hole.filter((_, k) => p.up[k]), low);
    if (best < 0 || compare(r, rank) > 0) { best = i; rank = r; }
  }
  return best;
}

export function startHand(g, now = Date.now()) {
  now = nowValue(now);
  if (!g || !['idle', 'complete'].includes(g.phase)) throw new Error('Finish the current hand before dealing.');
  const spec = specFor(g), live = g.seats.flatMap((p, i) => !p.sittingOut && p.stack > 0 ? [i] : []);
  if (live.length < 2) throw new Error('At least two funded, seated players are required.');
  if (live.length > spec.seatCap) throw new Error(`${spec.name} allows ${spec.seatCap} active players.`);
  const stock = shuffle(createDeck(spec.id));
  const count = spec.family === 'stud' ? spec.initialCards : spec.holeCount;
  if (live.length * count > stock.length) throw new Error('Too many seats for the deck.');
  g.handNo++;
  g.revision++;
  g.button = nextAmong(g, g.button, live);
  g.sbSeat = g.bbSeat = g.bringInSeat = null;
  g.streetIndex = 0;
  g.street = spec.streets[0].id;
  g.deck = stock;
  g.discards = [];
  g.burned = [];
  g.burnCount = 0;
  g.board = [];
  g.queue = [];
  g.drawnAfter = [];
  g.discardedAfter = [];
  g.pot = 0;
  g.settlement = null;
  g.sharedRiver = false;
  g.revealedAll = false;
  g.startStacks = g.seats.map(p => p.stack);
  g.bankTotal = integer(sum(g.startStacks), 'Total table chips');
  const set = new Set(live);
  g.seats.forEach((p, i) => {
    p.inHand = set.has(i); p.folded = !p.inHand; p.allIn = false;
    p.hole = []; p.up = []; p.bet = 0; p.total = 0; p.acted = false;
    p.lastActionHigh = null; p.action = ''; p.draws = 0;
  });
  for (let k = 0; k < count; k++) for (const i of clockwise(g, live)) {
    g.seats[i].hole.push(take(g));
    g.seats[i].up.push(spec.family === 'stud' && (spec.id === 'stud5' ? k >= 1 : k === 2));
  }
  resetRound(g);
  emit(g, 'deal', now, { button: g.button, variant: spec.id, text: `${spec.name} · hand ${g.handNo}.` });
  if (streetSpec(g).boardCards) {
    burn(g, now, 'the opening board');
    for (let i = 0; i < streetSpec(g).boardCards; i++) g.board.push(take(g));
    emit(g, 'board', now, { cards: g.board.map(copyCard), text: 'Opening board card exposed before betting.' });
  }
  if (g.settings.ante) for (const i of live) {
    const amount = post(g, i, g.settings.ante, false);
    emit(g, 'ante', now, { seat: i, amount, text: `${g.seats[i].name} posts ante ${amount}.` });
  }
  let first;
  if (spec.family === 'stud') {
    const doorSeat = studBringIn(g);
    // An ante-all-in door card still determines the original bring-in. Its forced
    // payment passes clockwise, rather than being reassigned by another card rank.
    const bring = doorSeat >= 0 && g.seats[doorSeat].stack > 0 ? doorSeat : nextAmong(g, doorSeat, fundedIndices(g));
    if (bring >= 0) {
      const amount = post(g, bring, Math.max(1, Math.floor(g.settings.bb / 2)), true);
      g.bringInSeat = bring;
      g.highBet = amount;
      g.seats[bring].action = `BRING-IN ${amount}`;
      emit(g, 'bring-in', now, { seat: bring, amount, text: `${g.seats[bring].name} brings in ${amount}.` });
      first = nextAmong(g, bring, fundedIndices(g));
    } else first = -1;
  } else if (spec.anteOnly) {
    first = nextAmong(g, g.button, fundedIndices(g));
  } else {
    g.sbSeat = live.length === 2 ? g.button : nextAmong(g, g.button, live);
    g.bbSeat = nextAmong(g, g.sbSeat, live);
    for (const [i, value, tag] of [[g.sbSeat, g.settings.sb, 'SB'], [g.bbSeat, g.settings.bb, 'BB']]) {
      const amount = post(g, i, value, true);
      g.seats[i].action = `${tag} ${amount}`;
      emit(g, 'blind', now, { seat: i, amount, blind: tag, text: `${g.seats[i].name} posts ${tag} ${amount}.` });
    }
    g.highBet = g.settings.bb;
    g.fullBets = 1;
    first = nextAmong(g, g.bbSeat, fundedIndices(g));
  }
  g.phase = 'betting';
  progress(g, first, now);
  assertGame(g);
  return g;
}

export function legal(g, seatIndex) {
  const p = g?.seats?.[seatIndex];
  if (!p || seatIndex !== g.actor || !p.inHand || p.folded || !['betting', 'draw', 'discard'].includes(g.phase)) return [];
  if (g.phase === 'draw') return [{ type: 'draw', minCards: 0, maxCards: p.hole.length }];
  if (g.phase === 'discard') return [{ type: 'discard', minCards: 1, maxCards: 1 }];
  if (p.stack <= 0) return [];
  const call = owed(g, seatIndex), available = [{ type: call ? 'fold' : 'check' }];
  if (call) available.push({ type: 'call', amount: Math.min(call, p.stack), allIn: p.stack <= call });
  const spec = specFor(g), unit = betUnit(g), maxStack = p.bet + p.stack;
  const others = fundedIndices(g).filter(i => i !== seatIndex);
  const capped = isFixed(g) && g.roundPlayers > 2 && g.fullBets >= g.settings.limitRaiseCap;
  if (!others.length || p.stack <= call || !canReopen(g, p) || capped) return available;
  let fullTarget;
  if (isFixed(g)) fullTarget = g.highBet < unit ? unit : g.highBet + unit;
  else fullTarget = g.highBet < g.settings.bb ? g.settings.bb : g.highBet + g.minRaise;
  if (isFixed(g) && fourthStreetOption(g) && !g.studFourthBig) {
    const bigTarget = g.highBet < g.settings.bb ? g.settings.bb * 2 : g.highBet + g.settings.bb * 2;
    const targets = [...new Set([Math.min(maxStack, fullTarget), Math.min(maxStack, bigTarget)])].filter(to => to > g.highBet).sort((a, b) => a - b);
    if (targets.length) available.push({ type: 'raise', minTo: targets[0], maxTo: targets.at(-1), targets, allInOnly: maxStack < fullTarget, step: targets.length > 1 ? targets[1] - targets[0] : 1, option: 'stud-fourth-small-or-big' });
    return available;
  }
  let maximum = maxStack;
  if (spec.betting === 'pot-limit') maximum = Math.min(maximum, p.bet + call + g.pot + call);
  if (isFixed(g)) maximum = Math.min(maximum, fullTarget);
  if (maximum <= g.highBet) return available;
  const minimum = Math.min(fullTarget, maxStack);
  if (maximum < minimum) return available;
  available.push({ type: 'raise', minTo: minimum, maxTo: maximum, allInOnly: maxStack < fullTarget, step: 1 });
  return available;
}

function refundStreet(g, now) {
  const rows = g.seats.map((p, i) => ({ p, i })).sort((a, b) => b.p.bet - a.p.bet);
  if (rows.length < 2 || rows[0].p.folded || rows[0].p.bet <= rows[1].p.bet) return 0;
  const { p, i } = rows[0], amount = p.bet - rows[1].p.bet;
  p.bet -= amount; p.total -= amount; p.stack += amount; p.allIn = p.stack === 0; g.pot -= amount;
  g.highBet = Math.max(0, ...g.seats.map(q => q.bet));
  emit(g, 'refund', now, { seat: i, amount, text: `${p.name} receives ${amount} in uncalled chips.` });
  return amount;
}
function refillForDraw(g) {
  const eligible = g.discards.splice(0).concat(g.burned.splice(0));
  if (eligible.length) g.deck.push(...shuffle(eligible));
  return eligible.length;
}
function startChoiceRound(g, type, now) {
  g.queue = clockwise(g, liveIndices(g));
  if (type === 'draw') {
    g.drawnAfter.push(g.street);
    if (!g.deck.length) refillForDraw(g);
    if (g.deck.length) burn(g, now, 'the draw');
    emit(g, 'draw-round', now, { count: g.drawnAfter.length, text: `Draw round ${g.drawnAfter.length}: every live player chooses.` });
  } else {
    g.discardedAfter.push(g.street);
    emit(g, 'discard-round', now, { text: 'Pineapple: every live player discards one private card.' });
  }
  if (!g.queue.length) return nextStreet(g, now);
  return setDecision(g, type, g.queue.shift(), now);
}
function closeBetting(g, now) {
  refundStreet(g, now);
  const spec = specFor(g);
  if (spec.discardAfter === g.street && !g.discardedAfter.includes(g.street)) return startChoiceRound(g, 'discard', now);
  if (spec.drawAfter?.includes(g.street) && !g.drawnAfter.includes(g.street)) return startChoiceRound(g, 'draw', now);
  return nextStreet(g, now);
}
function nextStreet(g, now) {
  const spec = specFor(g);
  if (g.streetIndex + 1 >= spec.streets.length) return settle(g, true, now);
  g.streetIndex++;
  g.street = spec.streets[g.streetIndex].id;
  resetRound(g);
  if (spec.family === 'stud') {
    const live = clockwise(g, liveIndices(g)), seventh = spec.id !== 'stud5' && g.street === 'SEVENTH';
    // The physical stud shortage rule reserves a burn and one final unused card.
    // Recycle prior burns only when they restore an individual deal, or the stub
    // is too short even for an unbiased burn plus shared card (WSOP rule 232).
    let common = false;
    if (seventh && g.deck.length < live.length + 2) {
      common = g.deck.length + g.burned.length < live.length + 2;
      if (!common || g.deck.length <= 2) {
        g.deck.push(...g.burned.splice(0));
        shuffle(g.deck);
        emit(g, 'reshuffle', now, { text: 'Prior burn cards mixed with the remaining stock for seventh street.' });
      }
    }
    if (seventh && common) {
      burn(g, now, 'the shared seventh street');
      g.board.push(take(g));
      g.sharedRiver = true;
      emit(g, 'shared-river', now, { cards: g.board.map(copyCard), text: 'Insufficient stock: one exposed seventh card is shared by all live hands.' });
    } else {
      burn(g, now, g.street);
      for (const i of live) {
        g.seats[i].hole.push(take(g));
        g.seats[i].up.push(!seventh);
      }
    }
  } else if (streetSpec(g).boardCards) {
    // Courchevel's first flop card already used the flop burn before preflop.
    if (!(g.street === 'FLOP' && spec.streets[0].boardCards > 0)) burn(g, now, g.street);
    for (let k = 0; k < streetSpec(g).boardCards; k++) g.board.push(take(g));
    emit(g, 'board', now, { cards: g.board.map(copyCard), text: `${g.street}: ${g.board.map(c => c.text).join(' ')}` });
  }
  emit(g, 'street', now, { text: `${g.street} betting begins.` });
  g.phase = 'betting';
  const first = spec.family === 'stud' ? studFirst(g) : nextAmong(g, g.button, fundedIndices(g));
  return progress(g, first, now);
}
function progress(g, start, now) {
  const live = liveIndices(g);
  if (live.length <= 1) {
    refundStreet(g, now);
    return settle(g, false, now);
  }
  const funded = fundedIndices(g);
  if (!funded.length) return closeBetting(g, now);
  if (funded.length === 1) {
    const i = funded[0];
    if (!owed(g, i)) return closeBetting(g, now);
    return setDecision(g, 'betting', i, now);
  }
  for (let k = 0; k < g.seats.length; k++) {
    const i = ((start < 0 ? 0 : start) + k) % g.seats.length, p = g.seats[i];
    if (p.inHand && !p.folded && p.stack > 0 && (!p.acted || owed(g, i) > 0)) return setDecision(g, 'betting', i, now);
  }
  return closeBetting(g, now);
}

function validateIndices(indices, p, min, max) {
  if (!Array.isArray(indices) || indices.length < min || indices.length > max || indices.some(i => !Number.isInteger(i) || i < 0 || i >= p.hole.length) || new Set(indices).size !== indices.length) throw new Error('Invalid private-card selection.');
  return indices.slice().sort((a, b) => a - b);
}
function applyChoice(g, seat, action, now) {
  const p = g.seats[seat], discard = g.phase === 'discard';
  const indices = validateIndices(action.indices, p, discard ? 1 : 0, discard ? 1 : p.hole.length);
  const chosen = new Set(indices), dropped = p.hole.filter((_, i) => chosen.has(i));
  if (discard) {
    p.hole = p.hole.filter((_, i) => !chosen.has(i));
    p.up = p.up.filter((_, i) => !chosen.has(i));
    g.discards.push(...dropped);
    p.action = 'DISCARD 1';
    emit(g, 'discard', now, { seat, count: 1, text: `${p.name} discards one card.` });
  } else {
    const needed = indices.length;
    if (g.deck.length + g.discards.length + g.burned.length < needed) throw new Error('No legal replacement stock is available.');
    const replacement = [];
    while (replacement.length < needed) {
      if (!g.deck.length) {
        refillForDraw(g);
        emit(g, 'reshuffle', now, { text: 'Eligible prior discards and burns replenish the draw stock.' });
      }
      replacement.push(take(g));
    }
    let n = 0;
    p.hole = p.hole.map((c, i) => chosen.has(i) ? replacement[n++] : c);
    // Current discards enter the muck only after replacements; never redraw one's own just-discarded cards.
    g.discards.push(...dropped);
    p.draws += needed;
    p.action = needed ? `DRAW ${needed}` : 'STAND PAT';
    emit(g, 'draw', now, { seat, count: needed, text: `${p.name} ${needed ? `draws ${needed}` : 'stands pat'}.` });
  }
  if (g.queue.length) return setDecision(g, discard ? 'discard' : 'draw', g.queue.shift(), now);
  return nextStreet(g, now);
}

function applyAction(g, seatIndex, action, now, enforceDeadline = true) {
  now = nowValue(now);
  if (!action || typeof action !== 'object' || Array.isArray(action)) throw new Error('An action object is required.');
  integer(seatIndex, 'Seat', 0, g.seats.length - 1);
  if (seatIndex !== g.actor) throw new Error('It is not this seat’s turn.');
  if (enforceDeadline && g.deadline !== null && now >= g.deadline) throw new Error('The decision timer has expired.');
  if (own(action, 'turnId') && action.turnId !== g.turnId) throw new Error('That decision has expired.');
  if (own(action, 'handNo') && action.handNo !== g.handNo) throw new Error('That hand has ended.');
  const permitted = legal(g, seatIndex), entry = permitted.find(a => a.type === action.type);
  if (!entry) throw new Error('That action is not legal in the current decision.');
  const p = g.seats[seatIndex];
  if (action.type === 'raise') {
    integer(action.target, 'Raise-to amount');
    if (action.target < entry.minTo || action.target > entry.maxTo) throw new Error(`Raise to an amount from ${entry.minTo} to ${entry.maxTo}.`);
    if (entry.targets && !entry.targets.includes(action.target)) throw new Error(`The paired-board Stud option allows only ${entry.targets.join(' or ')} total chips.`);
  }
  if (g.phase === 'draw' || g.phase === 'discard') {
    applyChoice(g, seatIndex, action, now);
    g.revision++;
    assertGame(g);
    return g;
  }
  let paid = 0;
  const oldHigh = g.highBet, oldMin = g.minRaise;
  let unit = betUnit(g);
  if (action.type === 'fold') {
    p.folded = true;
    p.action = 'FOLD';
  } else if (action.type === 'check') p.action = 'CHECK';
  else if (action.type === 'call') {
    paid = post(g, seatIndex, owed(g, seatIndex), true);
    p.action = p.allIn ? `CALL ALL-IN ${p.bet}` : `CALL ${paid}`;
  } else if (action.type === 'raise') {
    if (entry.option === 'stud-fourth-small-or-big') {
      const smallTarget = oldHigh < g.settings.bb ? g.settings.bb : oldHigh + g.settings.bb;
      if (action.target > smallTarget) {
        g.studFourthBig = true;
        unit = g.settings.bb * 2;
        g.minRaise = unit;
        emit(g, 'limit-change', now, { seat: seatIndex, amount: unit, text: `${p.name} chooses the big-bet option on fourth street; ${unit}-chip bets apply for this street.` });
      }
    }
    paid = post(g, seatIndex, action.target - p.bet, true);
    g.highBet = p.bet;
    const increase = g.highBet - oldHigh;
    const full = isFixed(g) ? (oldHigh < unit ? g.highBet >= unit : increase >= unit) : (oldHigh < g.settings.bb ? g.highBet >= g.settings.bb : increase >= oldMin);
    if (isFixed(g)) {
      if (full || (oldHigh >= unit && increase >= Math.ceil(unit / 2))) g.fullBets++;
    } else if (full) g.minRaise = oldHigh < g.settings.bb ? g.highBet : increase;
    p.action = p.allIn ? `ALL-IN ${p.bet}` : `${oldHigh ? 'RAISE TO' : 'BET'} ${p.bet}`;
  }
  p.acted = true;
  p.lastActionHigh = g.highBet;
  emit(g, 'action', now, { seat: seatIndex, action: action.type, amount: paid, to: action.type === 'raise' ? p.bet : undefined, text: `${p.name}: ${p.action}.` });
  g.revision++;
  progress(g, (seatIndex + 1) % g.seats.length, now);
  assertGame(g);
  return g;
}

export function act(g, seatIndex, action, now = Date.now()) {
  return applyAction(g, seatIndex, action, now, true);
}

function distribute(g, amount, recipients, payouts) {
  const order = clockwise(g, recipients);
  if (!order.length) throw new Error('A pot has no eligible winner.');
  const share = Math.floor(amount / order.length), extra = amount % order.length;
  order.forEach((i, k) => payouts[i] += share + (k < extra ? 1 : 0));
  return order;
}
function bestSeats(rows, key) {
  const eligible = rows.filter(x => Array.isArray(x.value[key]));
  if (!eligible.length) return [];
  let best = eligible[0].value[key];
  for (const row of eligible) if (compare(row.value[key], best) > 0) best = row.value[key];
  return eligible.filter(row => compare(row.value[key], best) === 0).map(row => row.seat);
}
function settle(g, showdown, now) {
  if (g.phase === 'complete' || g.settlement) throw new Error('Duplicate settlement rejected.');
  const live = liveIndices(g);
  if (!live.length) throw new Error('No eligible live hand remains.');
  const pot = g.pot, committed = g.seats.map(p => p.total), payouts = g.seats.map(() => 0);
  if (sum(committed) !== pot) throw new Error('The pot and committed chips disagree.');
  const tiers = [], levels = [...new Set(committed.filter(x => x > 0))].sort((a, b) => a - b);
  let previous = 0;
  for (const level of levels) {
    const donors = committed.flatMap((value, i) => value >= level ? [i] : []);
    const eligible = donors.filter(i => !g.seats[i].folded && g.seats[i].inHand);
    const amount = donors.length * (level - previous);
    previous = level;
    if (eligible.length) tiers.push({ amount, eligible });
    else if (tiers.length) tiers.at(-1).amount += amount;
    else if (amount) tiers.push({ amount, eligible: live.slice() });
  }
  const results = {};
  if (showdown) for (const i of live) results[i] = evaluate(g.settings.variant, g.seats[i].hole, g.board);
  const pots = [];
  for (const tier of tiers) {
    const rows = tier.eligible.map(seat => ({ seat, value: results[seat] }));
    const highWinners = showdown ? bestSeats(rows, 'high') : tier.eligible;
    const lowWinners = showdown ? bestSeats(rows, 'low') : [];
    const highAmount = lowWinners.length ? Math.ceil(tier.amount / 2) : tier.amount;
    const lowAmount = tier.amount - highAmount;
    const highOrder = distribute(g, highAmount, highWinners, payouts);
    const lowOrder = lowWinners.length ? distribute(g, lowAmount, lowWinners, payouts) : [];
    pots.push({ amount: tier.amount, eligible: tier.eligible.slice(), highWinners: highOrder, lowWinners: lowOrder, highAmount, lowAmount });
  }
  if (sum(payouts) !== pot) throw new Error('Payouts do not conserve the pot.');
  for (let i = 0; i < g.seats.length; i++) { g.seats[i].stack += payouts[i]; g.seats[i].bet = 0; }
  g.pot = 0;
  g.phase = 'complete';
  g.actor = -1;
  g.deadline = null;
  g.turnId++;
  g.queue = [];
  if (showdown) g.street = 'SHOWDOWN';
  g.settlement = { handNo: g.handNo, pot, showdown, payouts, pots, net: g.seats.map((p, i) => p.stack - g.startStacks[i]), committed, finalStacks: g.seats.map(p => p.stack),
    handRanks: g.seats.map((_, i) => results[i] ? { high: results[i].highLabel || '', low: results[i].lowLabel || null } : null), at: now };
  const winners = payouts.flatMap((amount, i) => amount ? [`${g.seats[i].name} collects ${amount}`] : []);
  emit(g, 'settlement', now, { showdown, payouts: payouts.slice(), text: winners.join(' · ') || 'Hand completed without a contested pot.' });
  g.revision++;
  assertGame(g);
  return g;
}

export function tick(g, now = Date.now()) {
  now = nowValue(now);
  if (!['betting', 'draw', 'discard'].includes(g.phase) || g.actor < 0 || g.deadline === null || now < g.deadline) return false;
  const seat = g.actor, p = g.seats[seat], decision = g.turnId;
  const action = g.phase === 'draw' ? { type: 'draw', indices: [] } : g.phase === 'discard' ? { type: 'discard', indices: [p.hole.length - 1] } : { type: legal(g, seat).some(x => x.type === 'check') ? 'check' : 'fold' };
  emit(g, 'timeout', now, { seat, turnId: decision, action: action.type, text: `${p.name}'s timer expired: ${action.type === 'draw' ? 'stand pat' : action.type === 'discard' ? 'last card discarded' : action.type}.` });
  applyAction(g, seat, { ...action, turnId: decision }, now, false);
  return true;
}

export function publicView(g, seatIndex = -1) {
  const viewer = Number.isInteger(seatIndex) && seatIndex >= 0 && seatIndex < g.seats.length ? seatIndex : -1;
  const spec = specFor(g), n = g.seats.length, offset = viewer >= 0 ? viewer : 0;
  const remap = i => i == null || i < 0 ? i : (i - offset + n) % n;
  const order = Array.from({ length: n }, (_, i) => (i + offset) % n);
  const cheatReveal = g.settings.allowCheats && g.revealedAll === true;
  const publicSeats = order.map(i => {
    const p = g.seats[i], reveal = i === viewer || cheatReveal || (g.settlement?.showdown && p.inHand && !p.folded);
    return {
      seatIndex: i, id: p.id, name: p.name, style: p.bot ? 'AMATEUR' : 'HUMAN', bot: p.bot,
      chips: p.stack, stack: p.stack, bet: p.bet, total: p.total,
      folded: p.folded, allIn: p.allIn, sittingOut: p.sittingOut, inHand: p.inHand,
      action: p.action, stats: p.bot ? 'BOT' : 'HUMAN', tilt: 0, tell: '',
      up: p.up.slice(), cards: p.hole.map((c, k) => reveal || p.up[k] ? copyCard(c) : null)
    };
  });
  const events = g.events.map(event => {
    const out = { ...event };
    if (Number.isInteger(event.seat)) { out.seatIndex = event.seat; out.seat = remap(event.seat); }
    if (Number.isInteger(event.button)) out.button = remap(event.button);
    if (event.cards) out.cards = event.cards.map(copyCard);
    if (event.payouts) out.payouts = order.map(i => event.payouts[i]);
    return out;
  });
  const settlement = g.settlement ? {
    handNo: g.settlement.handNo, pot: g.settlement.pot, showdown: g.settlement.showdown,
    payouts: order.map(i => g.settlement.payouts[i]), net: order.map(i => g.settlement.net[i]),
    committed: order.map(i => g.settlement.committed[i]), finalStacks: order.map(i => g.settlement.finalStacks[i]),
    handRanks: order.map(i => g.settlement.handRanks?.[i] ? { ...g.settlement.handRanks[i] } : null),
    at: g.settlement.at, pots: g.settlement.pots.map(p => ({ ...p, eligible: p.eligible.map(remap), highWinners: p.highWinners.map(remap), lowWinners: p.lowWinners.map(remap) }))
  } : null;
  return {
    id: `mp-${g.handNo}`, handNo: g.handNo, revision: g.revision,
    variant: spec.id, name: spec.name, family: spec.family, phase: g.phase, street: g.street,
    settings: { ...g.settings }, betting: spec.betting, seatCap: spec.seatCap,
    board: g.board.map(copyCard), boards: [g.board.map(copyCard)], pot: g.pot,
    tournament: false, career: false, practice: true, multiplayer: true, digital: true,
    toCall: viewer >= 0 && g.phase === 'betting' ? Math.min(g.seats[viewer].stack, owed(g, viewer)) : 0,
    chipUnit: g.settings.bb, smallBlind: g.settings.sb, actor: remap(g.actor), actorSeat: g.actor,
    button: remap(g.button), viewerSeat: viewer,
    positions: { dealer: remap(g.button), sb: remap(g.sbSeat), bb: remap(g.bbSeat), bringIn: remap(g.bringInSeat) },
    done: g.phase === 'complete', turnId: g.turnId, deadline: g.deadline,
    legal: viewer >= 0 ? legal(g, viewer).map(x => ({ ...x })) : [],
    burns: g.burnCount, dealOrder: [], payouts: settlement?.payouts || [],
    players: publicSeats, events, settlement, sharedRiver: g.sharedRiver,
    cheats: { allowed: g.settings.allowCheats, allCardsVisible: cheatReveal },
    rules: {
      text: spec.rules || spec.rule || spec.notes || '', runouts: 1, playMoney: true,
      fixedLimit: 'One bet and three full raises per multiway street; no cap when a street starts heads-up. Half-bet all-ins reopen limit action.',
      studPair: 'In high-only Seven-Card Stud, an exposed pair on fourth street allows either a small or big wager. A chosen big wager applies for the remainder of that street.',
      draws: 'Draws and Pineapple discards remain human decisions after an all-in. Earlier discards may replenish an exhausted stock; a player cannot immediately redraw a card they just discarded.',
      timeout: 'Check when legal; otherwise fold. Draw timeout stands pat. Pineapple timeout discards the last card.',
      oddChips: 'High receives the odd chip in high/low splits. Tied halves distribute odd chips clockwise left of the dealer.',
      hostRules: g.settings.allowCheats ? 'Room host cheats are enabled and any reveal is visible to every participant.' : 'Host cheats are disabled.'
    }
  };
}

export function assertGame(g) {
  if (!g || !Array.isArray(g.seats)) throw new Error('Invalid game state.');
  for (const p of g.seats) {
    for (const [name, value] of Object.entries({ stack: p.stack, bet: p.bet, total: p.total })) integer(value, `Player ${name}`);
    if (p.bet > p.total) throw new Error('Street bet exceeds total commitment.');
    if (p.hole.length !== p.up.length) throw new Error('Private-card visibility shape mismatch.');
  }
  integer(g.pot, 'Pot');
  if (sum(g.seats.map(p => p.stack)) + g.pot !== g.bankTotal) throw new Error('Table chips were created or lost.');
  if (['betting', 'draw', 'discard'].includes(g.phase) && sum(g.seats.map(p => p.total)) !== g.pot) throw new Error('Pot does not equal committed chips.');
  const cards = [...g.deck, ...g.discards, ...g.burned, ...g.board, ...g.seats.flatMap(p => p.hole)];
  const ids = cards.map(c => c.text || c.rank + c.suit);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate card in custody.');
  if (g.handNo && cards.length !== createDeck(g.settings.variant).length) throw new Error('Cards were created or lost.');
  if (['betting', 'draw', 'discard'].includes(g.phase) && (!Number.isInteger(g.actor) || !legal(g, g.actor).length)) throw new Error('An active decision has no legal action.');
  return true;
}
