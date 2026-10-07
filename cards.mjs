/**
 * Poker Dynasty V83 multiplayer card rules.
 *
 * The 25 identifiers, deck restrictions, hand selections and ranking conventions
 * continue the attached V82.7.2 registry. This file has no DOM or game-state
 * dependencies. Ranking vectors always compare with the larger vector winning.
 * A pure lowball game places its winning lowball vector in `high`; only split
 * games populate `low`. Evaluating an incomplete or impossible showdown throws.
 */

export const RANKS = Object.freeze([...'23456789TJQKA']);
export const SUITS = Object.freeze(['♠', '♥', '♦', '♣']);
export const SUIT_ORDER = Object.freeze({ '♣': 0, '♦': 1, '♥': 2, '♠': 3 });
const SHORT_RANKS = Object.freeze([...'6789TJQKA']);
const EARLY_RANKS = Object.freeze([...'TJQKA']);
const SUIT_ALIASES = Object.freeze({ s: '♠', h: '♥', d: '♦', c: '♣', '♠': '♠', '♥': '♥', '♦': '♦', '♣': '♣' });
const VALUES = Object.freeze(Object.fromEntries(RANKS.map((rank, i) => [rank, i + 2])));

const communityStreets = door => [
  { id: 'PREFLOP', boardCards: door ? 1 : 0 },
  { id: 'FLOP', boardCards: door ? 2 : 3 },
  { id: 'TURN', boardCards: 1 },
  { id: 'RIVER', boardCards: 1 },
];
const drawStreets = triple => (triple
  ? ['PREDRAW', 'DRAW1', 'DRAW2', 'DRAW3']
  : ['PREDRAW', 'POSTDRAW']).map(id => ({ id, boardCards: 0 }));
const studStreets = five => (five
  ? ['SECOND', 'THIRD', 'FOURTH', 'FIFTH']
  : ['THIRD', 'FOURTH', 'FIFTH', 'SIXTH', 'SEVENTH']).map(id => ({ id, boardCards: 0 }));

function variant(spec) {
  const complete = {
    discardAfter: null, drawAfter: [], anteOnly: false, initialCards: spec.holeCount,
    bigBetFrom: null, lowOnly: false, split: false, exactlyTwo: false,
    historicalReconstruction: false, shortDeck: false, flushAllowed: true,
    straightAllowed: true, deckRanks: RANKS, ...spec,
  };
  complete.maxSeats = complete.seatCap;
  complete.deckSize = complete.deckRanks.length * SUITS.length;
  complete.showdown = complete.split ? 'high-low' : complete.lowOnly ? 'low' : 'high';
  complete.highLow = complete.split;
  complete.deck = Object.freeze({ ranks: complete.deckRanks, suits: SUITS });
  complete.streets = Object.freeze(complete.streets.map(Object.freeze));
  complete.drawAfter = Object.freeze(complete.drawAfter.slice());
  return Object.freeze(complete);
}

const ENTRIES = [
  { id: 'holdem_nl', name: "No-Limit Texas Hold'em", short: 'NLH', family: 'community',
    betting: 'no-limit', holeCount: 2, seatCap: 9, streets: communityStreets(false),
    rules: 'Best five cards from any combination of your two private cards and five community cards.' },
  { id: 'holdem_fl', name: "Fixed-Limit Texas Hold'em", short: 'LHE', family: 'community',
    betting: 'fixed-limit', holeCount: 2, seatCap: 9, streets: communityStreets(false), bigBetFrom: 'TURN',
    rules: 'Hold’em hand selection; fixed small bets preflop and flop, double-sized bets on turn and river.' },
  { id: 'plo', name: 'Pot-Limit Omaha (PLO)', short: 'PLO', family: 'community',
    betting: 'pot-limit', holeCount: 4, seatCap: 9, streets: communityStreets(false), exactlyTwo: true,
    rules: 'Four private cards. Use exactly two private cards and exactly three community cards.' },
  { id: 'plo8', name: 'Omaha Hi-Lo 8-or-Better (PLO8)', short: 'PLO8', family: 'community',
    betting: 'pot-limit', holeCount: 4, seatCap: 9, streets: communityStreets(false), exactlyTwo: true, split: true,
    rules: 'Exactly two private plus three community cards for each half. Five distinct ranks eight or lower qualify for low; aces low. No qualifying low means high wins all.' },
  { id: 'omaha8_fl', name: 'Fixed-Limit Omaha Hi-Lo', short: 'O8', family: 'community',
    betting: 'fixed-limit', holeCount: 4, seatCap: 9, streets: communityStreets(false), bigBetFrom: 'TURN', exactlyTwo: true, split: true,
    rules: 'Four-card Omaha, exactly two plus three for high and eight-or-better low. Fixed small bets preflop/flop and double-sized bets turn/river.' },
  { id: 'plo5', name: '5-Card Pot-Limit Omaha', short: '5-PLO', family: 'community',
    betting: 'pot-limit', holeCount: 5, seatCap: 8, streets: communityStreets(false), exactlyTwo: true,
    rules: 'Five private cards. Exactly two private plus three community cards play. Eight seats maximum.' },
  { id: 'plo6', name: '6-Card Pot-Limit Omaha', short: '6-PLO', family: 'community',
    betting: 'pot-limit', holeCount: 6, seatCap: 7, streets: communityStreets(false), exactlyTwo: true,
    rules: 'Six private cards. Exactly two private plus three community cards play. Seven seats maximum.' },
  { id: 'big_o', name: 'Big O (5-Card PLO Hi-Lo)', short: 'BIG O', family: 'community',
    betting: 'pot-limit', holeCount: 5, seatCap: 8, streets: communityStreets(false), exactlyTwo: true, split: true,
    rules: 'Five-card Omaha high/low. Exactly two plus three for each half; five distinct eight-or-lower ranks qualify for low. High wins all when no low qualifies.' },
  { id: 'courchevel', name: 'Courchevel (Pot Limit)', short: 'COUR', family: 'community',
    betting: 'pot-limit', holeCount: 5, seatCap: 8, streets: communityStreets(true), exactlyTwo: true,
    rules: 'Five private cards. The first flop card is exposed before preflop betting; two more complete the flop. Exactly two plus three play.' },
  { id: 'courchevel8', name: 'Courchevel Hi-Lo 8-or-Better', short: 'COUR8', family: 'community',
    betting: 'pot-limit', holeCount: 5, seatCap: 8, streets: communityStreets(true), exactlyTwo: true, split: true,
    rules: 'Courchevel with a qualifying eight-or-better low. The first flop card is exposed before betting; exactly two plus three for each half.' },
  { id: 'pineapple', name: 'Pineapple', short: 'PINE', family: 'community',
    betting: 'no-limit', holeCount: 3, seatCap: 9, streets: communityStreets(false), discardAfter: 'PREFLOP',
    rules: 'Three private cards. Discard exactly one after preflop betting and before the flop; continue with two cards.' },
  { id: 'crazy_pineapple', name: 'Crazy Pineapple', short: 'CRAZY', family: 'community',
    betting: 'no-limit', holeCount: 3, seatCap: 9, streets: communityStreets(false), discardAfter: 'FLOP',
    rules: 'Three private cards through flop betting. Discard exactly one before the turn; continue with two cards.' },
  { id: 'shortdeck', name: 'Short Deck / 6+ Hold’em', short: '6+', family: 'community',
    betting: 'no-limit', holeCount: 2, seatCap: 6, streets: communityStreets(false), shortDeck: true, deckRanks: SHORT_RANKS,
    rules: '36 cards, ranks six through ace. A-6-7-8-9 is the lowest straight; a flush beats a full house, and a straight beats trips. Poker Dynasty uses small and big blinds.' },
  { id: 'stud7', name: 'Seven-Card Stud', short: '7-STUD', family: 'stud',
    betting: 'fixed-limit', holeCount: 7, initialCards: 3, seatCap: 8, streets: studStreets(false), bigBetFrom: 'FIFTH',
    rules: 'Two down and one up to start, then up/up/up/down. Antes and low-card bring-in; best five cards win. A shared final card is used when the deck cannot finish individual seventh cards.' },
  { id: 'stud7_hilo', name: 'Seven-Card Stud Hi-Lo 8-or-Better', short: 'STUD8', family: 'stud',
    betting: 'fixed-limit', holeCount: 7, initialCards: 3, seatCap: 8, streets: studStreets(false), bigBetFrom: 'FIFTH', split: true,
    rules: 'Seven-card Stud with high and eight-or-better low. Select the best five separately for each half; aces low and straights/flushes ignored for low.' },
  { id: 'stud5', name: 'Five-Card Stud', short: '5-STUD', family: 'stud',
    betting: 'fixed-limit', holeCount: 5, initialCards: 2, seatCap: 9, streets: studStreets(true), bigBetFrom: 'FOURTH',
    rules: 'One down and one up to start, then three more exposed cards. Antes and low-card bring-in; all five cards play.' },
  { id: 'razz', name: 'Razz', short: 'RAZZ', family: 'stud',
    betting: 'fixed-limit', holeCount: 7, initialCards: 3, seatCap: 8, streets: studStreets(false), bigBetFrom: 'FIFTH', lowOnly: true, lowRule: 'ace-to-five',
    rules: 'Seven-card A-to-5 low Stud. Highest upcard brings in, lowest exposed hand acts first later. Aces low, straights/flushes ignored, no qualifier; A-2-3-4-5 is best.' },
  { id: 'draw5', name: 'Five-Card Draw (No-Limit)', short: '5CD', family: 'draw',
    betting: 'no-limit', holeCount: 5, seatCap: 8, streets: drawStreets(false), drawAfter: ['PREDRAW'],
    rules: 'Five private cards and one draw. Choose any number of cards to replace, including standing pat. Best five-card high hand wins.' },
  { id: 'deuce_single', name: '2-7 Single Draw (No-Limit)', short: '2-7 SD', family: 'draw',
    betting: 'no-limit', holeCount: 5, seatCap: 7, streets: drawStreets(false), drawAfter: ['PREDRAW'], lowOnly: true, lowRule: 'deuce-to-seven',
    rules: 'Five cards and one draw. Lowest hand wins; aces are high, straights and flushes count against you. Unsuited 7-5-4-3-2 is best.' },
  { id: 'deuce_triple', name: '2-7 Triple Draw Lowball', short: '2-7 TD', family: 'draw',
    betting: 'fixed-limit', holeCount: 5, seatCap: 6, streets: drawStreets(true), drawAfter: ['PREDRAW', 'DRAW1', 'DRAW2'], bigBetFrom: 'DRAW2', lowOnly: true, lowRule: 'deuce-to-seven',
    rules: 'Five cards, three draws, fixed limit. Aces high and straights/flushes penalized. Unsuited 7-5-4-3-2 is best; bets double after the second draw.' },
  { id: 'ace5_triple', name: 'A-to-5 Triple Draw Lowball', short: 'A-5 TD', family: 'draw',
    betting: 'fixed-limit', holeCount: 5, seatCap: 6, streets: drawStreets(true), drawAfter: ['PREDRAW', 'DRAW1', 'DRAW2'], bigBetFrom: 'DRAW2', lowOnly: true, lowRule: 'ace-to-five',
    rules: 'Five cards, three draws, fixed limit. Aces low; straights and flushes ignored. A-2-3-4-5 is best; bets double after the second draw.' },
  { id: 'badugi', name: 'Badugi (Fixed Limit)', short: 'BADUGI', family: 'draw',
    betting: 'fixed-limit', holeCount: 4, seatCap: 8, streets: drawStreets(true), drawAfter: ['PREDRAW', 'DRAW1', 'DRAW2'], bigBetFrom: 'DRAW2', lowOnly: true, lowRule: 'badugi',
    rules: 'Four cards and three draws. Use the largest subset with all different ranks and suits, then the lowest ranks. Aces low. Every four-card Badugi beats every three-card hand.' },
  { id: 'early20', name: 'Early 20-Card Poker · no draw', short: '20-CARD', family: 'draw',
    betting: 'no-limit', holeCount: 5, seatCap: 4, streets: [{ id: 'DEAL', boardCards: 0 }], anteOnly: true,
    historicalReconstruction: true, deckRanks: EARLY_RANKS, straightAllowed: false, flushAllowed: false,
    rules: 'Historical house-rule reconstruction. Twenty cards, ten through ace. Five private cards, antes, one betting round, no draw. Straights and flushes do not count.' },
  { id: 'straight52', name: 'Early 52-Card Poker · no draw', short: '52-CARD', family: 'draw',
    betting: 'no-limit', holeCount: 5, seatCap: 8, streets: [{ id: 'DEAL', boardCards: 0 }], anteOnly: true,
    historicalReconstruction: true, straightAllowed: false,
    rules: 'Historical house-rule reconstruction. Fifty-two cards, five private cards, antes, one betting round, no draw. Flushes count; straights do not.' },
  { id: 'draw5_early', name: 'Early Five-Card Draw · no straights', short: 'EARLY DRAW', family: 'draw',
    betting: 'no-limit', holeCount: 5, seatCap: 8, streets: drawStreets(false), drawAfter: ['PREDRAW'], anteOnly: true,
    historicalReconstruction: true, straightAllowed: false,
    rules: 'Historical house-rule reconstruction. Five private cards, antes and one draw. Flushes count; straights do not.' },
];

export const VARIANTS = Object.freeze(Object.fromEntries(ENTRIES.map(entry => [entry.id, variant(entry)])));

export function getVariant(id) {
  const key = typeof id === 'object' && id !== null ? id.id : id;
  if (typeof key !== 'string' || !Object.hasOwn(VARIANTS, key)) throw new Error('Unknown poker variant');
  return VARIANTS[key];
}

/** Parse a display token or validate an existing card; never trust a supplied val. */
export function card(input) {
  let rank, suit;
  if (typeof input === 'string') {
    const match = /^(10|[2-9TJQKA])([shdc♠♥♦♣])$/i.exec(input.trim());
    if (!match) throw new Error('Invalid card token');
    rank = match[1].toUpperCase();
    suit = match[2].toLowerCase();
  } else if (input && typeof input === 'object') {
    rank = String(input.rank ?? '').toUpperCase();
    suit = String(input.suit ?? '').toLowerCase();
  } else throw new Error('Invalid card');
  if (rank === '10') rank = 'T';
  suit = SUIT_ALIASES[suit];
  if (!Object.hasOwn(VALUES, rank) || !suit) throw new Error('Invalid card rank or suit');
  const val = VALUES[rank];
  if (typeof input === 'object' && input.val !== undefined && input.val !== val) throw new Error('Card rank/value mismatch');
  return { rank, suit, val, text: rank + suit };
}

/** A fresh physical deck. Shuffling is explicit so callers cannot confuse order. */
export function createDeck(id) {
  const spec = getVariant(id);
  return SUITS.flatMap(suit => spec.deckRanks.map(rank => ({ rank, suit, val: VALUES[rank], text: rank + suit })));
}
export const makeDeck = createDeck;

/** Uniform bounded integer; discard the biased tail of the 32-bit interval. */
export function secureInt(upperExclusive) {
  if (!Number.isSafeInteger(upperExclusive) || upperExclusive < 1 || upperExclusive > 0x100000000) throw new Error('Invalid random bound');
  const rng = globalThis.crypto;
  if (!rng || typeof rng.getRandomValues !== 'function') throw new Error('Secure randomness is unavailable');
  const sample = new Uint32Array(1);
  const limit = 0x100000000 - (0x100000000 % upperExclusive);
  do { rng.getRandomValues(sample); } while (sample[0] >= limit);
  return sample[0] % upperExclusive;
}

/** Cryptographic Fisher–Yates; mutates and returns the provided array. */
export function shuffle(cards) {
  if (!Array.isArray(cards)) throw new Error('Shuffle requires an array');
  for (let i = cards.length - 1; i > 0; i--) {
    const j = secureInt(i + 1);
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

export function compare(a, b) {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : -1;
  if (b === null || b === undefined) return 1;
  if (!Array.isArray(a) || !Array.isArray(b)) throw new Error('Rank vectors must be arrays');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? 0, bv = b[i] ?? 0;
    if (!Number.isFinite(av) || !Number.isFinite(bv)) throw new Error('Invalid rank vector');
    if (av !== bv) return av > bv ? 1 : -1;
  }
  return 0;
}
export const compareRanks = compare;

const desc = values => values.slice().sort((a, b) => b - a);
const inverse = value => 15 - value;
const lowValue = c => c.val === 14 ? 1 : c.val;

function groups(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || b.value - a.value);
}

function straightHigh(values, shortDeck = false, aceLow = true) {
  const unique = desc([...new Set(values)]);
  if (aceLow && !shortDeck && unique.includes(14)) unique.push(1);
  for (let i = 0; i + 4 < unique.length; i++) if (unique[i] - unique[i + 4] === 4) return unique[i];
  if (shortDeck && [14, 9, 8, 7, 6].every(v => unique.includes(v))) return 9;
  return 0;
}

/** Five-card high, including the native short-deck/historical conventions. */
function highFive(cards, spec) {
  const values = desc(cards.map(c => c.val)), group = groups(values);
  const flush = spec.flushAllowed && cards.every(c => c.suit === cards[0].suit);
  const straight = spec.straightAllowed ? straightHigh(values, spec.shortDeck) : 0;
  if (flush && straight) return [8, straight];
  if (group[0].count === 4) return [7, group[0].value, group[1].value];
  const fullHouse = group[0].count === 3 && group[1]?.count === 2;
  if (spec.shortDeck && flush) return [6, ...values];
  if (fullHouse) return [spec.shortDeck ? 5 : 6, group[0].value, group[1].value];
  if (flush) return [5, ...values];
  if (straight) return [4, straight];
  if (group[0].count === 3) return [3, group[0].value, ...group.filter(g => g.count === 1).map(g => g.value)];
  const pairs = group.filter(g => g.count === 2).map(g => g.value);
  const singles = group.filter(g => g.count === 1).map(g => g.value);
  if (pairs.length === 2) return [2, ...pairs, singles[0]];
  if (pairs.length === 1) return [1, pairs[0], ...singles];
  return [0, ...values];
}

function aceFive(cards) {
  const values = desc(cards.map(lowValue)), group = groups(values);
  let category, kickers;
  if (group[0].count === 4) { category = 0; kickers = [group[0].value, group[1].value]; }
  else if (group[0].count === 3 && group[1]?.count === 2) { category = 1; kickers = [group[0].value, group[1].value]; }
  else if (group[0].count === 3) { category = 2; kickers = [group[0].value, ...group.filter(g => g.count === 1).map(g => g.value)]; }
  else {
    const pairs = group.filter(g => g.count === 2).map(g => g.value);
    const singles = group.filter(g => g.count === 1).map(g => g.value);
    if (pairs.length === 2) { category = 3; kickers = [...pairs, singles[0]]; }
    else if (pairs.length === 1) { category = 4; kickers = [pairs[0], ...singles]; }
    else { category = 5; kickers = values; }
  }
  return [category, ...kickers.map(inverse)];
}

function deuceSeven(cards) {
  const values = desc(cards.map(c => c.val)), group = groups(values);
  const flush = cards.every(c => c.suit === cards[0].suit);
  // An ace is never a low card here. A-2-3-4-5 is ace-high, not a straight.
  const straight = straightHigh(values, false, false);
  let category, kickers;
  if (flush && straight) { category = 0; kickers = [straight]; }
  else if (group[0].count === 4) { category = 1; kickers = [group[0].value, group[1].value]; }
  else if (group[0].count === 3 && group[1]?.count === 2) { category = 2; kickers = [group[0].value, group[1].value]; }
  else if (flush) { category = 3; kickers = values; }
  else if (straight) { category = 4; kickers = [straight]; }
  else if (group[0].count === 3) { category = 5; kickers = [group[0].value, ...group.filter(g => g.count === 1).map(g => g.value)]; }
  else {
    const pairs = group.filter(g => g.count === 2).map(g => g.value);
    const singles = group.filter(g => g.count === 1).map(g => g.value);
    if (pairs.length === 2) { category = 6; kickers = [...pairs, singles[0]]; }
    else if (pairs.length === 1) { category = 7; kickers = [pairs[0], ...singles]; }
    else { category = 8; kickers = values; }
  }
  return [category, ...kickers.map(inverse)];
}

function lowEight(cards) {
  const values = cards.map(lowValue);
  if (new Set(values).size !== 5 || values.some(v => v > 8)) return null;
  return desc(values).map(inverse);
}

/** Any four-card Badugi outranks every three-card hand, even A-2-3. */
function badugi(cards) {
  let best = null;
  for (let mask = 1; mask < 16; mask++) {
    const subset = cards.filter((_, i) => mask & (1 << i));
    const values = subset.map(lowValue);
    if (new Set(values).size !== subset.length || new Set(subset.map(c => c.suit)).size !== subset.length) continue;
    const rank = [subset.length, ...desc(values).map(inverse)];
    if (compare(rank, best) > 0) best = rank;
  }
  return best;
}

function combinations(cards, count, visit, start = 0, chosen = []) {
  if (chosen.length === count) { visit(chosen); return; }
  const remaining = count - chosen.length;
  for (let i = start; i <= cards.length - remaining; i++) {
    chosen.push(cards[i]);
    combinations(cards, count, visit, i + 1, chosen);
    chosen.pop();
  }
}

/** Best upcard hand for Stud action order; suits never break a showdown tie. */
export function exposedRank(cards, low = false) {
  if (!Array.isArray(cards) || cards.length > 4) throw new Error('Stud exposed ranks require up to four cards');
  if (!cards.length) return [-1];
  const parsed = cards.map(card), values = parsed.map(c => low ? lowValue(c) : c.val), group = groups(values);
  if (new Set(parsed.map(c => c.text)).size !== parsed.length) throw new Error('Duplicate exposed card');
  let category, kickers;
  if (group[0].count === 4) { category = low ? 0 : 7; kickers = [group[0].value]; }
  else if (group[0].count === 3) { category = low ? 2 : 3; kickers = [group[0].value, ...group.filter(g => g.count === 1).map(g => g.value)]; }
  else {
    const pairs = group.filter(g => g.count === 2).map(g => g.value), singles = group.filter(g => g.count === 1).map(g => g.value);
    if (pairs.length === 2) { category = low ? 3 : 2; kickers = pairs; }
    else if (pairs.length === 1) { category = low ? 4 : 1; kickers = [pairs[0], ...singles]; }
    else { category = low ? 5 : 0; kickers = desc(values); }
  }
  return [category, ...kickers.map(v => low ? inverse(v) : v)];
}

function validateShowdown(spec, hole, board) {
  if (!Array.isArray(hole) || !Array.isArray(board)) throw new Error('Showdown cards must be arrays');
  if (spec.family === 'community') {
    const required = spec.discardAfter ? 2 : spec.holeCount;
    if (hole.length !== required || board.length !== 5) throw new Error(spec.name + ' requires ' + required + ' private cards and five board cards at showdown');
  } else if (spec.family === 'stud') {
    const validBoard = spec.holeCount === 7 ? board.length <= 1 : board.length === 0;
    if (!validBoard || hole.length + board.length !== spec.holeCount) throw new Error(spec.name + ' has an incomplete or invalid final hand');
  } else if (hole.length !== spec.holeCount || board.length !== 0) throw new Error(spec.name + ' requires exactly ' + spec.holeCount + ' private cards and no board');
  const parsedHole = hole.map(card), parsedBoard = board.map(card), all = [...parsedHole, ...parsedBoard];
  if (all.some(c => !spec.deckRanks.includes(c.rank))) throw new Error('Card is not in this variant’s deck');
  if (new Set(all.map(c => c.text)).size !== all.length) throw new Error('Duplicate card at showdown');
  return [parsedHole, parsedBoard];
}

export function evaluate(id, hole, board = []) {
  const spec = getVariant(id);
  [hole, board] = validateShowdown(spec, hole, board);
  let high = null, low = null;
  if (spec.lowRule === 'badugi') high = badugi(hole);
  else if (spec.lowRule === 'deuce-to-seven') high = deuceSeven(hole);
  else {
    const visit = cards => {
      const rank = spec.lowRule === 'ace-to-five' ? aceFive(cards) : highFive(cards, spec);
      if (compare(rank, high) > 0) high = rank;
      if (spec.split) {
        const lowRank = lowEight(cards);
        if (lowRank && compare(lowRank, low) > 0) low = lowRank;
      }
    };
    if (spec.exactlyTwo) {
      combinations(hole, 2, privateCards => combinations(board, 3, communityCards => visit([...privateCards, ...communityCards])));
    } else combinations([...hole, ...board], 5, visit);
  }
  if (!high) throw new Error('No valid showdown ranking');
  return { high, low, highLabel: rankLabel(spec, high), lowLabel: low ? low.map(inverse).map(rankText).join('-') + ' low' : null };
}

function rankText(value) {
  return value === 1 || value === 14 ? 'A' : value === 13 ? 'K' : value === 12 ? 'Q' : value === 11 ? 'J' : value === 10 ? '10' : String(value);
}

export function rankLabel(id, rank) {
  const spec = getVariant(id);
  if (!Array.isArray(rank) || !rank.length) return 'Hand';
  if (spec.lowRule === 'badugi') return rank[0] + '-card ' + (rank[0] === 4 ? 'Badugi ' : 'hand ') + rank.slice(1).map(inverse).map(rankText).join('-');
  if (spec.lowOnly) {
    const bestCategory = spec.lowRule === 'deuce-to-seven' ? 8 : 5;
    if (rank[0] === bestCategory) return rank.slice(1).map(inverse).map(rankText).join('-') + ' low';
    const labels = spec.lowRule === 'deuce-to-seven'
      ? ['Straight flush', 'Four of a kind', 'Full house', 'Flush', 'Straight', 'Three of a kind', 'Two pair', 'One pair']
      : ['Four of a kind', 'Full house', 'Three of a kind', 'Two pair', 'One pair'];
    return (labels[rank[0]] || 'Low hand') + ' (' + rank.slice(1).map(inverse).map(rankText).join('-') + ')';
  }
  const labels = spec.shortDeck
    ? ['High card', 'One pair', 'Two pair', 'Three of a kind', 'Straight', 'Full house', 'Flush', 'Four of a kind', 'Straight flush']
    : ['High card', 'One pair', 'Two pair', 'Three of a kind', 'Straight', 'Flush', 'Full house', 'Four of a kind', 'Straight flush'];
  if (rank[0] === 8 && rank[1] === 14) return 'Royal flush';
  return (labels[rank[0]] || 'Hand') + (rank[1] ? ' · ' + rankText(rank[1]) : '');
}

/** Sources used to resolve dealing/ranking edge cases; the historical rules are
 * intentionally labeled house reconstructions, as in the uploaded parent. */
export const RULE_SOURCES = Object.freeze([
  { title: 'PokerStars 6+ Hold’em', url: 'https://www.pokerstars.com/poker/games/six-plus/', note: 'Flush over full house; A6789 straight. Native Dynasty blind structure is a declared house convention.' },
  { title: 'PokerStars Omaha Hi-Lo', url: 'https://www.pokerstars.com/poker/games/omaha/high-low/', note: 'Exactly two private and three board cards per high/low selection; eight-or-better qualifier.' },
  { title: 'PokerStars draw reshuffles', url: 'https://www.pokerstars.es/en/poker/games/draw/reshuffle/', note: 'Single-draw current discards cannot return; server tracks own discarded cards during multiple draws.' },
  { title: 'WSOP 2026 Live-Action Rules', url: 'https://assets.wsopcdn.com/wsop/853ee602-e1e9-4019-a0cf-381419d805c6.pdf', note: 'Rule 232 describes seventh-street stub/burn recovery and common river; Razz rules 237–240 describe ace-low ordering.' },
]);
