import { z } from 'zod';

/** Empty strings (docker-compose `${VAR:-}`, blank .env lines) count as unset. */
const str = z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().optional());

const FEED_KEYS = [
  'POLYGON_API_KEY', 'DATABENTO_API_KEY', 'TRADIER_TOKEN', 'ALPACA_KEY_ID', 'ALPACA_SECRET', 'TRADING_ECONOMICS_KEY',
  'FRED_API_KEY', 'BENZINGA_API_KEY', 'KALSHI_KEY_ID', 'SPOTGAMMA_KEY',
] as const;
type FeedKey = (typeof FEED_KEYS)[number];
const feedShape = Object.fromEntries(FEED_KEYS.map((k) => [k, str])) as Record<FeedKey, typeof str>;

const Schema = z.object({
  NODE_ENV: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['development', 'test', 'production']).default('development')),
  PORT: z.preprocess((v) => (v === '' || v === undefined ? undefined : Number(v)), z.number().int().min(1).max(65535).default(8080)),
  /** Bind address. Defaults to loopback outside production so an open dev server is never on the network. */
  HOST: str,
  LOG_LEVEL: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info')),
  /** Single-user passphrase. Required in production; when unset elsewhere the API runs open. */
  DESK_TOKEN: str,
  DATABASE_URL: str,
  REDIS_URL: str,
  VAPID_PUBLIC_KEY: str, VAPID_PRIVATE_KEY: str, VAPID_SUBJECT: str,
  TELEGRAM_BOT_TOKEN: str, TELEGRAM_CHAT_ID: str,
  ANTHROPIC_API_KEY: str,
  /** Overrides the profile's timezone (quiet hours, the 06:30 brief). */
  DESK_TZ: str,
  TV_WEBHOOK_SECRET: str,
  TV_STREAM_SYMBOLS: str,
  ...feedShape,
}).superRefine((e, ctx) => {
  if (e.NODE_ENV === 'production' && !e.DESK_TOKEN) ctx.addIssue({ code: 'custom', path: ['DESK_TOKEN'], message: 'DESK_TOKEN is required in production' });
  if (e.DESK_TOKEN && e.NODE_ENV === 'production' && e.DESK_TOKEN.length < 12) ctx.addIssue({ code: 'custom', path: ['DESK_TOKEN'], message: 'DESK_TOKEN must be at least 12 characters in production' });
  if (Boolean(e.VAPID_PUBLIC_KEY) !== Boolean(e.VAPID_PRIVATE_KEY)) ctx.addIssue({ code: 'custom', path: ['VAPID_PUBLIC_KEY'], message: 'Set both VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY, or neither' });
  if (Boolean(e.TELEGRAM_BOT_TOKEN) !== Boolean(e.TELEGRAM_CHAT_ID)) ctx.addIssue({ code: 'custom', path: ['TELEGRAM_BOT_TOKEN'], message: 'Set both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID, or neither' });
  if (e.DESK_TZ) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: e.DESK_TZ }); } catch { ctx.addIssue({ code: 'custom', path: ['DESK_TZ'], message: `Unknown timezone ${e.DESK_TZ}` }); }
  }
});

export type Env = z.infer<typeof Schema>;

/** Parses and validates the environment. Throws one readable error naming every bad variable. */
export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  const r = Schema.safeParse(source);
  if (!r.success) throw new Error(`Invalid environment: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return r.data;
}
