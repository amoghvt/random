import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CalendarEvent, Candle, DATUM_KEYS, Datum, EarningsInfo, Headline, PredictionMarket, Quote, type EventCode } from '@desk/contracts';
import {
  TIER1_CODES, cboeToChain, classifyHeadline, classifyHeadlines, dedupeHeadlines, dedupeKey, fedWatch, fomcMeetings, impliedMoveData, impliedMoveFromChain,
  kalshiFedProbs, ladderToBuckets, lagText, loadRecordedCalendar, loadRecordedCandles, mapAlpacaSnapshots, mapBenzingaNews, mapBenzingaRatings, mapBinanceTicker,
  mapCftc, mapCoinbaseCandles, mapCoinbaseTicker, mapDatabentoOhlcv, mapFarsideFlows, mapForexFactory, mapFred, mapKalshiMarkets, mapNasdaqSurprise,
  mapPolygonAggs, mapPolygonSnapshot, mapPolygonWs, mapPolymarketEvent, mapTradierQuotes, mapTradingEconomics, mapTvCalendarRow, mapTvEarnings, mapTvScan,
  mapYahooChart, mapYahooQuote, nullLlm, parseBucket, parsePrint, parseRss, parseTradingViewCsv, polymarketEventCode, postPrintHistory, selectKalshiSeries,
  stamped, timingOf, titleToEventCode, tvRowToQuote, vixImpliedMove, zqTicker, type LlmClient, type RawHeadline,
} from './index';

const FIX = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const text = (name: string): string => readFileSync(join(FIX, name), 'utf8');
const json = <T>(name: string): T => JSON.parse(text(name)) as T;
/** When the fixtures were captured from the real endpoints. */
const NOW = Date.parse('2026-11-21T18:45:00Z');

describe('calendar title -> EventCode on the recorded TradingView calendar', () => {
  const rows = loadRecordedCalendar();
  const titles = [...new Set(rows.map((r) => r.title))];

  it('maps the Tier-1 set and the Tier-2 headline series', () => {
    const expected: Record<string, EventCode> = {
      'Inflation Rate MoM': 'CPI', 'Inflation Rate YoY': 'CPI', 'Core Inflation Rate MoM': 'CORE_CPI', 'Core Inflation Rate YoY': 'CORE_CPI',
      'PPI MoM': 'PPI', 'PPI YoY': 'PPI', 'Core PPI MoM': 'CORE_PPI', 'Core PPI YoY': 'CORE_PPI', 'Non Farm Payrolls': 'NFP', 'Unemployment Rate': 'UNEMPLOYMENT',
      'Interest Rate': 'FOMC', 'PCE Price Index MoM': 'PCE', 'Core PCE Price Index MoM': 'CORE_PCE', 'Core PCE Price Index YoY': 'CORE_PCE',
      'ISM Manufacturing PMI': 'ISM_MFG', 'ISM Services PMI': 'ISM_SVC', 'JOLTs Job Openings': 'JOLTS', 'Retail Sales MoM': 'RETAIL_SALES',
      'Initial Jobless Claims': 'CLAIMS', 'GDP Growth Rate QoQ Adv': 'GDP', 'GDP Growth Rate QoQ 2nd Est': 'GDP', 'GDP Growth Rate QoQ Final': 'GDP',
      'Philadelphia Fed Manufacturing Index': 'REGIONAL_FED', 'NY Empire State Manufacturing Index': 'REGIONAL_FED', '10-Year Note Auction': 'TREASURY_AUCTION', '30-Year Bond Auction': 'TREASURY_AUCTION',
    };
    for (const [title, code] of Object.entries(expected)) {
      expect(titles, title).toContain(title);
      expect(titleToEventCode(title), title).toBe(code);
    }
  });

  it('keeps sub-series, index levels and auction detail rows out of the coded set', () => {
    for (const t of ['CPI', 'CPI-W', 'CPI seasonally adjusted', 'Inflation Rate MoM NSA', 'Core Consumer Prices', 'Cleveland Fed CPI MoM', 'PPI', 'PPI Ex Food Energy and Trade Services MoM',
      'Nonfarm Payrolls Private', 'Government Payrolls', 'U6 Unemployment Rate', 'Continuing Jobless Claims', 'Jobless Claims 4-week Average', 'JOLTs Job Quits', 'ISM Manufacturing Prices',
      'ISM Services Employment', 'Retail Sales Ex Autos MoM', 'Retail Sales YoY', 'GDP Price Index QoQ Adv', 'Interest Rate Projection - Current', 'Interest Rate on Reserve Balances',
      'Fed Balance Sheet', 'Philly Fed Prices Paid', '10-Year Note Auction Bid-to-Cover', '3-Month Bill Auction', '10-Year TIPS Auction', 'PCE Prices QoQ Adv', 'Dallas Fed Trimmed Mean PCE']) {
      expect(titles, t).toContain(t);
      expect(titleToEventCode(t), t).toBe('OTHER');
    }
  });

  it('codes each release once per series: one coded title per code and release time, bar the MoM/YoY pair', () => {
    const coded = titles.filter((t) => titleToEventCode(t) !== 'OTHER');
    // 372 distinct titles in the recording; the coded ones are the headline series only.
    expect(titles.length).toBeGreaterThan(300);
    expect(coded.length).toBeLessThan(45);
    const fomc = rows.filter((r) => titleToEventCode(r.title) === 'FOMC');
    expect(fomc.length).toBe(20);
    expect(fomc.filter((r) => r.date.startsWith('2026-12'))[0]?.date).toBe('2026-12-09T19:00:00.000Z');
  });

  it('maps Fed speech and minutes titles used by the live calendar and ForexFactory', () => {
    expect(titleToEventCode('Fed Interest Rate Decision')).toBe('FOMC');
    expect(titleToEventCode('Federal Funds Rate')).toBe('FOMC');
    expect(titleToEventCode('FOMC Minutes')).toBe('FOMC_MINUTES');
    expect(titleToEventCode('FOMC Meeting Minutes')).toBe('FOMC_MINUTES');
    expect(titleToEventCode('Fed Press Conference')).toBe('FED_CHAIR');
    expect(titleToEventCode('Fed Chair Powell Speech')).toBe('FED_CHAIR');
    expect(titleToEventCode('Fed Waller Speech')).toBe('FED_SPEAKER');
    expect(titleToEventCode('FOMC Member Williams Speaks')).toBe('FED_SPEAKER');
    expect(titleToEventCode('Core CPI m/m')).toBe('CORE_CPI');
    expect(titleToEventCode('Non-Farm Employment Change')).toBe('NFP');
    expect(titleToEventCode('Unemployment Claims')).toBe('CLAIMS');
    expect(TIER1_CODES).toContain('FOMC');
  });

  it('maps live rows to valid CalendarEvents with consensus and prior', () => {
    const live = json<{ result: Parameters<typeof mapTvCalendarRow>[0][] }>('tv_calendar.json').result;
    const events = live.map((r) => mapTvCalendarRow(r, new Date(NOW).toISOString()));
    for (const e of events) expect(CalendarEvent.safeParse(e).success).toBe(true);
    const pce = events.find((e) => e.code === 'CORE_PCE' && e.name.includes('MoM') && e.time.startsWith('2026-11-25'));
    expect(pce).toMatchObject({ consensus: 0.3, prior: 0.3, actual: null, unit: '%', importance: 1 });
    const nfp = events.find((e) => e.code === 'NFP');
    expect(nfp).toMatchObject({ time: '2026-12-04T13:30:00.000Z', consensus: 93, prior: 165 });
  });

  it('maps ForexFactory USD rows', () => {
    const events = mapForexFactory(json('ff_calendar.json'), new Date(NOW).toISOString());
    expect(events.length).toBeGreaterThan(5);
    for (const e of events) expect(CalendarEvent.safeParse(e).success).toBe(true);
    expect(events.every((e) => e.actual === null && e.source === 'forexfactory')).toBe(true);
  });
});

describe('TradingView scanner and Yahoo chart mappers (captured payloads)', () => {
  const rows = mapTvScan(json('tv_scan_quotes.json'), NOW);

  it('maps NQ with its delay and the 10Y as streaming', () => {
    const nq = rows.find((r) => r.ticker === 'CME_MINI:NQ1!')!;
    const q = tvRowToQuote('NQ', nq, 60);
    expect(Quote.safeParse(q).success).toBe(true);
    expect(q).toMatchObject({ symbol: 'NQ', price: 25126.5, source: 'tradingview:delayed10m' });
    expect(q.prevClose).toBeCloseTo(26600.25, 2);
    expect(q.changePct).toBeCloseTo(-5.54, 2);
    const y10 = rows.find((r) => r.ticker === 'TVC:US10Y')!;
    expect(y10.close).toBe(4.95);
    expect(y10.delaySec).toBe(0);
  });

  it('maps a Yahoo chart to aligned ascending candles and a quote', () => {
    const raw = json<Parameters<typeof mapYahooChart>[0]>('yahoo_chart_NQ_1m.json');
    const candles = mapYahooChart(raw, 'NQ', '1m', 'yahoo:delayed');
    expect(candles.length).toBeGreaterThan(20);
    for (const c of candles) { expect(Candle.safeParse(c).success).toBe(true); expect(c.t % 60_000).toBe(0); expect(c.h).toBeGreaterThanOrEqual(c.l); }
    expect(candles.every((c, i) => i === 0 || c.t > candles[i - 1]!.t)).toBe(true);
    expect(mapYahooQuote(raw, 'NQ', 60, 'yahoo:delayed')).toMatchObject({ price: 25126.5, prevClose: 26600.25, source: 'yahoo:delayed' });
  });

  it('parses a TradingView chart export with unix or ISO time', () => {
    const csv = 'time,open,high,low,close,Volume,EMA\n1795129200,25100,25110.5,25090,25105.25,1200,25099\n1795129260,25105.25,25120,25101,25118,900,25100\nbad,row\n';
    const c = parseTradingViewCsv(csv, 'NQ', '1m');
    expect(c).toHaveLength(2);
    expect(c[0]).toMatchObject({ symbol: 'NQ', tf: '1m', t: 1795129200000, o: 25100, h: 25110.5, l: 25090, c: 25105.25, v: 1200, source: 'tradingview:csv' });
    const isoCsv = '﻿time,open,high,low,close\n2026-11-19T23:00:00Z,1,2,0.5,1.5\n2026-11-19T23:00:00Z,1,3,0.5,2\n';
    expect(parseTradingViewCsv(isoCsv, 'NQ', '15m')).toEqual([{ symbol: 'NQ', tf: '15m', t: 1795129200000, o: 1, h: 3, l: 0.5, c: 2, v: 0, source: 'tradingview:csv' }]);
    expect(() => parseTradingViewCsv('a,b\n1,2', 'NQ', '1m')).toThrow();
  });
});

describe('Fed pricing (FedWatch method)', () => {
  const meetings = fomcMeetings(loadRecordedCalendar().map((r) => mapTvCalendarRow(r, r.date, 'tradingview:recorded')));

  it('takes the December 2026 meeting from the recorded calendar and prices a hike from the captured ZQ contracts', () => {
    const rows = mapTvScan(json('tv_scan_quotes.json'), NOW);
    const price = (t: string): number => rows.find((r) => r.ticker === t)!.close;
    const prices = { '2026-11': price(zqTicker({ y: 2026, m: 11 }, 'tradingview')), '2026-12': price('CBOT:ZQZ2026'), '2027-01': price('CBOT:ZQF2027') };
    expect(prices).toEqual({ '2026-11': 96.12, '2026-12': 95.96, '2027-01': 95.88 });
    const w = fedWatch(NOW, meetings, prices);
    // No November meeting, so November's 3.88% average is the rate going in. 9 days at 3.88, 22 at the new rate, month average 4.04.
    expect(w).toMatchObject({ meeting: '2026-12-09T19:00:00.000Z', anchor: 'prior_month', start: 3.88, cut: 0 });
    expect(w.end).toBeCloseTo((4.04 * 31 - 3.88 * 9) / 22, 3);
    expect(w.hike).toBeCloseTo(0.902, 2);
    expect(w.hike + w.cut + w.hold).toBeCloseTo(1, 6);
    // Kalshi's Fed decision market for the same meeting, captured at the same time, agrees within 2 points.
    const k = kalshiFedProbs(json<{ markets: Parameters<typeof kalshiFedProbs>[0] }>('kalshi_markets_KXFEDDECISION.json').markets, Date.parse(w.meeting))!;
    expect(k.event).toBe('KXFEDDECISION-26DEC');
    expect(Math.abs(k.hike - w.hike)).toBeLessThan(0.02);
  });

  it('chains through a meeting month and prices a cut (synthetic prices)', () => {
    const synthetic = [Date.UTC(2026, 0, 28, 19), Date.UTC(2026, 2, 18, 18)];
    // Dec 4.00 flat; Jan meeting on the 28th holds; Mar average implies a 25 bp cut on the 18th: (4.00*18 + 3.75*13)/31.
    const mar = 100 - (4.0 * 18 + 3.75 * 13) / 31;
    const w = fedWatch(Date.UTC(2026, 1, 10), synthetic, { '2025-12': 96, '2026-01': 96, '2026-02': 96, '2026-03': mar });
    expect(w.cut).toBeCloseTo(1, 3);
    expect(w.hike).toBe(0);
    expect(w.end).toBeCloseTo(3.75, 3);
  });

  it('refuses to price without a meeting date or a contract', () => {
    expect(() => fedWatch(NOW, [], { '2026-12': 95.96 })).toThrow(/No upcoming FOMC/);
    expect(() => fedWatch(NOW, meetings, { '2026-11': 96.12 })).toThrow(/No Fed funds futures price/);
  });
});

describe('prediction markets', () => {
  const asOf = new Date(NOW).toISOString();

  it('selects US series from the Kalshi series list by title', () => {
    const sel = selectKalshiSeries(json<{ series: Parameters<typeof selectKalshiSeries>[0] }>('kalshi_series.json').series);
    expect(sel).toMatchObject({ KXFEDDECISION: 'FOMC', KXFED: 'FOMC', KXCPI: 'CPI', KXCPICORE: 'CORE_CPI', KXPAYROLLS: 'NFP', KXU3: 'UNEMPLOYMENT' });
    expect(sel.KXARGINFLATIONM).toBeUndefined();
    expect(sel.KXUKCPIYOY).toBeUndefined();
  });

  it('turns a Kalshi "above X" ladder into buckets that sum to 1', () => {
    const [p] = mapKalshiMarkets(json<{ markets: Parameters<typeof mapKalshiMarkets>[0] }>('kalshi_markets_KXCPI.json').markets, 'KXCPI', 'CPI', asOf, 'CPI');
    expect(PredictionMarket.safeParse(p).success).toBe(true);
    expect(p).toMatchObject({ id: 'kalshi_KXCPI-26NOV', venue: 'kalshi', eventCode: 'CPI', eventDate: '2026-12-10' });
    expect(p!.outcomes.reduce((a, o) => a + o.prob, 0)).toBeCloseTo(1, 2);
    expect(p!.outcomes[0]!.lo).toBeNull();
    expect(p!.outcomes.at(-1)!.hi).toBeNull();
    expect(ladderToBuckets([{ strike: 0.2, pAbove: 0.7 }, { strike: 0.3, pAbove: 0.2 }])).toEqual([
      { label: '<= 0.2', prob: 0.3, lo: null, hi: 0.2 }, { label: '0.2 to 0.3', prob: 0.5, lo: 0.2, hi: 0.3 }, { label: '> 0.3', prob: 0.2, lo: 0.3, hi: null },
    ]);
  });

  it('maps the Kalshi Fed decision event with named outcomes', () => {
    const [p] = mapKalshiMarkets(json<{ markets: Parameters<typeof mapKalshiMarkets>[0] }>('kalshi_markets_KXFEDDECISION.json').markets, 'KXFEDDECISION', 'FOMC', asOf);
    expect(p!.eventDate).toBe('2026-12-09');
    expect(p!.outcomes.find((o) => o.label === 'Hike 25bps')!.prob).toBeGreaterThan(0.8);
    expect(p!.outcomes.find((o) => /maintains/.test(o.label))).toMatchObject({ lo: 0, hi: 0 });
  });

  it('maps a Polymarket event and parses bucket bounds from labels', () => {
    const [e] = json<Parameters<typeof mapPolymarketEvent>[0][]>('polymarket_event_fed.json');
    const p = mapPolymarketEvent(e!, asOf)!;
    expect(PredictionMarket.safeParse(p).success).toBe(true);
    expect(p).toMatchObject({ venue: 'polymarket', eventCode: 'FOMC', title: 'Fed Decision in December?' });
    expect(p.outcomes.find((o) => o.label === '25 bps increase')).toMatchObject({ prob: 0.895, lo: 25, hi: 25 });
    expect(p.outcomes.find((o) => o.label === '50+ bps decrease')).toMatchObject({ lo: null, hi: -50 });
    expect(p.outcomes.find((o) => o.label === 'No change')).toMatchObject({ lo: 0, hi: 0 });
    expect(parseBucket('0.3% to 0.4%')).toEqual({ lo: 0.3, hi: 0.4 });
    expect(parseBucket('Above 4.5%')).toEqual({ lo: 4.5, hi: null });
    expect(parseBucket('3.9% or lower')).toEqual({ lo: null, hi: 3.9 });
    expect(polymarketEventCode('Jerome Powell out of Fed Board by…?')).toBeNull();
    expect(polymarketEventCode('Bank of Japan decision in December?')).toBeNull();
    expect(polymarketEventCode('What will November CPI be?')).toBe('CPI');
  });
});

describe('headlines: dedupe and rules classifier', () => {
  const h = (title: string, ts = '2026-11-21T18:00:00.000Z'): RawHeadline => ({ title, ts, source: 'test' });
  const c = (title: string): Headline => classifyHeadline(h(title));

  it('parses the captured FinancialJuice feed, and nothing in a quiet Saturday feed scores 3', () => {
    const raws = parseRss(text('financialjuice_rss.xml'), 'financialjuice');
    expect(raws.length).toBeGreaterThan(50);
    expect(raws[0]!.title.startsWith('FinancialJuice')).toBe(false);
    const kept = dedupeHeadlines(raws);
    expect(kept.length).toBeLessThanOrEqual(raws.length);
    const out = kept.map((r) => classifyHeadline(r));
    for (const x of out) expect(Headline.safeParse(x).success).toBe(true);
    expect(out.filter((x) => x.impact === 3)).toEqual([]);
    expect(out.find((x) => /oil tanker catches fire after striking naval mine/.test(x.title))).toMatchObject({ category: 'geopolitical', impact: 2, direction: -1 });
  });

  it('dedupes by normalized title and collapses near-duplicates inside 30 minutes', () => {
    expect(dedupeKey('FinancialJuice: Fed’s Waller: Inflation is too HIGH.')).toBe(dedupeKey('fed’s waller - inflation is too high'));
    const kept = dedupeHeadlines([
      h('US CPI MoM Actual 0.5% (Forecast 0.3%, Previous 0.2%)', '2026-11-21T13:30:00.000Z'),
      h('FinancialJuice: US CPI MoM actual 0.5% (forecast 0.3%, previous 0.2%)', '2026-11-21T13:30:05.000Z'),
      h('Nvidia CEO Jensen Huang resigns effective immediately, board names interim chief', '2026-11-21T14:00:00.000Z'),
      h('Nvidia CEO Jensen Huang resigns effective immediately, board names interim chief executive', '2026-11-21T14:02:00.000Z'),
      h('Nvidia CEO Jensen Huang resigns effective immediately, board names interim chief executive', '2026-11-21T16:00:00.000Z'),
      h('Micron raises guidance', '2026-11-21T14:05:00.000Z'),
    ]);
    expect(kept.map((k) => k.ts)).toEqual(['2026-11-21T13:30:00.000Z', '2026-11-21T14:00:00.000Z', '2026-11-21T14:05:00.000Z', '2026-11-21T16:00:00.000Z']);
    expect(dedupeHeadlines([h('Micron raises guidance')], [h('Micron raises guidance', '2026-11-21T10:00:00.000Z')])).toEqual([]);
  });

  it('scores 3 only for the confirmed event classes', () => {
    expect(c('Nvidia CEO Jensen Huang resigns, effective immediately')).toMatchObject({ category: 'company', impact: 3, direction: -1 });
    expect(c('US Commerce Department imposes new export controls on AI chips to China')).toMatchObject({ category: 'geopolitical', impact: 3, direction: -1 });
    expect(c('Fed cuts rates by 50 bps in emergency unscheduled move')).toMatchObject({ category: 'fed', impact: 3, direction: 1 });
    expect(c('Israel launches strikes on Iran nuclear facilities - officials')).toMatchObject({ category: 'geopolitical', impact: 3, direction: -1 });
    expect(c('US CPI MoM Actual 0.6% (Forecast 0.3%, Previous 0.2%)')).toMatchObject({ category: 'macro', impact: 3, direction: -1 });
    expect(c('US Non-Farm Payrolls Actual 250K (Forecast 93K, Previous 165K)')).toMatchObject({ category: 'macro', impact: 3 });
    expect(c('Nvidia CEO Jensen Huang resigns, effective immediately').symbols).toEqual(expect.arrayContaining(['NVDA', 'NQ']));
    expect(c('US Commerce Department imposes new export controls on AI chips to China').symbols).toEqual(expect.arrayContaining(['NVDA', 'AMD', 'TSM', 'NQ']));
  });

  it('never scores a rumour, a denial or an in-line print as 3', () => {
    expect(c('Nvidia CEO Jensen Huang reportedly considering stepping down - sources').impact).toBe(2);
    expect(c('US said to weigh new export controls on AI chips, people familiar say').impact).toBeLessThan(3);
    expect(c('Israel may launch strikes on Iran within days - report').impact).toBeLessThan(3);
    expect(c('US CPI MoM Actual 0.3% (Forecast 0.3%, Previous 0.2%)')).toMatchObject({ impact: 2, direction: 0 });
    expect(c('US CPI MoM Actual 0.2% (Forecast 0.3%, Previous 0.2%)')).toMatchObject({ impact: 2, direction: 1 });
    expect(c('German ZEW Actual 12.0 (Forecast 10.0, Previous 9.0)').impact).toBe(1);
    expect(c("Fed's Waller: inflation is still too high, hikes remain appropriate")).toMatchObject({ category: 'fed', impact: 1, direction: -1 });
    expect(c('Fed Chair Powell: policy is well positioned')).toMatchObject({ category: 'fed', impact: 2 });
    expect(c('Small-cap biotech CEO resigns')).toMatchObject({ impact: 0 });
  });

  it('categorises and tags', () => {
    expect(c('Micron Q1 EPS beats, raises guidance')).toMatchObject({ category: 'earnings', direction: 1, symbols: ['MU'] });
    expect(c('Morgan Stanley upgrades AMD to overweight')).toMatchObject({ category: 'company', direction: 1, symbols: ['AMD'] });
    expect(c('MyFundedFutures updates payout policy for Rapid plans')).toMatchObject({ category: 'firm-rules', impact: 1 });
    expect(c('Bitcoin rises 2.20% to $60,225.76')).toMatchObject({ category: 'other', impact: 0, symbols: ['BTC'] });
    expect(parsePrint('US CPI YoY Actual 3.9% (Forecast 3.9%, Previous 3.7%)')).toMatchObject({ actual: 3.9, forecast: 3.9, tier1: true, far: false });
  });

  it('uses the LLM when available and falls back to rules on any failure', async () => {
    const raws = [h('Nvidia CEO Jensen Huang resigns, effective immediately'), h('Bitcoin rises 2.20% to $60,225.76')];
    expect((await classifyHeadlines(raws, nullLlm)).map((x) => x.classifier)).toEqual(['rules', 'rules']);
    const good: LlmClient = { available: true, complete: async (req) => {
      expect(req.model).toBe('claude-haiku-5-5');
      expect(req.jsonSchema).toBeDefined();
      return JSON.stringify({ items: [{ i: 0, category: 'company', impact: 3, direction: -1, symbols: ['NVDA', 'NQ', 'ZZZZ'] }, { i: 1, category: 'other', impact: 0, direction: 0, symbols: ['BTC'] }] });
    } };
    const out = await classifyHeadlines(raws, good);
    expect(out[0]).toMatchObject({ classifier: 'llm', impact: 3, symbols: ['NVDA', 'NQ'] });
    for (const x of out) expect(Headline.safeParse(x).success).toBe(true);
    const bad: LlmClient[] = [
      { available: true, complete: async () => { throw new Error('529 overloaded'); } },
      { available: true, complete: async () => 'not json' },
      { available: true, complete: async () => JSON.stringify({ items: [{ i: 0, category: 'company', impact: 7, direction: -1, symbols: [] }] }) },
    ];
    for (const llm of bad) expect((await classifyHeadlines(raws, llm)).map((x) => [x.classifier, x.impact])).toEqual([['rules', 3], ['rules', 0]]);
    await expect(nullLlm.complete({ system: '', messages: [], maxTokens: 1 })).rejects.toThrow(/No LLM configured/);
  });
});

describe('earnings, options, crypto, positioning', () => {
  it('computes post-print history for NVDA from recorded daily candles and the Nasdaq report dates', () => {
    const reports = mapNasdaqSurprise(json('nasdaq_earnings_surprise_NVDA.json'));
    expect(reports.map((r) => r.date)).toEqual(['2026-11-17', '2026-08-26', '2026-05-20', '2026-02-25']);
    const tv = mapTvEarnings(json('tv_scan_earnings.json')).find((r) => r.symbol === 'NVDA')!;
    expect(timingOf(tv.lastAt)).toBe('amc');
    expect(timingOf(tv.nextAt)).toBe('unknown');
    const daily = loadRecordedCandles('NVDA', '1d');
    const hist = postPrintHistory(reports, 'amc', daily);
    expect(hist).toHaveLength(4);
    const close = (d: string): number => daily.find((c) => new Date(c.t).toISOString().startsWith(d))!.c;
    expect(hist[0]).toMatchObject({ date: '2026-11-17', surprisePct: 8.5 });
    expect(hist[0]!.nextDayPct).toBeCloseTo((close('2026-11-18') / close('2026-11-17') - 1) * 100, 2);
    const info = { symbol: 'NVDA', date: new Date(tv.nextAt!).toISOString(), timing: 'amc' as const, epsConsensus: tv.epsConsensus, revenueConsensus: tv.revenueConsensus, whisper: null, impliedMovePct: null, history: hist, source: 'tradingview+nasdaq+yahoo', asOf: new Date(NOW).toISOString() };
    expect(EarningsInfo.safeParse(info).success).toBe(true);
    expect(postPrintHistory([{ date: '1999-01-04', surprisePct: null }], 'amc', daily)).toEqual([]);
  });

  it('derives the implied move and put/call from the captured NVDA chain', () => {
    const m = impliedMoveFromChain(json('yahoo_options_NVDA.json'), 'NVDA', NOW)!;
    expect(m).toMatchObject({ symbol: 'NVDA', spot: 125.53, expiry: '2026-11-23', days: 1 });
    expect(Math.abs(m.strike - m.spot)).toBeLessThanOrEqual(1);
    expect(m.movePct).toBeGreaterThan(3);
    expect(m.movePct).toBeLessThan(15);
    const data = impliedMoveData(m, 'yahoo:options', 1800);
    for (const d of data) expect(Datum.safeParse(d).success).toBe(true);
    expect(data.map((d) => d.key)).toEqual([DATUM_KEYS.impliedMove('NVDA'), DATUM_KEYS.putCall('NVDA')]);
    expect(data[0]!.meta).toMatchObject({ method: 'options', days: 1 });
    const vix = vixImpliedMove({ key: DATUM_KEYS.vix, value: 35.89, source: 'tradingview:delayed15m', asOf: new Date(NOW).toISOString(), cadenceSec: 60 });
    expect(vix).toMatchObject({ key: 'opt.implied_move.NQ', value: 2.261, meta: { method: 'vix' } });
  });

  it('maps Coinbase ticker and candles', () => {
    const q = mapCoinbaseTicker(json('coinbase_ticker_BTC.json'), 'BTC');
    expect(Quote.safeParse(q).success).toBe(true);
    expect(q).toMatchObject({ symbol: 'BTC', price: 60128.42, source: 'coinbase', asOf: '2026-11-21T18:39:13.253Z' });
    const candles = mapCoinbaseCandles(json('coinbase_candles_BTC.json'), 'BTC');
    expect(candles).toHaveLength(30);
    expect(candles.every((c, i) => Candle.safeParse(c).success && c.h >= c.l && (i === 0 || c.t > candles[i - 1]!.t))).toBe(true);
  });

  it('maps the CFTC report to a datum and a lagged fact with its report date', () => {
    const m = mapCftc(json('cftc_tff_nasdaq.json'), NOW)!;
    expect(m.datum).toMatchObject({ key: 'pos.cftc.NQ', source: 'cftc:tff', asOf: '2026-11-17T00:00:00.000Z', meta: { periodEnd: '2026-11-17', market: 'NASDAQ MINI' } });
    expect(m.fact).toMatchObject({ kind: 'cftc_cot', periodEnd: '2026-11-17' });
    expect(m.fact.text).toMatch(/positions as of Nov 17, 4 days stale$/);
    expect(mapCftc([], NOW)).toBeNull();
  });

  it('stamps freshness and lag', () => {
    const d = { key: 'rate.US10Y', value: 4.95, source: 'tradingview', asOf: '2026-11-21T18:44:00.000Z', cadenceSec: 60 };
    expect(stamped(d, NOW)).toEqual({ value: 4.95, asOf: d.asOf, source: 'tradingview', stale: false, age: '60s' });
    expect(stamped(d, NOW + 10 * 60_000)).toMatchObject({ stale: true, age: '11m' });
    expect(stamped(null, NOW)).toEqual({ value: null, asOf: null, source: null, stale: true, age: null });
    expect(lagText('2026-09-30', NOW)).toBe('positions as of Sept 30, 52 days stale');
    expect(lagText('2025-12-31', NOW, 'holdings')).toBe('holdings as of Dec 31, 2025, 325 days stale');
  });
});

describe('paid and flagged adapters: mappers on hand-written payloads in the documented shape (never run against the network)', () => {
  it('Polygon snapshot, aggregates and websocket', () => {
    expect(mapPolygonSnapshot({ tickers: [{ ticker: 'NVDA', lastTrade: { p: 125.5, t: 1795208401000000000 }, prevDay: { c: 146 }, todaysChangePerc: -14.04 }, { ticker: 'XX' }] }))
      .toEqual([{ symbol: 'NVDA', price: 125.5, prevClose: 146, changePct: -14.04, asOf: '2026-11-20T21:00:01.000Z', source: 'polygon', cadenceSec: 5 }]);
    expect(mapPolygonAggs({ results: [{ t: 1795208400000, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }] }, 'NVDA', '1m')).toEqual([{ symbol: 'NVDA', tf: '1m', t: 1795208400000, o: 1, h: 2, l: 0.5, c: 1.5, v: 10, source: 'polygon' }]);
    expect(mapPolygonWs([{ ev: 'status', status: 'auth_success' }, { ev: 'A', sym: 'AMD', c: 424.4, s: 1795208400000, e: 1795208401000 }])).toMatchObject([{ symbol: 'AMD', price: 424.4, source: 'polygon:ws' }]);
  });
  it('Databento OHLCV NDJSON', () => {
    const nd = '{"hd":{"ts_event":"2026-11-20T14:30:00.000000000Z","rtype":33},"open":"25100.25","high":"25110.00","low":"25095.50","close":"25104.75","volume":"812"}\n\n';
    expect(mapDatabentoOhlcv(nd, 'NQ', '1m')).toEqual([{ symbol: 'NQ', tf: '1m', t: Date.parse('2026-11-20T14:30:00Z'), o: 25100.25, h: 25110, l: 25095.5, c: 25104.75, v: 812, source: 'databento' }]);
  });
  it('Tradier and Alpaca quotes', () => {
    const one = { symbol: 'MU', last: 100.5, prevclose: 99, change_percentage: 1.52, trade_date: 1795208400000 };
    expect(mapTradierQuotes({ quotes: { quote: one } })).toMatchObject([{ symbol: 'MU', price: 100.5, prevClose: 99, source: 'tradier' }]);
    expect(mapTradierQuotes({ quotes: { quote: [one, { ...one, symbol: 'X', last: null }] } })).toHaveLength(1);
    const [a] = mapAlpacaSnapshots({ AVGO: { latestTrade: { t: '2026-11-20T20:59:59.5Z', p: 304.41 }, prevDailyBar: { c: 310 } }, ZZ: {} });
    expect(a).toMatchObject({ symbol: 'AVGO', price: 304.41, prevClose: 310, source: 'alpaca' });
    expect(a!.changePct).toBeCloseTo(-1.803, 2);
  });
  it('Trading Economics calendar', () => {
    const [e] = mapTradingEconomics([{ CalendarId: '399001', Date: '2026-12-10T13:30:00', Event: 'Core Inflation Rate MoM', Actual: '', Previous: '0.3%', Forecast: '0.3%', TEForecast: '0.4%', Revised: '', Importance: 3, Unit: '%' }], '2026-11-21T18:45:00.000Z');
    expect(CalendarEvent.safeParse(e).success).toBe(true);
    expect(e).toMatchObject({ id: 'te_399001', code: 'CORE_CPI', time: '2026-12-10T13:30:00.000Z', consensus: 0.3, prior: 0.3, actual: null, importance: 1 });
  });
  it('Benzinga news and ratings', () => {
    expect(mapBenzingaNews([{ id: 1, title: 'Nvidia Shares Slide', created: 'Fri, 20 Nov 2026 14:20:15 -0500', url: 'https://www.benzinga.com/x' }])).toEqual([{ title: 'Nvidia Shares Slide', ts: '2026-11-20T19:20:15.000Z', source: 'benzinga', url: 'https://www.benzinga.com/x' }]);
    const [r] = mapBenzingaRatings({ ratings: [{ id: 'a1', date: '2026-11-20', time: '08:15:00', ticker: 'NVDA', analyst: 'Morgan Stanley', action_company: 'Upgrades', rating_current: 'Overweight', pt_current: '180', pt_prior: '160' }] });
    expect(r!.title).toBe('Morgan Stanley upgrades NVDA to Overweight, PT 180 from 160');
    expect(classifyHeadline(r!)).toMatchObject({ category: 'company', direction: 1, symbols: ['NVDA'] });
  });
  it('FRED, Binance, CBOE and Farside', () => {
    expect(mapFred({ observations: [{ date: '2026-11-20', value: '.' }, { date: '2026-11-19', value: '4.97' }] }, 'US10Y')).toMatchObject({ key: 'rate.US10Y', value: 4.97, source: 'fred', cadenceSec: 86_400 });
    expect(mapFred({ observations: [] }, 'US2Y')).toBeNull();
    expect(mapBinanceTicker({ symbol: 'BTCUSDT', lastPrice: '60100.5', prevClosePrice: '58800', priceChangePercent: '2.21', closeTime: 1795286340000 }, 'BTC')).toMatchObject({ symbol: 'BTC', price: 60100.5, prevClose: 58800, source: 'binance' });
    const chain = cboeToChain({ timestamp: '2026-11-20 21:15:00', data: { current_price: 100, options: [
      { option: 'TEST261123C00100000', bid: 2, ask: 2.2, volume: 10, open_interest: 5 }, { option: 'TEST261123P00100000', bid: 1.9, ask: 2.1, volume: 20, open_interest: 5 },
      { option: 'TEST261218C00100000', bid: 5, ask: 5.2 }, { option: 'TEST261120C00100000', bid: 0, ask: 0 },
    ] } }, 'TEST', NOW)!;
    expect(impliedMoveFromChain(chain, 'TEST', NOW)).toMatchObject({ expiry: '2026-11-23', strike: 100, putCallVolume: 2 });
    expect(impliedMoveFromChain(chain, 'TEST', NOW)!.movePct).toBeCloseTo(4.1, 5);
    const html = '<table><tr><th></th><th>IBIT</th><th>FBTC</th></tr><tr><td>19 Nov 2026</td><td>120.5</td><td>3.0</td></tr><tr><td>20 Nov 2026</td><td>(310.2)</td><td>-</td></tr><tr><td>Total</td><td>1</td><td>2</td></tr></table>';
    expect(mapFarsideFlows(html, 'IBIT')).toEqual([{ date: '2026-11-19', usdMm: 120.5 }, { date: '2026-11-20', usdMm: -310.2 }]);
  });
});
