import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { DATUM_KEYS, DAY, HOUR, KV, RuleDiff, type AccountRules } from '@desk/contracts';
import {
  backfillCandles, buildFeeds, changeBp, checkFirmRules, diffRules, ingestOnce, normalizeRuleText, pollSubscribe, resetYahooSession, stamped,
  type Feed, type FeedHealthRow, type Feeds, type FetchLike, type ItemOf, type RuleSnapshot,
} from './index';
import { FakeStore } from './testing';

const FIX = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const fx = (name: string): string => readFileSync(join(FIX, name), 'utf8');
/** Capture time of the fixtures: Saturday 2026-11-21, US markets closed since Friday 22:00 UTC. */
const NOW = Date.parse('2026-11-21T18:45:00Z');

/** Serves the captured payloads by URL; anything not captured answers 404 so a stray request is visible as a feed failure. */
function fixtureFetch(overrides: Record<string, () => Response> = {}): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const ok = (body: string, type = 'application/json'): Response => new Response(body, { status: 200, headers: { 'content-type': type } });
  const fetch: FetchLike = async (url, init) => {
    calls.push(url);
    for (const [frag, make] of Object.entries(overrides)) if (url.includes(frag)) return make();
    const body = typeof init?.body === 'string' ? init.body : '';
    if (url.includes('economic-calendar.tradingview.com')) return ok(fx('tv_calendar.json'));
    if (url.includes('scanner.tradingview.com')) return ok(fx(body.includes('earnings_release_next_date') ? 'tv_scan_earnings.json' : 'tv_scan_quotes.json'));
    if (url.includes('/v8/finance/chart/%5ETNX')) return ok(fx('yahoo_chart_TNX_5m.json'));
    if (url.includes('/v8/finance/chart/NQ%3DF')) return ok(fx('yahoo_chart_NQ_1m.json'));
    if (url.includes('fc.yahoo.com')) return new Response('', { status: 404, headers: { 'set-cookie': 'A3=fixture; Domain=.yahoo.com; Path=/' } });
    if (url.includes('/v1/test/getcrumb')) return ok('fixtureCrumb', 'text/plain');
    if (url.includes('/v7/finance/options/NVDA')) return ok(fx('yahoo_options_NVDA.json'));
    if (url.includes('financialjuice.com')) return ok(fx('financialjuice_rss.xml'), 'application/xml');
    if (url.includes('kalshi.com/trade-api/v2/series')) return ok(fx('kalshi_series.json'));
    if (url.includes('series_ticker=KXFEDDECISION')) return ok(fx('kalshi_markets_KXFEDDECISION.json'));
    if (url.includes('series_ticker=KXCPI&')) return ok(fx('kalshi_markets_KXCPI.json'));
    if (url.includes('kalshi.com')) return ok('{"markets":[]}');
    if (url.includes('gamma-api.polymarket.com')) return ok(fx('polymarket_event_fed.json'));
    if (url.includes('coinbase.com/products/BTC-USD/ticker')) return ok(fx('coinbase_ticker_BTC.json'));
    if (url.includes('coinbase.com/products/BTC-USD/candles')) return ok(fx('coinbase_candles_BTC.json'));
    if (url.includes('api.nasdaq.com/api/company/NVDA/')) return ok(fx('nasdaq_earnings_surprise_NVDA.json'));
    if (url.includes('publicreporting.cftc.gov')) return ok(fx('cftc_tff_nasdaq.json'));
    return new Response('not captured', { status: 404 });
  };
  return { fetch, calls };
}

describe('feed layer acceptance', () => {
  beforeEach(() => resetYahooSession());

  it('acceptance: after ingestOnce the store holds the NQ quote, the 10Y with a 1h change, and this week\'s catalysts with consensus', async () => {
    const store = new FakeStore();
    const { fetch } = fixtureFetch();
    const report = await ingestOnce(store, buildFeeds({}), NOW, { fetch, symbols: ['NQ', 'MNQ', 'NQ-PERP', 'US10Y', 'US2Y', 'US30Y', 'VIX', 'DXY', 'NVDA', 'BTC'], force: true });

    // NQ: the free tier is 10 minutes delayed and the capture is from a closed market, so the quote is real, sourced and flagged stale.
    const nq = (await store.latestQuotes(['NQ'])).NQ!;
    expect(nq).toMatchObject({ symbol: 'NQ', price: 25126.5, source: 'tradingview:delayed10m', asOf: '2026-11-21T02:10:00.000Z' });
    expect(stamped({ value: nq.price, ...nq }, NOW)).toMatchObject({ value: 25126.5, stale: true, age: '17h' });
    expect(stamped({ value: nq.price, ...nq }, Date.parse(nq.asOf) + 90_000).stale).toBe(false);
    expect(Object.keys(await store.latestQuotes())).toEqual(expect.arrayContaining(['NQ', 'US10Y', 'VIX', 'DXY', 'NVDA', 'BTC']));

    // 10Y: live value from TradingView plus 80 intraday points from the CBOE ^TNX index, enough for a same-source 1h change.
    const y10 = (await store.latestDatum(DATUM_KEYS.rate('US10Y')))!;
    expect(y10).toMatchObject({ value: 4.95, source: 'tradingview', cadenceSec: 60 });
    const hist = await store.dataHistory(y10.key, Date.parse(y10.asOf) - DAY);
    expect(hist.length).toBeGreaterThan(60);
    const chg = changeBp(hist, HOUR)!;
    expect(chg).toMatchObject({ source: 'yahoo', from: '2026-11-20T19:00:00.000Z', to: '2026-11-20T20:00:00.000Z' });
    expect(chg.bp).toBeCloseTo(-3.4, 1);
    expect((await store.latestDatum(DATUM_KEYS.spread2s10s))!.value).toBeCloseTo(30.1, 1);

    // Catalysts in the next 7 days with consensus (it is Saturday: nothing prints today).
    const week = await store.list('calendar', { since: new Date(NOW).toISOString(), until: new Date(NOW + 7 * DAY).toISOString(), order: 'asc' });
    const coded = week.filter((e) => e.code !== 'OTHER' && e.code !== 'TREASURY_AUCTION' && e.consensus !== null);
    expect(coded.map((e) => `${e.code} ${e.name} ${e.consensus}`)).toEqual(expect.arrayContaining([
      'CORE_PCE Core PCE Price Index MoM (Oct. 2026) 0.3', 'PCE PCE Price Index MoM (Oct. 2026) 0.3', 'GDP GDP Growth Rate QoQ 2nd Est (Q3 2026) 3.4', 'CLAIMS Initial Jobless Claims (w/o Nov. 16, 2026) 200',
    ]));
    expect(coded.every((e) => e.source === 'tradingview:calendar' && e.asOf === new Date(NOW).toISOString())).toBe(true);

    // Fed pricing used the FOMC date from the calendar that was ingested in the same pass.
    const hike = (await store.latestDatum(DATUM_KEYS.fedHike))!;
    expect(hike.value).toBeCloseTo(0.902, 2);
    expect(hike.meta).toMatchObject({ meeting: '2026-12-09T19:00:00.000Z', anchor: 'prior_month', kalshi: { event: 'KXFEDDECISION-26DEC' } });

    expect((await store.list('headlines', { limit: 500 })).length).toBeGreaterThan(50);
    expect((await store.list('predictions')).map((p) => p.id)).toEqual(expect.arrayContaining(['kalshi_KXFEDDECISION-26DEC', 'kalshi_KXCPI-26NOV', 'polymarket_770450']));
    expect((await store.list('lagged_facts'))[0]!.periodEnd).toBe('2026-11-17');
    expect((await store.getCandles('NQ', '1m')).length).toBeGreaterThan(30);
    const nvda = (await store.list('earnings'))[0]!;
    expect(nvda).toMatchObject({ symbol: 'NVDA', timing: 'amc', epsConsensus: 2.880566, impliedMovePct: null });
    expect((await store.latestDatum(DATUM_KEYS.impliedMove('NVDA')))!.meta).toMatchObject({ method: 'options', expiry: '2026-11-23' });

    // Health: every polled feed has a row; feeds whose payloads were not captured failed and say why.
    const health = (await store.kvGet<FeedHealthRow[]>(KV.feedHealth))!;
    expect(health.map((h) => h.feed)).toEqual(expect.arrayContaining(report.polled.map((p) => p.feed)));
    for (const name of ['tradingview.quotes', 'tradingview.rates', 'tradingview.calendar', 'fedwatch', 'financialjuice', 'kalshi', 'polymarket', 'cftc.cot', 'earnings'])
      expect(health.find((h) => h.feed === name), name).toMatchObject({ ok: true, error: null, lastOk: new Date(NOW).toISOString() });
    expect(health.find((h) => h.feed === 'tradingview.quotes')!.live).toBe(true);
    expect(report.written.quote).toBeGreaterThan(5);
  });

  it('a failing provider never throws out of ingestOnce: it is recorded, and the fallback fills in', async () => {
    const store = new FakeStore();
    const down = (): Response => new Response('<html>blocked</html>', { status: 503 });
    const { fetch } = fixtureFetch({ 'scanner.tradingview.com': down, 'financialjuice.com': () => new Response('error code: 1015', { status: 429 }), 'economic-calendar.tradingview.com': () => { throw new TypeError('fetch failed'); } });
    const report = await ingestOnce(store, buildFeeds({}), NOW, { fetch, symbols: ['NQ', 'US10Y'], force: true, kinds: ['calendar', 'quotes', 'rates', 'headlines', 'fed'] });
    const by = (n: string): (typeof report.polled)[number] => report.polled.find((p) => p.feed === n)!;
    expect(by('tradingview.quotes')).toMatchObject({ ok: false, error: expect.stringContaining('HTTP 503') });
    expect(by('financialjuice')).toMatchObject({ ok: false, error: expect.stringContaining('HTTP 429') });
    expect(by('tradingview.calendar')).toMatchObject({ ok: false, error: 'fetch failed' });
    // Fallbacks: Yahoo quote for NQ, Yahoo ^TNX for the 10Y; ForexFactory was not captured for this run and fails too.
    expect(by('yahoo.quotes')).toMatchObject({ ok: true, items: 2 });
    expect((await store.latestQuotes()).NQ).toMatchObject({ price: 25126.5, source: 'yahoo:delayed' });
    expect((await store.latestDatum(DATUM_KEYS.rate('US10Y')))!.source).toBe('yahoo');
    expect(by('fedwatch')).toMatchObject({ ok: false, error: expect.stringContaining('No upcoming FOMC meeting') });
    const health = (await store.kvGet<FeedHealthRow[]>(KV.feedHealth))!;
    expect(health.find((h) => h.feed === 'tradingview.quotes')).toMatchObject({ ok: false, lastOk: null, live: true });
  });

  it('polls a feed again only when its cadence has elapsed, drops invalid items, and a fallback never overwrites the primary', async () => {
    const store = new FakeStore();
    let polls = 0;
    const q = (symbol: string, price: number, source: string): ItemOf<'quote'> => ({ type: 'quote', symbol, source, asOf: new Date(NOW).toISOString(), cadenceSec: 60, data: { symbol, price, prevClose: null, changePct: null, asOf: new Date(NOW).toISOString(), source, cadenceSec: 60 } });
    const primary: Feed = { name: 'synthetic.primary', kind: 'quotes', live: true, requiresKey: null, cadenceSec: 60, verified: true, enabled: () => true,
      poll: async () => { polls++; return [q('NQ', 100, 'synthetic.primary'), { ...q('ES', 1, 'synthetic.primary'), data: { symbol: 'ES' } as never }]; } };
    const fallback: Feed = { name: 'synthetic.fallback', kind: 'quotes', live: false, requiresKey: null, cadenceSec: 60, verified: true, enabled: () => true,
      poll: async (ctx) => { expect(ctx.symbols).toEqual(['ES']); return [q('NQ', 999, 'synthetic.fallback'), q('ES', 50, 'synthetic.fallback')]; } };
    const feeds: Feeds = { slots: [{ kind: 'quotes', mode: 'first', feeds: [primary, fallback], want: (s) => s }], all: [primary, fallback] };
    const r1 = await ingestOnce(store, feeds, NOW, { symbols: ['NQ', 'ES'] });
    expect(r1.polled[0]).toMatchObject({ feed: 'synthetic.primary', ok: true, items: 1, invalid: 1, error: '1 invalid item dropped' });
    expect(await store.latestQuotes()).toMatchObject({ NQ: { price: 100, source: 'synthetic.primary' }, ES: { price: 50, source: 'synthetic.fallback' } });
    expect((await ingestOnce(store, feeds, NOW + 30_000, { symbols: ['NQ', 'ES'] })).polled).toEqual([]);
    await ingestOnce(store, feeds, NOW + 61_000, { symbols: ['NQ', 'ES'] });
    expect(polls).toBe(2);
  });

  it('registry: free stack with no keys; a key puts its provider ahead of the free one', () => {
    const free = buildFeeds({});
    expect(free.all.every((f) => f.requiresKey === null && f.verified)).toBe(true);
    expect(free.slots.find((s) => s.kind === 'quotes')!.feeds.map((f) => f.name)).toEqual(['tradingview.quotes', 'yahoo.quotes']);
    expect(free.slots.find((s) => s.kind === 'flows')).toBeUndefined();
    const paid = buildFeeds({ POLYGON_API_KEY: 'k', FRED_API_KEY: 'k', TRADING_ECONOMICS_KEY: 'k', BENZINGA_API_KEY: 'k', DATABENTO_API_KEY: 'k', TRADIER_API_KEY: 'k', ALPACA_API_KEY: 'k', ALPACA_API_SECRET: 's', FEED_BINANCE: '1', FEED_CBOE: '1', FEED_ETF_FLOWS: '1' });
    expect(paid.slots.find((s) => s.kind === 'quotes')!.feeds.map((f) => f.name)).toEqual(['polygon.quotes', 'tradier.quotes', 'alpaca.quotes', 'tradingview.quotes', 'yahoo.quotes']);
    expect(paid.slots.find((s) => s.kind === 'calendar')!.feeds[0]!.name).toBe('tradingeconomics.calendar');
    expect(paid.slots.find((s) => s.kind === 'rates')!.feeds.map((f) => f.name)).toEqual(['tradingview.rates', 'yahoo.rates', 'fred.rates']);
    expect(paid.all.filter((f) => !f.verified).map((f) => f.name).sort()).toEqual(['alpaca.quotes', 'benzinga.news', 'benzinga.ratings', 'binance', 'cboe.options', 'databento.candles.1m', 'farside.etf_flows', 'fred.rates', 'polygon.candles.1m', 'polygon.quotes', 'tradier.quotes', 'tradingeconomics.calendar']);
  });

  it('backfillCandles writes what it can and reports per-series failures', async () => {
    const store = new FakeStore();
    const r = await backfillCandles(store, ['NQ', 'NQ-PERP', 'ES'], ['1m'], { fetch: fixtureFetch().fetch });
    expect(r.series).toEqual([{ symbol: 'NQ', tf: '1m', bars: r.candles, error: null }, { symbol: 'ES', tf: '1m', bars: 0, error: expect.stringContaining('HTTP 404') }]);
    expect((await store.getCandles('NQ', '1m')).length).toBe(r.candles);
  });

  it('subscribe on a polling feed is a poll loop that can be stopped', async () => {
    let n = 0;
    const sub = pollSubscribe<ItemOf<'quote'>>({ cadenceSec: 60, poll: async (ctx) => { n++; return [{ type: 'quote', symbol: ctx.symbols![0], source: 's', asOf: 'x', cadenceSec: 60, data: { symbol: 'NQ', price: n, prevClose: null, changePct: null, asOf: '2026-11-21T00:00:00Z', source: 's', cadenceSec: 60 } }]; } });
    const got: number[] = [];
    const stop = sub('NQ', (items) => got.push(items[0]!.data.price), { env: {}, intervalMs: 5, now: () => NOW });
    await new Promise((r) => setTimeout(r, 40));
    stop();
    const seen = got.length;
    expect(seen).toBeGreaterThanOrEqual(2);
    await new Promise((r) => setTimeout(r, 20));
    expect(got.length).toBe(seen);
  });
});

describe('firm-rule scraper and diff', () => {
  const URL_OK = 'https://help.myfundedfutures.com/en/articles/8230009-news-trading-policy';
  const URL_BLOCKED = 'https://apextraderfunding.com/help-center/';
  const v1 = fx('mffu_news_trading_policy.html');
  const RULE = 'Ensuring no open positions or orders are active in the order book 2 minutes before and after any data release.';
  const acct = (id: string, firm: string, urls: string[]): AccountRules => ({ id, firm, source: { urls, asOf: '2026-11-21', origin: 'test' } }) as unknown as AccountRules;
  const accounts = [acct('mffu-pro-50k', 'MyFundedFutures', [URL_OK]), acct('mffu-rapid-50k', 'MyFundedFutures', [URL_OK]), acct('apex-50k', 'Apex Trader Funding', [URL_BLOCKED])];
  const serve = (html: string): FetchLike => async (url) => (url === URL_OK ? new Response(html, { status: 200 }) : new Response('<title>Attention Required! | Cloudflare</title>', { status: 403 }));

  it('reduces the saved MyFundedFutures page to its rule sentences', () => {
    const s = normalizeRuleText(v1);
    expect(s).toContain(RULE);
    expect(s).toContain('Utilizing strategies that exploit immediate news bursts, such as straddles or strangles.');
    expect(s.some((x) => /^Updated|Skip to main content|Table of contents/i.test(x))).toBe(false);
    expect(s.join(' ')).not.toMatch(/<|function\s*\(|window\./);
  });

  it('acceptance: a changed rule sentence raises a RuleDiff; a cosmetic change does not', async () => {
    const store = new FakeStore();
    expect(v1).toContain('2 minutes before and after');
    expect(v1).toContain('Updated over 3 months ago');

    // Night 1: baseline. No diff, snapshot stored, the blocked Apex page is recorded as a failure.
    expect(await checkFirmRules(store, accounts, NOW, serve(v1))).toEqual([]);
    const snap = (await store.kvGet<RuleSnapshot>(KV.ruleSnapshot('mffu-pro-50k')))![URL_OK]!;
    expect(snap).toMatchObject({ ok: true, error: null });
    expect(snap.sentences.length).toBe(49);
    expect((await store.kvGet<RuleSnapshot>(KV.ruleSnapshot('apex-50k')))![URL_BLOCKED]).toMatchObject({ ok: false, sentences: [], error: 'HTTP 403 (bot protection)' });
    const health = (await store.kvGet<FeedHealthRow[]>(KV.feedHealth))!;
    expect(health.find((h) => h.feed === 'rules:apextraderfunding.com')).toMatchObject({ ok: false, lastOk: null });
    expect(health.find((h) => h.feed === 'rules:help.myfundedfutures.com')).toMatchObject({ ok: true, error: null });

    // Night 2: cosmetic only. New date stamp, reflowed whitespace, an nbsp, an extra tracking script.
    const cosmetic = v1.replaceAll('Updated over 3 months ago', 'Updated over 4 months ago').replaceAll('August 31, 2026', 'December 1, 2026')
      .replace('2 minutes before and after', '2&nbsp;minutes  before\n and after').replace('</body>', '<script>window.analytics = { build: "9f2c" };</script></body>');
    expect(cosmetic).not.toBe(v1);
    expect(await checkFirmRules(store, accounts, NOW + DAY, serve(cosmetic))).toEqual([]);

    // Night 3: the blackout window changes from 2 to 5 minutes.
    const changed = cosmetic.replace('2&nbsp;minutes', '5 minutes');
    const diffs = await checkFirmRules(store, accounts, NOW + 2 * DAY, serve(changed));
    expect(diffs).toHaveLength(1);
    const d = diffs[0]!;
    expect(RuleDiff.safeParse(d).success).toBe(true);
    expect(d).toMatchObject({ firm: 'MyFundedFutures', url: URL_OK, accountIds: ['mffu-pro-50k', 'mffu-rapid-50k'], removed: [RULE], detectedAt: new Date(NOW + 2 * DAY).toISOString() });
    expect(d.added).toEqual([RULE.replace('2 minutes', '5 minutes')]);
    expect(d.summary).toMatch(/^MyFundedFutures rule page changed: 1 added, 1 removed\. New: "Ensuring no open positions/);
    expect(await store.list('rule_diffs')).toHaveLength(1);

    // Night 4: unchanged again, so the same change is not raised twice; an outage keeps the last good snapshot.
    expect(await checkFirmRules(store, accounts, NOW + 3 * DAY, serve(changed))).toEqual([]);
    expect(await checkFirmRules(store, accounts, NOW + 4 * DAY, async () => new Response('Just a moment...', { status: 503 }))).toEqual([]);
    const after = (await store.kvGet<RuleSnapshot>(KV.ruleSnapshot('mffu-pro-50k')))![URL_OK]!;
    expect(after).toMatchObject({ ok: false, error: 'HTTP 503 (bot protection)' });
    expect(after.sentences).toContain(RULE.replace('2 minutes', '5 minutes'));
    expect(await checkFirmRules(store, accounts, NOW + 5 * DAY, serve(changed))).toEqual([]);
  });

  it('diffRules ignores case, spacing and typographic quotes', () => {
    expect(diffRules(['Don’t hedge across accounts.', 'Max 5 contracts.'], ["don't  hedge across accounts .", 'Max 3 contracts.'])).toEqual({ added: ['Max 3 contracts.'], removed: ['Max 5 contracts.'] });
  });
});

describe.skipIf(process.env.LIVE !== '1')('live network (LIVE=1; behind a proxy also set NODE_USE_ENV_PROXY=1)', () => {
  it('ingests quotes, rates, calendar and Fed pricing from the real free endpoints', async () => {
    resetYahooSession();
    const store = new FakeStore();
    const now = Date.now();
    const report = await ingestOnce(store, buildFeeds({}), now, { symbols: ['NQ', 'US2Y', 'US10Y', 'US30Y', 'VIX', 'VIX3M'], force: true, kinds: ['calendar', 'quotes', 'rates', 'rates_history', 'vol', 'fed'] });
    expect(report.polled.filter((p) => !p.ok)).toEqual([]);
    expect((await store.latestQuotes()).NQ!.price).toBeGreaterThan(1000);
    expect((await store.latestDatum(DATUM_KEYS.rate('US10Y')))!.value).toBeGreaterThan(0);
    expect((await store.list('calendar')).length).toBeGreaterThan(50);
    const fed = await store.latestData([DATUM_KEYS.fedHike, DATUM_KEYS.fedCut, DATUM_KEYS.fedHold]);
    expect(Object.values(fed).reduce((a, d) => a + d.value, 0)).toBeCloseTo(1, 3);
  });
});
