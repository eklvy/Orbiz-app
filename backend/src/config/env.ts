import { z } from 'zod';

/**
 * All backend configuration is read and validated here, once, at startup.
 * If anything is missing or invalid the process exits with a clear message
 * instead of failing later in a confusing way.
 *
 * Nothing in this file is ever sent to the browser.
 */

const booleanFromString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

/** Comma-separated email list → normalised, de-duplicated array. */
const emailList = z
  .string()
  .default('')
  .transform((raw) =>
    raw
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter((email) => email.length > 0),
  )
  .pipe(z.array(z.email()))
  .transform((emails) => [...new Set(emails)]);

/** Comma-separated domain list → normalised, de-duplicated array. "@ncuindia.edu" also works. */
const domainList = z
  .string()
  .default('')
  .transform((raw) =>
    raw
      .split(',')
      .map((domain) => domain.trim().toLowerCase().replace(/^@/, ''))
      .filter((domain) => domain.length > 0),
  )
  .pipe(
    z.array(
      z
        .string()
        .regex(
          /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/,
          'must be a bare domain such as ncuindia.edu',
        ),
    ),
  )
  .transform((domains) => [...new Set(domains)]);

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),

    FRONTEND_URL: z.url(),
    BACKEND_URL: z.url(),

    // Signs the short-lived OAuth state cookie. Generate with: openssl rand -base64 48
    SESSION_SECRET: z.string().min(32, 'must be at least 32 characters'),

    // Google sign-in is disabled (with a clear message) until all three are set.
    // They are required in production.
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    GOOGLE_CALLBACK_URL: z.url().optional(),

    /** Max sign-in attempts per IP per 15 minutes. */
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
    /**
     * Which proxies to trust for the client IP (used by rate limits). Express syntax:
     * "loopback" (default, proxy on the same machine), a hop count like "1", or IPs/subnets.
     */
    TRUST_PROXY: z
      .string()
      .default('loopback')
      .transform((v) => (/^\d+$/.test(v) ? Number(v) : v)),
    /** Max money/order actions (recharges, checkouts, cancels, payment outcomes) per user per minute. */
    MONEY_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(20),
    /**
     * Orders each outlet takes on per rolling 3 minutes. The business rule is 10; it can only be
     * changed outside production (the end-to-end suite raises it so its many orders fit).
     */
    ORDER_CAPACITY_PER_WINDOW: z.coerce.number().int().min(1).max(10_000).default(10),

    /** Pickup verification: numeric code length (6 or 8 digits). */
    PICKUP_CODE_DIGITS: z.coerce
      .number()
      .int()
      .refine((v) => v === 6 || v === 8, 'must be 6 or 8')
      .default(6),
    /** How long a pickup code stays valid after the order is ready (the student can refresh it). */
    PICKUP_CODE_TTL_MINUTES: z.coerce.number().int().min(10).max(2880).default(720),

    MANAGER_ALLOWED_EMAILS: emailList,
    POS_ALLOWED_EMAILS: emailList,

    /**
     * Email domains allowed to sign in at all. EMPTY (the default) allows any domain,
     * which is the behaviour this project shipped with. Set it to restrict sign-in,
     * e.g. ALLOWED_EMAIL_DOMAINS=ncuindia.edu
     */
    ALLOWED_EMAIL_DOMAINS: domainList,

    PAYMENT_MOCK_ENABLED: booleanFromString,
    DEV_LOGIN_ENABLED: booleanFromString,

    // ─── BiteBot AI chat (optional — degrades gracefully when not set) ────────
    /** Anthropic API key. Set to enable BiteBot. Never sent to the browser. */
    ANTHROPIC_API_KEY: z.string().optional(),
    /** Max BiteBot chat requests per signed-in user per minute. */
    BITEBOT_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(10),

    // ₹99 is also enforced in code as a floor (loyalty.rules.ts); this can only raise it.
    WALLET_RECHARGE_MIN_PAISE: z.coerce.number().int().positive().default(9_900),
    WALLET_RECHARGE_MAX_PAISE: z.coerce.number().int().positive().default(200_000),
    WALLET_MAX_BALANCE_PAISE: z.coerce.number().int().positive().default(500_000),

    // ─── Review photo uploads ─────────────────────────────────────────────────
    /** Filesystem path where uploaded review photos are stored. */
    UPLOAD_DIR: z.string().default('/tmp/orbiz-uploads'),
    /** Maximum upload size in megabytes. */
    UPLOAD_MAX_SIZE_MB: z.coerce.number().int().min(1).max(50).default(5),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production') {
      for (const key of [
        'GOOGLE_CLIENT_ID',
        'GOOGLE_CLIENT_SECRET',
        'GOOGLE_CALLBACK_URL',
      ] as const) {
        if (!env[key]) {
          ctx.addIssue({ code: 'custom', path: [key], message: 'Required in production.' });
        }
      }
      // Simulated money and the developer login must never be reachable in production.
      if (env.PAYMENT_MOCK_ENABLED) {
        ctx.addIssue({
          code: 'custom',
          path: ['PAYMENT_MOCK_ENABLED'],
          message: 'Mock payments cannot be enabled in production.',
        });
      }
      if (env.ORDER_CAPACITY_PER_WINDOW !== 10) {
        ctx.addIssue({
          code: 'custom',
          path: ['ORDER_CAPACITY_PER_WINDOW'],
          message: 'The order capacity is fixed at 10 per 3 minutes in production.',
        });
      }
      if (env.DEV_LOGIN_ENABLED) {
        ctx.addIssue({
          code: 'custom',
          path: ['DEV_LOGIN_ENABLED'],
          message: 'The developer login cannot be enabled in production.',
        });
      }
    }
    if (env.WALLET_RECHARGE_MIN_PAISE > env.WALLET_RECHARGE_MAX_PAISE) {
      ctx.addIssue({
        code: 'custom',
        path: ['WALLET_RECHARGE_MIN_PAISE'],
        message: 'Minimum recharge cannot exceed the maximum recharge.',
      });
    }
    if (env.WALLET_RECHARGE_MAX_PAISE > env.WALLET_MAX_BALANCE_PAISE) {
      ctx.addIssue({
        code: 'custom',
        path: ['WALLET_RECHARGE_MAX_PAISE'],
        message: 'Maximum recharge cannot exceed the maximum wallet balance.',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
}

/** Returns the Google OAuth settings, or null when sign-in with Google isn't configured. */
export function googleConfig(config: Env): GoogleConfig | null {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_CALLBACK_URL } = config;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_CALLBACK_URL) return null;
  return {
    clientId: GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
    callbackUrl: GOOGLE_CALLBACK_URL,
  };
}

/** True when the developer/test login may be offered. Never true in production. */
export function devLoginAllowed(config: Env): boolean {
  return config.DEV_LOGIN_ENABLED && config.NODE_ENV !== 'production';
}

export function parseEnv(source: NodeJS.ProcessEnv): Env {
  // `KEY=` in a .env file means "not set", not "set to an empty string".
  const defined = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ''));
  const result = envSchema.safeParse(defined);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return result.data;
}

export const env: Env = parseEnv(process.env);
