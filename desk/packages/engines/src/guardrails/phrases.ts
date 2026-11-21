/** Phrase matchers over the trader's own words. Each returns the matched phrase (for the evidence) or null. */
import { INSTRUMENTS } from '@desk/contracts';

const NEGATION = /\b(?:not|never|no way|doubt|isn'?t|aren'?t|wasn'?t|hasn'?t|don'?t|doesn'?t|didn'?t|won'?t)\b[^.?!]{0,24}$/i;

function firstMatch(text: string, patterns: RegExp[], allowNegated = false): string | null {
  const t = text.replace(/[’‘]/g, "'");
  for (const p of patterns) {
    const m = p.exec(t);
    if (!m) continue;
    if (!allowNegated && NEGATION.test(t.slice(0, m.index))) continue;
    return m[0].toLowerCase();
  }
  return null;
}

const BOTTOM_CALL = [
  /\bbottom(?:'s| is| has to be| must be| looks| seems)? in\b(?! (?:the|a|an|this|that|my|its)\b)/i,
  /\blows? (?:is|are|'s|'re|has to be|must be) in\b/i,
  /\bbottom(?:ed|ing)(?: out)?\b/i,
  /\b(?:that|this) (?:was|is|'s) the (?:low|bottom)\b/i,
  /\bfound (?:a|the|its) (?:bottom|floor|low)\b/i,
  /\bcapitulation (?:is |was |looks |seems )?(?:done|over|complete|finished|in)\b/i,
  /\bcapitulated\b/i,
  /\bselling (?:is |looks |seems )?(?:done|over|exhausted|finished)\b/i,
  /\bsellers (?:are |look )?(?:done|exhausted|finished)\b/i,
  /\bcan'?t go (?:much |any )?lower\b/i,
  /\bworst is (?:over|behind us)\b/i,
];
export const matchBottomCall = (text: string): string | null => firstMatch(text, BOTTOM_CALL);

const HOLD = [
  /\bfully\b/i,
  /\b(?:keep|keeping|continue|continuing) (?:to hold|holding|it|the whole|all of it)\b/i,
  /\bhold(?:ing)?\b/i,
  /\blet (?:it|this|them) (?:ride|run)\b/i,
  /\bskip (?:the |my )?(?:scale|target|t1|t2)/i,
  /\bnot (?:sell|scale|trim)(?:ing)?\b/i,
];
/** "hold", "fully" and close variants. Negation is not filtered: "should I not hold" is the same question. */
export const matchHoldQuestion = (text: string): string | null => firstMatch(text, HOLD, true);

const SQUEEZE = [
  /\binstitution(?:s|al)?\b/i,
  /\breal (?:buying|buyers|demand|bid|money)\b/i,
  /\bsmart money\b/i,
  /\bbig (?:money|players|boys)\b/i,
  /\baccumulat(?:ion|ing|ed)\b/i,
  /\bwhales?\b/i,
  /\bfunds? (?:are |is )?(?:buying|stepping in|loading)\b/i,
  /\bstrong hands\b/i,
  /\bsomeone (?:big )?(?:knows|is loading|is buying)\b/i,
];
export const matchSqueezeAsStrength = (text: string): string | null => firstMatch(text, SQUEEZE);

const RUN = '(?:run|runs|running|take|takes|taking|sweep|sweeps|sweeping|grab|grabs|grabbing|clear|clears|clearing|tag|tags|tagging|raid|raids|hunt|hunts)';
const RUN_HIGHS = [new RegExp(`\\b${RUN} (?:the |those |these |all the )?(?:equal |prior |old |session )?(?:highs?|buy[- ]?side|buy stops)\\b`, 'i'), /\b(?:highs?|buy[- ]?side|buy stops) (?:get|gets|will get|are getting) (?:run|taken|swept|raided)\b/i];
const RUN_LOWS = [new RegExp(`\\b${RUN} (?:the |those |these |all the )?(?:equal |prior |old |session )?(?:lows?|sell[- ]?side|sell stops)\\b`, 'i'), /\b(?:lows?|sell[- ]?side|sell stops) (?:get|gets|will get|are getting) (?:run|taken|swept|raided)\b/i];
/** The side the trader says will be run first: 'highs' rationalizes a long, 'lows' a short. */
export function matchLiquidityRun(text: string): { phrase: string; side: 'highs' | 'lows' } | null {
  const hi = firstMatch(text, RUN_HIGHS);
  if (hi) return { phrase: hi, side: 'highs' };
  const lo = firstMatch(text, RUN_LOWS);
  return lo ? { phrase: lo, side: 'lows' } : null;
}

const NOT_A_SHORT = /\bshort(?:s)?(?:[- ](?:term|squeeze|squeezes|covering|cover|interest|dated|lived|sellers?|float)| (?:are|were|got|get|getting) (?:covering|squeezed|trapped|caught|burned))\b/gi;
const ASK_SHORT = [/\bshort(?:s|ing|ed)?\b/i, /\bhedg(?:e|es|ing|ed)\b/i, /\bputs?\b/i, /\bfade\b/i, /\bsell (?:it )?short\b/i];
const ASK_LONG = [/\b(?:go|going|flip|flipping|open|add|adding|take|taking)(?: a| to)? long\b/i, /\blongs?\b(?= (?:here|now|too|as well|against|on the other))/i, /\bhedg(?:e|es|ing|ed)\b/i, /\bcalls\b(?= (?:here|now|against|as a hedge))/i, /\bbuy (?:some )?(?:here|now|against)\b/i];
/** Which opposite side the message asks about. "short-term", "short squeeze" and "shorts are covering" are not a short. */
export function matchOppositeSide(text: string, heldDirection: 'long' | 'short'): string | null {
  return heldDirection === 'long' ? firstMatch(text.replace(NOT_A_SHORT, ' '), ASK_SHORT) : firstMatch(text, ASK_LONG);
}

const REGRET = [
  /\bif (?:i|only i|i had|i'd|i would have|i'?d have)(?: had)?(?: just| only)? (?:held|hold|kept|stayed|waited|not sold|not closed)\b/i,
  /\bif i (?:hadn'?t|had not|didn'?t) (?:sold|closed|exited|trimmed|scaled|taken profit)\b/i,
  /\b(?:would|could|should)(?:'ve| have) (?:doubled|tripled|made|been up|held|kept)\b/i,
  /\bleft (?:so much|a lot|too much|money|\$?[\d,.]+k?) on the table\b/i,
  /\bsold (?:way |far )?(?:too )?(?:early|soon)\b/i,
  /\bshould(?:'ve| have|n'?t have) (?:held|kept|stayed in|sold)\b/i,
  /\bmissed (?:the rest|out on) (?:of )?the (?:move|run)\b/i,
];
/** Regret is usually phrased as a negative ("if I hadn't sold"), so negation is not filtered. */
export const matchRegret = (text: string): string | null => firstMatch(text, REGRET, true);

const CROWD = [
  /\b(?:everyone|everybody|every one|the whole (?:street|world|timeline)|all of (?:twitter|fintwit|x)|whole fintwit) (?:is|are|was|were|'s)? ?(?:long|short|bullish|bearish|buying|selling|in|calling)\b/i,
  /\bconsensus\b(?! (?:is|was|at|of|for)? ?-?\d)/i,
  /\b(?:crowded|everyone knows|nobody is (?:short|long|bearish|bullish))\b/i,
  /\b(?:fintwit|twitter|reddit|wsb|the street) (?:is|are|says|thinks|loves|hates)\b/i,
];
export const matchCrowd = (text: string): string | null => firstMatch(text, CROWD, true);

/** Lagged-fact kinds the message cites. Returned strings are matched against `LaggedFact.kind` by substring. */
export function matchLaggedKinds(text: string): string[] {
  const kinds: string[] = [];
  if (/\b13[- ]?f\b|\bfilings? (?:show|shows|showed|say|says)\b|\b(?:fund|berkshire|buffett|ackman|burry|druckenmiller|tepper)\b[^.?!]{0,40}\b(?:bought|added|owns|holds|loaded|position)\b/i.test(text)) kinds.push('13f');
  if (/\bbuy[- ]?backs?\b|\brepurchas/i.test(text)) kinds.push('buyback');
  if (/\bshort interest\b/i.test(text)) kinds.push('short_interest');
  if (/\bcot\b|\bcommitments? of traders\b/i.test(text)) kinds.push('cot');
  return kinds;
}

const IDEA = [
  /\b(?:buy|buying|long|short|shorting|sell|selling|enter|entry|ape|aping|scalp|trade|position|leverage|lever|size|sizing|full[- ]?port|all[- ]?in|add|adding|bid|load|loading)\b/i,
  /\b\d{1,3}x\b/i,
];
/** A message that proposes or asks about putting risk on, as opposed to a lookup ("what was CPI"). */
export const matchTradeIdea = (text: string): string | null => firstMatch(text, IDEA, true);

const ALIASES: Record<string, string> = { nq: 'NQ', nasdaq: 'NQ', nas: 'NQ', nas100: 'NQ', ndx: 'NQ', 'the index': 'NQ', qqq: 'NQ', spx: 'ES', 's&p': 'ES', gold: 'GC', oil: 'CL', crude: 'CL', bitcoin: 'BTC', ether: 'ETH' };
/** Price symbols the message names (NQ for "nasdaq", "MNQ", "NQ-PERP"). Empty when it names none. */
export function mentionedPriceSymbols(text: string): string[] {
  const found = new Set<string>();
  const lower = text.toLowerCase();
  for (const [alias, sym] of Object.entries(ALIASES)) if (new RegExp(`(?:^|[^a-z0-9])${alias.replace(/[&]/g, '\\$&')}(?:$|[^a-z0-9])`).test(lower)) found.add(sym);
  for (const spec of Object.values(INSTRUMENTS)) {
    if (!spec.tradable) continue;
    if (new RegExp(`(?:^|[^A-Za-z0-9])\\$?${spec.symbol}(?:$|[^A-Za-z0-9])`, spec.symbol.length <= 2 ? '' : 'i').test(text)) found.add(spec.priceSymbol);
  }
  return [...found];
}
