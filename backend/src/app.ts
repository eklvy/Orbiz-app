import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import { env, googleConfig, type Env } from './config/env.js';
import { logger } from './lib/logger.js';
import type { Database } from './lib/prisma.js';
import { healthRouter } from './modules/health/health.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { createGoogleClient, type GoogleOAuthClient } from './modules/auth/google.js';
import { profileRouter } from './modules/users/profile.routes.js';
import { publicOutletsRouter } from './modules/outlets/public.routes.js';
import { staffOutletsRouter } from './modules/outlets/staff.routes.js';
import { adminOutletsRouter } from './modules/outlets/admin.routes.js';
import { cartRouter } from './modules/cart/cart.routes.js';
import { walletRouter } from './modules/wallet/wallet.routes.js';
import { ordersRouter } from './modules/orders/orders.routes.js';
import { mockPaymentsRouter } from './modules/payments/mock.routes.js';
import { rechargeProviderFor } from './modules/payments/providers.js';
import { staffOrdersRouter } from './modules/orders/staff-orders.routes.js';
import { adminAuditRouter, adminUsersRouter } from './modules/users/admin-users.routes.js';
import {
  outletPollRouter,
  specialsRouter,
  staffPollsRouter,
  votesRouter,
} from './modules/polls/polls.routes.js';
import { noopPublisher, type RealtimePublisher } from './realtime/publisher.js';
import { surpriseMealRouter } from './modules/surprise/surprise.routes.js';
import { advisorFor, type ComboAdvisor } from './modules/surprise/surprise.ai.js';
import { inventoryRouter } from './modules/inventory/inventory.routes.js';
import { planningRouter } from './modules/planning/planning.routes.js';
import { groupsRouter } from './modules/groups/groups.routes.js';
import { splitsRouter } from './modules/splits/splits.routes.js';
import { banquetsRouter, staffBanquetsRouter } from './modules/banquets/banquets.routes.js';
import { slotsRouter, staffScheduleRouter } from './modules/scheduling/scheduling.routes.js';
import { adminNoShowRouter } from './modules/noshow/noshow.routes.js';
import {
  menuItemReviewsRouter,
  myReviewsRouter,
  reviewsRouter,
  staffReviewsRouter,
} from './modules/reviews/reviews.routes.js';
import { reorderRouter, savedCombosRouter } from './modules/reorder/reorder.routes.js';
import { staffPickupRouter, studentPickupRouter } from './modules/pickup/pickup.routes.js';
import { campusMenuRouter } from './modules/menu/menu.routes.js';
import { menuItemNutritionRouter } from './modules/menu/nutrition.routes.js';
import { campusMapRouter } from './modules/map/map.routes.js';
import { notificationsRouter } from './modules/notifications/notifications.routes.js';
import { publicTablesRouter, staffTablesRouter } from './modules/tables/tables.routes.js';
import { reservationsRouter, staffReservationsRouter } from './modules/tables/reservations.routes.js';
import { bitebotRouter } from './modules/bitebot/bitebot.routes.js';
import { bitebotProviderFor, type ChatProvider } from './modules/bitebot/bitebot.provider.js';
import {
  adminRewardsRouter,
  myRewardsRouter,
  redeemRewardRouter,
  rewardsRouter,
} from './modules/rewards/rewards.routes.js';
import { myBudgetRouter, adminUserBudgetRouter } from './modules/budget/budget.routes.js';
import { studentInvoiceRouter, adminInvoiceRouter } from './modules/invoice/invoice.routes.js';
import {
  orderRefundRouter,
  adminRefundRouter,
  staffRefundRouter,
} from './modules/refunds/refund.routes.js';
import { kitchenRouter, trackingRouter } from './modules/kitchen/kitchen.routes.js';
import { uploadsRouter } from './modules/uploads/upload.routes.js';
import { csrfProtection } from './middleware/csrf.js';
import { loadSession } from './middleware/auth.js';
import { moneyActionLimiter } from './middleware/rate-limit.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';

export interface AppDependencies {
  db: Database;
  /** Defaults to the validated process environment. Tests pass their own. */
  config?: Env;
  /** Defaults to the real Google client when credentials are configured, else null. */
  google?: GoogleOAuthClient | null;
  /** Where post-commit notifications go. Defaults to a no-op (no socket server). */
  realtime?: RealtimePublisher;
  /** Optional AI step for Surprise Meal. Defaults to none configured; tests pass a fake. */
  comboAdvisor?: ComboAdvisor | null;
  /** Optional AI provider for BiteBot chat. Defaults to Claude when ANTHROPIC_API_KEY is set. */
  chatProvider?: ChatProvider | null;
}

/**
 * Builds the Express app without starting a server, so tests can call it
 * directly with Supertest.
 */
export function createApp({
  db,
  config = env,
  google,
  realtime = noopPublisher,
  comboAdvisor = advisorFor(),
  chatProvider,
}: AppDependencies) {
  const resolvedChatProvider =
    chatProvider !== undefined ? chatProvider : bitebotProviderFor(config.ANTHROPIC_API_KEY);
  const googleSettings = googleConfig(config);
  const googleClient =
    google !== undefined ? google : googleSettings ? createGoogleClient(googleSettings) : null;

  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY);

  app.use(pinoHttp({ logger }));
  app.use(helmet());
  // Only our own frontend may call the API with cookies.
  app.use(cors({ origin: config.FRONTEND_URL, credentials: true }));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser(config.SESSION_SECRET));

  const api = express.Router();
  api.use(csrfProtection(config));
  api.use(loadSession(db, config));
  // Recharges, checkouts, cancellations, payment outcomes, votes and reviews: per-user limit.
  api.use(
    [
      '/orders',
      '/wallet/recharges',
      '/payments/mock',
      '/polls',
      '/splits',
      '/banquets',
      '/menu-items',
      '/reviews',
      '/reorder',
      '/saved-combos',
    ],
    moneyActionLimiter(config),
  );
  api.use('/health', healthRouter(db));
  api.use('/auth', authRouter({ db, config, google: googleClient, realtime }));
  api.use('/me/profile', profileRouter(db));
  api.use('/me/reviews', myReviewsRouter(db));
  api.use('/me/notifications', notificationsRouter(db));
  api.use('/menu-items', menuItemNutritionRouter(db));
  api.use('/menu-items', menuItemReviewsRouter(db));
  api.use('/reviews', reviewsRouter(db));
  api.use('/outlets/:slug/slots', slotsRouter(db));
  api.use('/outlets/:slug/tables', publicTablesRouter(db));
  api.use('/outlets/:slug', outletPollRouter(db, realtime));
  api.use('/outlets', publicOutletsRouter(db));
  api.use('/map', campusMapRouter(db));
  api.use('/menu', campusMenuRouter(db));
  api.use('/specials', specialsRouter(db, realtime));
  api.use('/polls', votesRouter(db, realtime));
  api.use('/staff/outlets/:outletId/orders', staffOrdersRouter(db, realtime));
  api.use('/staff/outlets/:outletId/polls', staffPollsRouter(db, realtime));
  api.use('/staff/outlets/:outletId/inventory', inventoryRouter(db, realtime));
  api.use('/staff/outlets/:outletId/planning', planningRouter(db, realtime));
  api.use('/staff/outlets/:outletId/schedule', staffScheduleRouter(db));
  api.use('/staff/outlets/:outletId/reviews', staffReviewsRouter(db));
  api.use('/staff/outlets/:outletId/pickup', staffPickupRouter(db, realtime));
  api.use('/staff/outlets/:outletId/kitchen', kitchenRouter(db, realtime));
  api.use('/staff/outlets', staffOutletsRouter(db, realtime));
  api.use('/admin/outlets', adminOutletsRouter(db, realtime));
  api.use('/admin/users', adminUsersRouter(db, config, realtime));
  api.use('/admin/audit-logs', adminAuditRouter(db));
  api.use('/admin/no-shows', adminNoShowRouter(db, realtime));
  api.use('/cart', cartRouter(db));
  api.use('/reorder', reorderRouter(db));
  api.use('/saved-combos', savedCombosRouter(db));
  api.use('/surprise-meal', surpriseMealRouter(db, comboAdvisor));
  api.use('/wallet', walletRouter(db, config, realtime));
  api.use('/orders/:orderId/pickup', studentPickupRouter(db));
  api.use('/orders/:orderId/tracking', trackingRouter(db));
  api.use('/orders', ordersRouter(db, realtime, config));
  api.use('/groups', groupsRouter(db, realtime, config));
  api.use('/splits', splitsRouter(db, realtime, config));
  api.use('/banquets', banquetsRouter(db, realtime));
  api.use('/staff/outlets/:outletId/banquets', staffBanquetsRouter(db, realtime));
  api.use('/staff/outlets/:outletId/tables', staffTablesRouter(db));
  api.use('/staff/outlets/:outletId/reservations', staffReservationsRouter(db));
  api.use('/reservations', reservationsRouter(db));
  api.use('/chat/bitebot', bitebotRouter(db, config, resolvedChatProvider));
  api.use('/rewards', rewardsRouter(db));
  api.use('/rewards', redeemRewardRouter(db));
  api.use('/me/rewards', myRewardsRouter(db));
  api.use('/admin/rewards', adminRewardsRouter(db));
  api.use('/me/budget', myBudgetRouter(db));
  api.use('/admin/users/:userId/budget', adminUserBudgetRouter(db));
  api.use('/orders/:orderId/invoice', studentInvoiceRouter(db));
  api.use('/admin/orders/:orderId/invoice', adminInvoiceRouter(db));
  api.use('/orders/:orderId/refund-request', orderRefundRouter(db));
  api.use('/admin/refund-requests', adminRefundRouter(db));
  api.use('/staff/outlets/:outletId/refund-requests', staffRefundRouter(db));
  api.use('/uploads', uploadsRouter(config));
  // The payment simulator exists only when mock mode is on — never in production.
  if (rechargeProviderFor(config)?.name === 'MOCK') {
    api.use('/payments/mock', mockPaymentsRouter(db, config, realtime));
  }
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
