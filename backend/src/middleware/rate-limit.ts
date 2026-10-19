import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import type { Env } from '../config/env.js';
import { AppError } from '../lib/errors.js';

/**
 * Per-user rate limit for the BiteBot AI chat endpoint.
 * Keyed by user ID (falling back to IP) to prevent proxy abuse.
 */
export function chatRateLimiter(config: Env) {
  return rateLimit({
    windowMs: 60 * 1000,
    limit: config.BITEBOT_RATE_LIMIT_PER_MIN,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req) =>
      req.auth ? `user:${req.auth.user.id}` : `ip:${ipKeyGenerator(req.ip ?? '')}`,
    handler: (_req, _res, next) =>
      next(
        new AppError(429, 'RATE_LIMITED', 'BiteBot rate limit reached. Please wait a minute.'),
      ),
  });
}

/**
 * Limits how often one person can start money- or order-changing actions,
 * keyed by the signed-in user (falling back to the IP address). Reads are
 * never limited here. In-memory: correct for a single server process.
 */
export function moneyActionLimiter(config: Env) {
  return rateLimit({
    windowMs: 60 * 1000,
    limit: config.MONEY_RATE_LIMIT_PER_MIN,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: (req) => req.method === 'GET' || req.method === 'HEAD',
    keyGenerator: (req) =>
      req.auth ? `user:${req.auth.user.id}` : `ip:${ipKeyGenerator(req.ip ?? '')}`,
    handler: (_req, _res, next) =>
      next(
        new AppError(429, 'RATE_LIMITED', 'Too many requests. Please wait a minute and try again.'),
      ),
  });
}
