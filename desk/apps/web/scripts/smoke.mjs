/* global console, process, fetch, document, window, navigator, setTimeout, URL */
/**
 * Playwright smoke test.
 *   node scripts/smoke.mjs                 serves ./dist (pnpm build:mock) and runs every check, with screenshots
 *   node scripts/smoke.mjs --url https://… runs the contract-agnostic checks against a live deployment
 *                                          (DESK_TOKEN=<passphrase> logs in through the passphrase screen)
 * Flags: --shots <dir> (default ./screenshots), --no-shots.
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './serve.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const remote = arg('--url');
const mock = !remote;
const shotsDir = process.argv.includes('--no-shots') ? null : arg('--shots') ?? join(ROOT, 'screenshots');
if (shotsDir) mkdirSync(shotsDir, { recursive: true });

const results = [];
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    results.push(`ok    ${name}`);
  } catch (e) {
    failed += 1;
    results.push(`FAIL  ${name}\n      ${String(e instanceof Error ? e.message : e).split('\n')[0]}`);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

let stop = () => undefined;
let base = remote?.replace(/\/$/, '');
if (mock) {
  const dir = join(ROOT, 'dist');
  if (!existsSync(join(dir, 'index.html'))) { console.error('No dist/. Run `pnpm --filter @desk/web build:mock` first.'); process.exit(1); }
  const s = await serve(dir);
  base = s.url;
  stop = () => s.server.close();
}

const browser = await chromium.launch();
const errors = [];
function watch(page, label) {
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${label}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
}
const shot = async (page, name, fullPage = false) => { if (shotsDir) await page.screenshot({ path: join(shotsDir, `${name}.png`), fullPage }); };
const noOverflow = async (page, label) => {
  const o = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert(o <= 0, `${label}: page scrolls sideways by ${o}px`);
};
async function login(page) {
  if (await page.getByTestId('login').isVisible().catch(() => false)) {
    assert(process.env.DESK_TOKEN, 'login screen shown; set DESK_TOKEN');
    await page.getByLabel('Passphrase').fill(process.env.DESK_TOKEN);
    await page.getByRole('button', { name: 'Unlock' }).click();
    await page.getByTestId('login').waitFor({ state: 'hidden' });
  }
}
/** Nothing actionable may sit under the fixed tab bar once scrolled to the end. */
async function clearOfTabs(page, label) {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const gap = await page.evaluate(() => {
    const tabs = document.querySelector('nav[aria-label="Tabs"]').getBoundingClientRect();
    const main = document.querySelector('main');
    const last = [...main.querySelectorAll('button, a, input, p, li, td')].filter((e) => e.getClientRects().length > 0 && !e.closest('.fixed')).pop();
    return last ? tabs.top - last.getBoundingClientRect().bottom : 1;
  });
  assert(gap >= 0, `${label}: last element is ${-gap}px under the tab bar`);
  await page.evaluate(() => window.scrollTo(0, 0));
}

/* ───────────── Static assets ───────────── */
await check('manifest served: standalone, 192/512/maskable icons', async () => {
  const r = await fetch(`${base}/manifest.webmanifest`);
  assert(r.ok, `manifest ${r.status}`);
  const m = await r.json();
  assert(m.display === 'standalone' && m.short_name === 'Desk', 'display/short_name');
  assert(['192x192', '512x512'].every((s) => m.icons.some((i) => i.sizes === s)) && m.icons.some((i) => i.purpose === 'maskable'), 'icons');
});
await check('service worker served with push, click and resubscribe handlers', async () => {
  const r = await fetch(`${base}/sw.js`);
  assert(r.ok, `sw.js ${r.status}`);
  const t = await r.text();
  for (const h of ["'push'", "'notificationclick'", "'pushsubscriptionchange'", "'install'", "'fetch'"]) assert(t.includes(`addEventListener(${h}`), `no ${h} handler`);
  assert(!t.includes('@build-inject') && /desk-shell-/.test(t) && /"version":"[0-9a-f]{12}"/.test(t), 'precache list not injected');
});
await check('icons are real PNG files', async () => {
  for (const f of ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png']) {
    const r = await fetch(`${base}/icons/${f}`);
    const b = new Uint8Array(await r.arrayBuffer());
    assert(r.ok && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47, `${f} is not a PNG`);
  }
});
await check('iOS meta tags and viewport-fit=cover in the HTML', async () => {
  const html = await (await fetch(`${base}/`)).text();
  for (const s of ['apple-mobile-web-app-capable', 'apple-mobile-web-app-status-bar-style', 'viewport-fit=cover', 'apple-touch-icon', 'rel="manifest"']) assert(html.includes(s), `missing ${s}`);
});

/* ───────────── Phone, 390x844 ───────────── */
const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const p = await phone.newPage();
watch(p, 'phone');

await check('Now: bias card answers in the top third, single action button', async () => {
  await p.goto(`${base}/`);
  await login(p);
  const call = p.getByTestId('bias-call');
  await call.waitFor();
  const box = await call.boundingBox();
  assert(box && box.y + box.height < 844 / 3, `call text ends at ${box?.y + box?.height}px, below the top third`);
  const action = (await p.getByTestId('bias-action').innerText()).trim();
  assert(/^(Open ticket|No edge|Read-only)$/.test(action), `action button says "${action}"`);
  await p.getByTestId('health').waitFor();
  if (mock) {
    assert(await p.getByTestId('mock-badge').isVisible(), 'MOCK badge not visible');
    const times = await p.getByTestId('feed').locator('li p:first-child').allInnerTexts();
    assert(times.length > 0 && times.every((t) => t.length <= 280), 'feed empty or an update over 280 chars');
    assert(/\d/.test(await p.getByTestId('countdown').innerText()), 'no countdown');
    assert((await p.locator('#rates').innerText()).includes('old'), 'stale FedWatch odds do not show their age');
  }
  await noOverflow(p, 'Now');
  await shot(p, 'phone-now');
  await shot(p, 'phone-now-full', true);
  await clearOfTabs(p, 'Now');
});
await check('Now: refresh calls POST /api/refresh and the view survives', async () => {
  await p.getByTestId('refresh').click();
  await p.getByTestId('refresh').getByText('Refresh', { exact: true }).waitFor();
  await p.getByTestId('bias-call').waitFor();
});
await check('service worker registers and activates', async () => {
  const state = await p.evaluate(() => Promise.race([navigator.serviceWorker.ready.then((r) => r.active?.state ?? 'none'), new Promise((r) => setTimeout(() => r('timeout'), 10_000))]));
  assert(state === 'activated' || state === 'activating', `service worker state: ${state}`);
});

await check('Catalysts: 7-day timeline, Tier 1 marked', async () => {
  await p.getByTestId('tab-catalysts').click();
  await p.getByTestId('timeline').waitFor();
  const rows = p.getByTestId('catalyst-row');
  if (mock) {
    assert((await rows.count()) >= 5, 'timeline rows missing');
    const color = await p.locator('[data-testid="catalyst-row"][data-tier="1"] span span').first().evaluate((e) => window.getComputedStyle(e).color);
    assert(/255,\s*107,\s*107|0\.7\d* 0\.1\d* 2\d/.test(color) || color.includes('oklch') || color.includes('255'), `Tier 1 is not red: ${color}`);
  }
  await noOverflow(p, 'Catalysts');
  await shot(p, 'phone-catalysts');
});
await check('Catalyst card: matrix, history, odds, the one line', async () => {
  const row = mock ? p.locator('[data-testid="catalyst-row"][href*="cat_cpi"]') : p.getByTestId('catalyst-row').first();
  if ((await row.count()) === 0) return;
  await row.click();
  await p.getByTestId('catalyst-card').waitFor();
  if (await p.getByTestId('reaction-clock').isVisible().catch(() => false)) await p.getByTestId('clock-dismiss').click();
  if (mock) {
    assert((await p.getByTestId('matrix-branch').count()) === 4, 'expected 4 branches');
    assert((await p.getByTestId('history').locator('tbody tr').count()) === 6, 'history rows');
    const line = await p.getByTestId('one-line').boundingBox();
    assert(line && line.y < 844 / 3, 'the engine line is not in the top third');
  }
  await noOverflow(p, 'Catalyst card');
  await shot(p, 'phone-catalyst-card');
  await shot(p, 'phone-catalyst-card-full', true);
  await clearOfTabs(p, 'Catalyst card');
});
if (mock) {
  await check('Catalyst just resolved: full-screen reaction clock', async () => {
    await p.goto(`${base}/catalysts/?id=cat_ppi`);
    await p.getByTestId('reaction-clock').waitFor();
    assert(/^\d\d:\d\d$/.test((await p.getByTestId('clock').innerText()).trim()), 'clock not running');
    const box = await p.getByTestId('reaction-clock').boundingBox();
    assert(box && box.x === 0 && box.y === 0 && box.width === 390 && box.height === 844, `clock is not full-screen: ${JSON.stringify(box)}`);
    await noOverflow(p, 'Reaction clock');
    await shot(p, 'phone-catalyst-live');
    await p.getByTestId('clock-dismiss').click();
    await p.getByTestId('reaction-clock').waitFor({ state: 'hidden' });
  });
}

await check('Positions: rows, status chips, accounts, hedge violation on top', async () => {
  await p.goto(`${base}/positions/`);
  await p.getByTestId('positions-screen').waitFor();
  if (mock) {
    assert((await p.getByTestId('position-row').count()) === 3, 'expected 3 positions');
    assert((await p.getByTestId('account-row').count()) === 3, 'expected 3 accounts');
    const hv = await p.getByTestId('hedge-violation').boundingBox();
    const first = await p.getByTestId('position-row').first().boundingBox();
    assert(hv && first && hv.y < first.y, 'hedge violation is not above the positions');
    const text = await p.getByTestId('position-row').first().innerText();
    for (const s of ['thin', 'pts', '%', 'next out', 'time stop']) assert(text.toLowerCase().includes(s), `row lacks "${s}"`);
  }
  await noOverflow(p, 'Positions');
  await shot(p, 'phone-positions');
  await shot(p, 'phone-positions-full', true);
  await clearOfTabs(p, 'Positions');
});
if (mock) {
  await check('Positions: tap shows the ticket and the override ledger; balance and manual position forms work', async () => {
    await p.getByTestId('position-row').first().click();
    await p.getByTestId('override-ledger').getByText('across 7').waitFor();
    await shot(p, 'phone-position-detail');
    await p.getByRole('button', { name: 'Close' }).click();
    await p.getByTestId('edit-balance').first().click();
    await p.getByLabel(/Balance for/).fill('5500');
    await p.getByRole('button', { name: 'Save', exact: true }).click();
    await p.getByTestId('account-row').first().getByText('$5,500').waitFor();
    await p.getByTestId('add-position').click();
    const form = p.getByTestId('add-position-form');
    await form.getByLabel(/Size/).fill('1000');
    await form.getByLabel('Entry price').fill('27050');
    await form.getByRole('button', { name: 'Add position' }).click();
    await p.getByTestId('position-row').nth(3).waitFor();
    await p.getByTestId('position-row').nth(3).click();
    await p.getByTestId('remove-position').click();
    await p.getByTestId('remove-confirm').click();
    await p.getByTestId('position-row').nth(3).waitFor({ state: 'detached' });
  });
}

await check('Ticket: save is blocked without targets and invalidation, in the server’s words', async () => {
  await p.goto(`${base}/ticket/`);
  await login(p);
  await p.getByTestId('ticket-form').waitFor();
  await p.getByTestId('save-status').getByText(/Blocked/).waitFor();
  assert(await p.getByTestId('save-ticket').isDisabled(), 'save is enabled on an empty ticket');
  if (mock) {
    const text = await p.getByTestId('ticket-form').innerText();
    for (const s of ['No catalyst, no trade. Pick a catalyst', 'Exits are written before entry', 'One invalidation']) assert(text.includes(s), `server error not shown: "${s}"`);
  }
  await noOverflow(p, 'Ticket');
  await shot(p, 'phone-ticket');
  await shot(p, 'phone-ticket-full', true);
});
if (mock) {
  await check('Ticket: size is read-only from the preview, the slider only reduces, save unlocks when the server says ok', async () => {
    await p.getByTestId('sizing').waitFor();
    const slider = p.getByTestId('size-slider');
    assert((await p.locator('input[data-testid="size-value"], [data-testid="sizing"] input:not([type="range"])').count()) === 0, 'size has a typed input');
    const max = Number(await slider.getAttribute('max'));
    assert(max === 60000 && Number(await slider.inputValue()) === max, 'slider does not start at the engine max');
    await slider.fill(String(max * 2)).catch(() => undefined);
    assert(Number(await slider.inputValue()) <= max, 'slider went above the engine max');
    await slider.fill('30000');
    assert((await p.getByTestId('size-value').innerText()).includes('30.0K'), 'reduced size not shown');
    await p.getByTestId('reason-catalyst').selectOption('cat_ppi');
    await p.getByTestId('entry-text').fill('Rejection at 27,130 on the second move');
    for (const [i, v] of [[1, '27000'], [2, '26920'], [3, '26810']]) await p.getByTestId(`t${i}-price`).fill(v);
    await p.getByTestId('inv-price').fill('27215');
    await p.getByTestId('save-status').getByText(/Blocked: 2 fields/).waitFor();
    assert(await p.getByTestId('save-ticket').isDisabled(), 'save enabled without invalidation reason and time stop');
    await p.getByTestId('inv-reason').fill('Reclaims the after-hours high');
    const d = new Date(Date.now() + 2 * 3_600_000);
    const pad = (n) => String(n).padStart(2, '0');
    await p.getByTestId('time-stop').fill(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`);
    await p.getByTestId('save-status').getByText('planned').waitFor();
    await p.getByTestId('save-ticket').and(p.locator(':enabled')).waitFor();
    await shot(p, 'phone-ticket-ready');
    await p.evaluate(() => window.scrollTo(0, 600));
    await shot(p, 'phone-ticket-size');
    await p.getByTestId('save-ticket').click();
    await p.getByTestId('ticket-detail').waitFor();
    assert((await p.getByTestId('ticket-detail').innerText()).includes('of engine max'), 'saved ticket lacks the size line');
  });
  await check('Ticket: a hold through a Tier-1 catalyst is blocked with the guardrail text', async () => {
    await p.goto(`${base}/ticket/?prefill=ntf_ppi`);
    await p.getByTestId('prefilled').waitFor();
    await p.getByTestId('save-status').getByText('planned').waitFor();
    assert((await p.getByTestId('t1-price').inputValue()) === '27000' && (await p.getByTestId('reason-catalyst').inputValue()) === 'cat_ppi', 'notification prefill did not populate the form');
    const d = new Date(Date.now() + 30 * 3_600_000);
    const pad = (n) => String(n).padStart(2, '0');
    await p.getByTestId('time-stop').fill(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`);
    await p.getByTestId('guardrail').getByText(/cannot survive CPI/).waitFor();
    await p.getByTestId('save-status').getByText(/Blocked/).waitFor();
    assert(await p.getByTestId('save-ticket').isDisabled(), 'save enabled while a guardrail blocks');
    await shot(p, 'phone-ticket-guardrail', true);
  });
  await check('Ticket: prefill from the bias call', async () => {
    await p.goto(`${base}/`);
    await p.getByTestId('bias-action').click();
    await p.getByTestId('prefilled').getByText(/bias call/).waitFor();
    assert((await p.getByTestId('inv-price').inputValue()) === '27215', 'bias-call prefill missing invalidation');
  });
  await check('Ticket detail: fill, override prompt needs a one-line reason, close', async () => {
    await p.goto(`${base}/ticket/?id=tkt_open`);
    await p.getByTestId('ticket-detail').waitFor();
    await p.getByTestId('ledger').waitFor();
    await noOverflow(p, 'Ticket detail');
    await shot(p, 'phone-ticket-detail', true);
    await p.getByTestId('override-btn').click();
    await p.getByTestId('override-prompt').getByText(/month to date/).waitFor();
    assert(await p.getByTestId('override-submit').isDisabled(), 'override can be logged without a reason');
    await shot(p, 'phone-override');
    await p.getByTestId('override-reason').fill('Want the close');
    await p.getByTestId('override-submit').click();
    await p.getByTestId('ticket-detail').getByText('“Want the close”').waitFor();
    await p.getByTestId('fill-btn').click();
    const f = p.getByTestId('fill-form');
    await f.getByLabel('Fill price').fill('27000');
    await f.getByLabel(/Size filled/).fill('20000');
    await f.getByRole('button', { name: 'Record fill' }).click();
    await p.getByTestId('ticket-detail').getByText(/scale out · \$20\.0K @ 27,000/).waitFor();
    await p.getByTestId('close-btn').click();
    await p.getByLabel('Exit price').fill('26950');
    await p.getByRole('button', { name: 'Close and score' }).click();
    await p.getByTestId('ticket-detail').getByText('closed', { exact: true }).waitFor();
  });
}

await check('Journal: adherence leads, above P&L; calibration chart with n and source', async () => {
  await p.goto(`${base}/journal/`);
  await login(p);
  await p.getByTestId('journal-screen').waitFor();
  const a = await p.getByTestId('adherence').boundingBox();
  assert(a && a.y + a.height < 844 / 3, 'adherence is not in the top third');
  if (mock) {
    await p.getByTestId('calibration').waitFor();
    assert((await p.getByTestId('calibration').locator('circle').count()) === 6, 'expected 6 scored buckets');
    const card = await p.locator('section', { has: p.getByTestId('calibration') }).innerText();
    assert(/replay/i.test(card) && card.includes('n = 212'), 'calibration lacks source or n');
    for (const k of ['calls', 'events', 'notes']) {
      await p.getByRole('button', { name: new RegExp(`^${k}$`, 'i') }).click();
      assert((await p.getByTestId(`list-${k}`).locator('li').count()) > 0, `${k} list empty`);
    }
    await p.getByTestId('journal-filter').fill('zzzz');
    await p.getByText('Nothing matches.').waitFor();
    await p.getByTestId('journal-filter').fill('');
    await p.getByLabel('Note', { exact: true }).fill('Smoke note');
    await p.getByRole('button', { name: 'Save note' }).click();
    await p.getByTestId('list-notes').getByText('Smoke note').waitFor();
    await p.getByRole('button', { name: /^trades$/i }).click();
    assert((await p.getByTestId('scorecard').locator('tbody tr').count()) === 4, 'scorecard rows');
  }
  await noOverflow(p, 'Journal');
  await p.evaluate(() => window.scrollTo(0, 0));
  await shot(p, 'phone-journal');
  await shot(p, 'phone-journal-full', true);
  await clearOfTabs(p, 'Journal');
});
await check('Journal: weekly review, morning brief and recap render', async () => {
  for (const v of ['weekly', 'morning', 'recap']) {
    await p.getByTestId(`journal-nav-${v}`).click();
    await p.locator(`[data-testid="brief-${v}"], section:has-text("yet")`).first().waitFor();
    if (v === 'weekly') await shot(p, 'phone-weekly');
  }
  await noOverflow(p, 'Briefs');
});

await check('Ask: answers carry an as-of time and a check-live button', async () => {
  await p.getByTestId('tab-ask').click();
  await login(p);
  await p.getByTestId('ask-screen').waitFor();
  if (mock) {
    await p.getByTestId('desk-answer').first().waitFor();
    await p.getByLabel('Question').fill('Should I keep holding it fully?');
    await p.getByRole('button', { name: 'Ask', exact: true }).click();
    await p.getByTestId('desk-answer').nth(1).waitFor();
    assert((await p.getByTestId('guardrail').count()) === 1, 'guardrail firing not rendered');
    await p.getByLabel('Question').fill('but should I hold?');
    await p.getByRole('button', { name: 'Ask', exact: true }).click();
    await p.getByTestId('desk-answer').nth(2).waitFor();
    assert((await p.getByTestId('guardrail').count()) === 1, 'guardrail rendered twice in one episode');
    await p.getByTestId('check-live').last().click();
    await p.getByTestId('desk-answer').nth(3).waitFor();
    const n = await p.getByTestId('desk-answer').count();
    assert((await p.getByTestId('as-of').filter({ hasText: 'Data as of' }).count()) === n && (await p.getByTestId('check-live').count()) === n, 'an answer lacks as-of or check live');
  }
  await noOverflow(p, 'Ask');
  await shot(p, 'phone-ask');
});

await check('Chart: Lightweight Charts renders with timeframe switch, lazy-loaded', async () => {
  await p.goto(`${base}/chart/?symbol=NQ`);
  await login(p);
  await p.getByTestId('chart-canvas').locator('canvas').first().waitFor();
  for (const tf of ['1m', '1H', 'Daily', '15m']) await p.getByRole('button', { name: tf, exact: true }).click();
  if (mock) await p.getByText('FAIL', { exact: false }).first().waitFor({ state: 'attached' }).catch(() => undefined);
  await p.waitForTimeout(600);
  await noOverflow(p, 'Chart');
  await shot(p, 'phone-chart');
});
await check('Now route does not load the chart library', async () => {
  const fresh = await phone.newPage();
  const scripts = [];
  fresh.on('response', (r) => { if (r.url().endsWith('.js')) scripts.push(r); });
  await fresh.goto(`${base}/`);
  await fresh.getByTestId('bias-call').waitFor();
  let hit = false;
  for (const r of scripts) if ((await r.text().catch(() => '')).includes('attributionLogo')) hit = true;
  await fresh.close();
  assert(!hit, 'lightweight-charts was fetched on the Now route');
});

await check('Settings: notifications, kill switch with confirm, quiet hours, memo approval', async () => {
  await p.goto(`${base}/`);
  await p.getByTestId('settings-btn').click();
  const dlg = p.getByRole('dialog', { name: 'Settings' });
  await dlg.getByText('Quiet hours').waitFor();
  await dlg.getByText(/Kill switch is/).waitFor();
  await shot(p, 'phone-settings');
  if (mock) {
    await dlg.getByTestId('kill-toggle').click();
    assert((await dlg.getByText('Kill switch is off').count()) === 1, 'kill switch flipped without the confirm step');
    await dlg.getByTestId('kill-confirm').click();
    await dlg.getByText('ON', { exact: true }).waitFor();
    await dlg.getByTestId('kill-toggle').click();
    await dlg.getByTestId('kill-confirm').click();
    await dlg.getByRole('button', { name: 'Approve' }).click();
    await dlg.getByText('Approved').waitFor();
  }
});
await check('Settings on iPhone Safari (not installed): Add to Home Screen instruction', async () => {
  const ios = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' });
  const ip = await ios.newPage();
  await ip.goto(`${base}/`);
  await login(ip);
  await ip.getByTestId('settings-btn').click();
  await ip.getByTestId('a2hs').waitFor();
  assert((await ip.getByTestId('enable-push').count()) === 0, 'enable button offered before install');
  await ios.close();
});

/* ───────────── Desktop, 1440x900 ───────────── */
const desk = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const d = await desk.newPage();
watch(d, 'desktop');
await check('Desktop: three columns, chart in the center', async () => {
  await d.goto(`${base}/`);
  await login(d);
  await d.getByTestId('desktop-grid').waitFor();
  await d.getByTestId('col-center').getByTestId('chart-canvas').locator('canvas').first().waitFor();
  await d.getByTestId('col-left').getByTestId('bias-call').waitFor();
  await d.getByTestId('col-left').getByTestId('positions-screen').waitFor();
  await d.getByTestId('col-right').getByTestId('timeline').waitFor();
  const [l, c, r] = await Promise.all(['col-left', 'col-center', 'col-right'].map((id) => d.getByTestId(id).boundingBox()));
  assert(l.x < c.x && c.x < r.x && c.width > l.width, 'columns are not left / center / right');
  assert(!(await d.locator('nav[aria-label="Tabs"]').isVisible()), 'bottom tabs visible on desktop');
  await d.waitForTimeout(600);
  await noOverflow(d, 'Desktop');
  await shot(d, 'desktop-grid');
});
await check('Desktop: "t" opens a ticket, but not while typing', async () => {
  await d.goto(`${base}/ask/`);
  await d.getByLabel('Question').fill('test');
  await d.getByLabel('Question').press('t');
  assert(new URL(d.url()).pathname.startsWith('/ask'), '"t" in a field navigated away');
  await d.locator('body').click({ position: { x: 5, y: 300 } });
  await d.keyboard.press('t');
  await d.getByTestId('ticket-form').waitFor();
  await shot(d, 'desktop-ticket');
});
if (mock) {
  await check('Desktop: catalyst card renders the matrix as a table', async () => {
    await d.goto(`${base}/catalysts/?id=cat_cpi`);
    await d.getByTestId('matrix').waitFor();
    assert(await d.getByTestId('matrix').locator('thead').isVisible(), 'matrix header row hidden');
    await shot(d, 'desktop-catalyst-card');
  });
}

/* ───────────── Production bundle: 401 login, offline last-known state ───────────── */
if (mock && existsSync(join(ROOT, 'out', 'index.html'))) {
  const prod = await serve(join(ROOT, 'out'));
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, serviceWorkers: 'block' });
  const q = await ctx.newPage();
  const stamped = { value: null, asOf: null, source: null, stale: false, age: null };
  const view = {
    asOf: new Date().toISOString(), primary: null, calls: [], updates: [], quotes: {}, nextCatalyst: null, headlines: [], feedHealth: [],
    rates: { y2: stamped, y10: stamped, y30: stamped, y2Chg1hBp: null, y10Chg1hBp: null, y2Chg1dBp: null, y10Chg1dBp: null, spread2s10sBp: null, fed: { hike: stamped, cut: stamped, hold: stamped, meeting: null } },
    session: { killSwitch: false, readOnly: false, readOnlyReason: null, quietHours: false },
  };
  let authed = false, down = false;
  await ctx.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (down) return route.abort('internetdisconnected');
    if (path === '/api/auth/login') {
      authed = route.request().postDataJSON()?.token === 'open-sesame';
      return route.fulfill({ status: authed ? 200 : 401, json: authed ? { ok: true } : { error: 'Wrong passphrase.' } });
    }
    if (!authed) return route.fulfill({ status: 401, json: { error: 'Unauthorized' } });
    if (path === '/api/now') return route.fulfill({ json: view });
    return route.fulfill({ status: 404, json: { error: 'Not found' } });
  });
  await check('Production bundle: no MOCK badge; a 401 shows the passphrase screen; login unlocks', async () => {
    await q.goto(`${prod.url}/`);
    await q.getByTestId('login').waitFor();
    assert((await q.getByTestId('mock-badge').count()) === 0, 'MOCK badge in the production bundle');
    await q.getByLabel('Passphrase').fill('wrong');
    await q.getByRole('button', { name: 'Unlock' }).click();
    await q.getByRole('alert').getByText('Wrong passphrase.').waitFor();
    await q.getByLabel('Passphrase').fill('open-sesame');
    await q.getByRole('button', { name: 'Unlock' }).click();
    await q.getByTestId('login').waitFor({ state: 'hidden' });
    await q.getByTestId('bias-call').getByText('No call yet').waitFor();
    assert((await q.getByTestId('bias-action').innerText()).trim() === 'No edge', 'null call does not render No edge');
  });
  await check('Offline: last-known state from localStorage with a visible "Stale since HH:MM" stamp', async () => {
    down = true;
    await q.reload();
    await q.getByTestId('bias-call').waitFor();
    const stale = await q.getByTestId('stale').first().innerText();
    assert(/^Stale since \d\d:\d\d/.test(stale), `stamp reads "${stale}"`);
    await shot(q, 'phone-offline-stale');
  });
  await ctx.close();
  prod.server.close();
}

await check('no console errors on any screen', async () => {
  assert(errors.length === 0, `${errors.length} console error(s): ${errors.slice(0, 5).join(' | ')}`);
});

await browser.close();
stop();
console.log(results.join('\n'));
console.log(`\n${results.length - failed}/${results.length} checks passed against ${mock ? 'the mock build' : base}${shotsDir ? `; screenshots in ${shotsDir}` : ''}`);
process.exit(failed ? 1 : 0);
