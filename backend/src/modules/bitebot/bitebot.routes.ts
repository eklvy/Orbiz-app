import { Router } from 'express';
import { z } from 'zod';
import type { Env } from '../../config/env.js';
import type { Database } from '../../lib/prisma.js';
import { requireAuth } from '../../middleware/auth.js';
import { chatRateLimiter } from '../../middleware/rate-limit.js';
import type { ChatProvider } from './bitebot.provider.js';
import { chat } from './bitebot.service.js';

const chatBody = z
  .object({
    message: z.string().trim().min(1, 'Message is required').max(1000, 'Message too long'),
    /** Optional conversation history (client-managed, never stored server-side). */
    history: z
      .array(
        z.object({
          role: z.enum(['user', 'assistant']),
          content: z.string().max(2000),
        }),
      )
      .max(10)
      .optional(),
  })
  .strict();

/**
 * POST /chat/bitebot
 *
 * Requires authentication (any signed-in user).
 * Rate limited per user via BITEBOT_RATE_LIMIT_PER_MIN.
 * Degrades to a static fallback reply if ANTHROPIC_API_KEY is not configured.
 * Never logs message content or personal order details.
 */
export function bitebotRouter(
  db: Database,
  config: Env,
  provider: ChatProvider | null,
) {
  const router = Router();
  router.use(requireAuth);
  router.use(chatRateLimiter(config));

  router.post('/', async (req, res) => {
    const body = chatBody.parse(req.body);

    const result = await chat(db, provider, {
      userId: req.auth!.user.id,
      message: body.message,
      history: body.history,
    });

    res.json(result);
  });

  return router;
}
