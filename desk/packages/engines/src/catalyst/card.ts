import { fmtPct, hhmm } from '@desk/contracts';
import { SPECS, fmtValue } from './branches';
import { branchConviction, cannotPlanReason, fmtPrice } from './matrix';
import type { CatalystEx, HistoricalReactionEx } from './types';

export interface CatalystCardRow {
  branchId: string; label: string; probability: number; probabilityText: string; probabilitySource: string;
  ratesRead: string; indexRead: string;
  /** The trade in one line, or the no-trade reason. */
  trade: string; tradeable: boolean; conviction: number | null;
  /** Filled by the sizing engine; null until a plan carries a size. */
  size: string | null;
  matched: boolean;
}
export interface CatalystCard {
  id: string; name: string; tier: 1 | 2 | 3; status: CatalystEx['status'];
  /** The UI counts down to this instant. */
  countdownTo: string; whenET: string;
  consensus: string | null; prior: string | null; whisper: string | null; secondary: string | null;
  impliedMove: string | null;
  rows: CatalystCardRow[];
  history: Array<{ date: string; actual: string; consensus: string; m5: string; h1: string; close: string; firstMoveReversed: string; resolution: string }>;
  regimeNotes: string[];
  /** The one line; the bias engine owns it once it has a call. */
  oneLine: string;
  reaction: string | null; analog: string | null;
  generatedAt: string | null; asOf: string;
}

const dash = '–';
const pctOr = (x: number | null): string => (x === null ? dash : fmtPct(x, 2));

/** View model for the catalyst card. Pure formatting: every number is already on the catalyst. */
export function catalystCard(catalyst: CatalystEx): CatalystCard {
  const spec = SPECS[catalyst.code] ?? { dp: 2, unit: '' };
  const val = (x: number | null): string | null => (x === null ? null : catalyst.code === 'EARNINGS' ? x.toFixed(2) : fmtValue(x, spec));
  const m = catalyst.matrix;
  const rows: CatalystCardRow[] = (m?.branches ?? []).map((b) => {
    const t = b.trade;
    return {
      branchId: b.id, label: b.label, probability: b.probability, probabilityText: `${Math.round(b.probability * 100)}%`, probabilitySource: b.probabilitySource,
      ratesRead: b.ratesRead.text, indexRead: b.indexRead.text,
      trade: t ? `${t.direction === 'long' ? 'Long' : 'Short'} ${t.instrument}. ${t.entry.text}. T1 ${fmtPrice(t.targets[0].price)}, T2 ${fmtPrice(t.targets[1].price)}, T3 ${fmtPrice(t.targets[2].price)}, a third each. Out ${fmtPrice(t.invalidation.price)}. ${t.timeStop.text}${t.accountId ? ` Account ${t.accountId}.` : ''}` : b.noTradeReason ?? 'No edge.',
      tradeable: t !== null, conviction: m ? branchConviction(m, b.id) : null,
      size: t?.size ? `${t.size.units} units, fail ${t.size.failPrice === null ? dash : fmtPrice(t.size.failPrice)}` : null,
      matched: catalyst.resolution?.branchId === b.id,
    };
  });
  const sec = catalyst.secondary;
  return {
    id: catalyst.id, name: catalyst.name, tier: catalyst.tier, status: catalyst.status,
    countdownTo: catalyst.scheduledAt, whenET: `${hhmm(catalyst.scheduledAt)} ET`,
    consensus: val(catalyst.consensus), prior: val(catalyst.prior), whisper: val(catalyst.whisper),
    secondary: sec ? `${sec.name}: consensus ${sec.consensus ?? dash}, prior ${sec.prior ?? dash}${sec.actual !== null ? `, actual ${sec.actual}` : ''}` : null,
    impliedMove: catalyst.impliedMovePct !== null ? `${catalyst.impliedMovePct}% (${catalyst.impliedMoveSource})` : null,
    rows,
    history: (catalyst.history as HistoricalReactionEx[]).map((h) => ({
      date: h.date, actual: h.actual === null ? dash : String(h.actual), consensus: h.consensus === null ? dash : String(h.consensus),
      m5: pctOr(h.m5Pct), h1: pctOr(h.h1Pct), close: pctOr(h.closePct),
      firstMoveReversed: h.firstMoveReversed === null ? dash : h.firstMoveReversed ? 'yes' : 'no', resolution: h.resolution ?? dash,
    })),
    regimeNotes: m?.regimeNotes ?? [],
    oneLine: m?.whatIWouldDo ?? (catalyst.tier === 3 ? 'Shown, not planned.' : cannotPlanReason(catalyst) ?? 'No edge until the print.'),
    reaction: catalyst.reaction?.text ?? null, analog: catalyst.adhoc?.analog ?? null,
    generatedAt: m?.generatedAt ?? null, asOf: catalyst.asOf,
  };
}
