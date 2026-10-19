import { Router } from 'express';
import { z } from 'zod';
import type { Database } from '../../lib/prisma.js';
import { notFound } from '../../lib/errors.js';
import { requireRole } from '../../middleware/auth.js';
import { generateInvoice } from './invoice.service.js';

function parseOrderId(value: unknown): string {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) throw notFound('Order not found');
  return parsed.data;
}

/**
 * GET /orders/:orderId/invoice
 * Downloads a PDF invoice for the signed-in user's own order.
 * Only available for orders with paymentStatus PAID or PARTIALLY_REFUNDED.
 */
export function studentInvoiceRouter(db: Database): Router {
  const router = Router({ mergeParams: true });
  router.use(requireRole('STUDENT', 'FACULTY', 'STAFF', 'EXECUTIVE'));

  router.get('/', async (req, res) => {
    const orderId = parseOrderId((req.params as Record<string, string>).orderId);
    const pdf = await generateInvoice(db, {
      orderId,
      requestingUserId: req.auth!.user.id,
      isAdmin: false,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="invoice-${orderId.slice(0, 8)}.pdf"`);
    res.setHeader('Content-Length', String(pdf.length));
    res.end(pdf);
  });

  return router;
}

/**
 * GET /admin/orders/:orderId/invoice
 * Admin can download an invoice for any order.
 */
export function adminInvoiceRouter(db: Database): Router {
  const router = Router({ mergeParams: true });
  router.use(requireRole('ADMIN'));

  router.get('/', async (req, res) => {
    const orderId = parseOrderId((req.params as Record<string, string>).orderId);
    const pdf = await generateInvoice(db, {
      orderId,
      requestingUserId: req.auth!.user.id,
      isAdmin: true,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="invoice-${orderId.slice(0, 8)}.pdf"`);
    res.setHeader('Content-Length', String(pdf.length));
    res.end(pdf);
  });

  return router;
}
