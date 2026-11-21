import { fromZoned, hhmm } from '@desk/contracts';
import { loadSessionFixture } from './loadFixture';
import { walkForward } from './replay';
const fx = loadSessionFixture();
const base = { instrument: 'NQ', m1: fx.m1.NQ!, history: { '15m': fx.m15History.NQ! }, peersM1: { ES: fx.m1.ES! } };
const a = walkForward({ ...base, from: fromZoned(2026, 11, 16, 9, 30), to: fromZoned(2026, 11, 16, 16, 0) });
for (const { event: e, at } of a.values()) if (at > fromZoned(2026, 11, 16, 9, 30) && (e.kind.includes('stalled') || e.kind.startsWith('bounce_volume')) ) console.log(hhmm(at), e.tf, e.kind, JSON.stringify(e.data));
const b = walkForward({ ...base, from: fromZoned(2026, 11, 17, 17, 0), to: fromZoned(2026, 11, 17, 21, 30) });
for (const { event: e, at } of b.values()) if (at > fromZoned(2026, 11, 17, 17, 0) && (e.detector === 'volume_context' || e.kind.includes('touch') || e.detector==='divergence')) console.log(hhmm(at), e.tf, e.kind, e.text, JSON.stringify(e.data));
