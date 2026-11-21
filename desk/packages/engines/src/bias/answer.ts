/** "Up or down today?" is answered with the standing call, never a new analysis. */
import { BIAS_TEXT, type BiasCall } from '@desk/contracts';
import { etStamp } from './calendar';
import { extractInputs } from './extract';
import { catalystState, px, structureSignals } from './factors';
import { creatorOfEdge } from './plan';
import type { BiasSnapshot } from './types';

const sentence = (s: string): string => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

/** One paragraph: the call, its probability and expiry, the facts, the trade, the kill condition, the next catalyst. */
export function answerUpOrDown(call: BiasCall, now: number): string {
  const name = `${call.instrument} ${call.horizon}`;
  const expiry = etStamp(call.expiresAt);
  if (now >= Date.parse(call.expiresAt)) {
    return `${name}: the last call (${BIAS_TEXT[call.call]}${call.call === 'no_edge' ? '' : `, ${call.probability.toFixed(2)}`}) expired ${expiry}. No current call until a new fact.`;
  }
  const next = call.nextCatalyst ? ` Next: ${call.nextCatalyst.name} ${etStamp(call.nextCatalyst.at)}.` : '';
  if (call.call === 'no_edge' || !call.trade) {
    return `Neither. ${name}, until ${expiry}. ${call.facts.map(sentence).join(' ')}${next}`;
  }
  const t = call.trade, long = t.direction === 'long';
  const trade = `Trade: ${t.direction} ${t.instrument} on ${t.entry.text}; targets ${t.targets.map((x) => px(x.price)).join(' / ')}; out on ${t.invalidation.reason}; ${t.timeStop.text}.`;
  return `${long ? 'Up' : 'Down'}. ${name}: ${BIAS_TEXT[call.call]}, ${call.probability.toFixed(2)}, expires ${expiry}. ${call.facts.map(sentence).join(' ')} ${trade} ${sentence(call.killCondition.text)}${next}`;
}

/** The answer for an instrument with nothing behind it: "No edge" and the fact that would create one. */
export function noEdgeAnswer(instrument: string, snapshot: BiasSnapshot): string {
  const inp = extractInputs({ ...snapshot, instrument });
  const st = catalystState(inp);
  const why = !st.inPlay && structureSignals(inp).length === 0
    ? `No catalyst inside the ${inp.horizon} horizon, no structure signal.`
    : 'Nothing on the tape scores outside the dead band.';
  return `${instrument}: No edge. ${why} ${creatorOfEdge(inp, st).text}`;
}
