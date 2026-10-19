import PDFDocument from 'pdfkit';
import type { Database } from '../../lib/prisma.js';
import { AppError, forbidden, notFound } from '../../lib/errors.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface InvoiceParams {
  orderId: string;
  requestingUserId: string;
  isAdmin: boolean;
}

/** paymentStatus values that represent a completed, paid transaction. */
const PAID_STATUSES = new Set(['PAID', 'PARTIALLY_REFUNDED']);

const GST_RATE = 0.05; // 5 % inclusive GST

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatPaise(paise: number): string {
  return `\u20B9${(paise / 100).toFixed(2)}`;
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  });
}

function invoiceNumber(orderId: string, placedAt: Date): string {
  const y = placedAt.getUTCFullYear();
  const m = String(placedAt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(placedAt.getUTCDate()).padStart(2, '0');
  const short = orderId.replace(/-/g, '').slice(0, 8).toUpperCase();
  return `INV-${y}${m}${d}-${short}`;
}

// ─── PDF renderer ─────────────────────────────────────────────────────────────

function buildPdf(
  doc: InstanceType<typeof PDFDocument>,
  params: {
    invNo: string;
    order: {
      id: string;
      pickupCode: string;
      placedAt: Date;
      paymentMethod: string;
      paymentStatus: string;
      subtotalPaise: number;
      pointsDiscountPaise: number;
      scheduledFeePaise: number;
      totalPaise: number;
      items: Array<{ name: string; quantity: number; unitPricePaise: number; lineTotalPaise: number }>;
      outlet: { name: string; location: string };
      user: { displayName: string; email: string };
    };
    taxPaise: number;
  },
): void {
  const { invNo, order, taxPaise } = params;
  const LEFT = 50;
  const RIGHT = 545;
  const WIDTH = RIGHT - LEFT;

  // ── Header ─────────────────────────────────────────────────────────────
  doc.fontSize(26).font('Helvetica-Bold').fillColor('#1a1a2e').text('ORBIZ', LEFT, 48);
  doc
    .fontSize(10)
    .font('Helvetica')
    .fillColor('#555')
    .text('Campus Food & Beverages Platform', LEFT, 78);

  doc.fontSize(20).font('Helvetica-Bold').fillColor('#1a1a2e').text('TAX INVOICE', LEFT, 48, {
    align: 'right',
    width: WIDTH,
  });

  // ── Meta block ─────────────────────────────────────────────────────────
  const META_Y = 110;
  doc
    .moveTo(LEFT, META_Y)
    .lineTo(RIGHT, META_Y)
    .strokeColor('#ccc')
    .lineWidth(0.5)
    .stroke();

  const metaLabel = (label: string, value: string, x: number, y: number) => {
    doc.fontSize(8).font('Helvetica').fillColor('#777').text(label, x, y);
    doc
      .fontSize(9)
      .font('Helvetica-Bold')
      .fillColor('#111')
      .text(value, x, y + 11);
  };
  metaLabel('Invoice No', invNo, LEFT, META_Y + 8);
  metaLabel('Invoice Date', formatDate(order.placedAt), LEFT + 200, META_Y + 8);
  metaLabel('Pickup Code', order.pickupCode, LEFT + 360, META_Y + 8);

  const META_BOTTOM = META_Y + 42;
  doc
    .moveTo(LEFT, META_BOTTOM)
    .lineTo(RIGHT, META_BOTTOM)
    .strokeColor('#ccc')
    .stroke();

  // ── Address block ──────────────────────────────────────────────────────
  const ADDR_Y = META_BOTTOM + 10;
  doc.fontSize(7).font('Helvetica-Bold').fillColor('#999').text('BILL TO', LEFT, ADDR_Y);
  doc
    .fontSize(10)
    .font('Helvetica-Bold')
    .fillColor('#111')
    .text(order.user.displayName, LEFT, ADDR_Y + 10);
  doc
    .fontSize(9)
    .font('Helvetica')
    .fillColor('#444')
    .text(order.user.email, LEFT, ADDR_Y + 23);

  doc.fontSize(7).font('Helvetica-Bold').fillColor('#999').text('SOLD BY', LEFT + 300, ADDR_Y);
  doc
    .fontSize(10)
    .font('Helvetica-Bold')
    .fillColor('#111')
    .text(order.outlet.name, LEFT + 300, ADDR_Y + 10);
  if (order.outlet.location) {
    doc
      .fontSize(9)
      .font('Helvetica')
      .fillColor('#444')
      .text(order.outlet.location, LEFT + 300, ADDR_Y + 23);
  }

  // ── Items table ────────────────────────────────────────────────────────
  const TBL_Y = ADDR_Y + 52;

  // Table header background
  doc.rect(LEFT, TBL_Y, WIDTH, 20).fill('#f0f0f5');
  doc.fontSize(8).font('Helvetica-Bold').fillColor('#333');
  doc.text('Item', LEFT + 6, TBL_Y + 6);
  doc.text('Qty', LEFT + 310, TBL_Y + 6, { width: 40, align: 'right' });
  doc.text('Unit Price', LEFT + 355, TBL_Y + 6, { width: 80, align: 'right' });
  doc.text('Total', LEFT + 440, TBL_Y + 6, { width: 95, align: 'right' });

  let rowY = TBL_Y + 24;
  doc.font('Helvetica').fontSize(9).fillColor('#111');
  for (const item of order.items) {
    doc.text(item.name, LEFT + 6, rowY, { width: 300 });
    doc.text(String(item.quantity), LEFT + 310, rowY, { width: 40, align: 'right' });
    doc.text(formatPaise(item.unitPricePaise), LEFT + 355, rowY, { width: 80, align: 'right' });
    doc.text(formatPaise(item.lineTotalPaise), LEFT + 440, rowY, { width: 95, align: 'right' });
    rowY += 18;
    doc
      .moveTo(LEFT, rowY - 2)
      .lineTo(RIGHT, rowY - 2)
      .strokeColor('#eee')
      .lineWidth(0.4)
      .stroke();
  }

  // ── Summary block ──────────────────────────────────────────────────────
  rowY += 6;
  const SUM_X_LABEL = LEFT + 270;
  const SUM_X_VALUE = LEFT + 380;
  const SUM_VALUE_WIDTH = 115;

  const summaryRow = (label: string, value: string, bold = false) => {
    const font = bold ? 'Helvetica-Bold' : 'Helvetica';
    doc.font(font).fontSize(9).fillColor('#444').text(label, SUM_X_LABEL, rowY, { width: 105 });
    doc
      .font(font)
      .fontSize(9)
      .fillColor('#111')
      .text(value, SUM_X_VALUE, rowY, { width: SUM_VALUE_WIDTH, align: 'right' });
    rowY += 16;
  };

  summaryRow('Subtotal', formatPaise(order.subtotalPaise));
  if (order.pointsDiscountPaise > 0) {
    summaryRow('Points Discount', `-${formatPaise(order.pointsDiscountPaise)}`);
  }
  if (order.scheduledFeePaise > 0) {
    summaryRow('Scheduled Fee', formatPaise(order.scheduledFeePaise));
  }
  summaryRow('GST 5% (inclusive)', formatPaise(taxPaise));

  rowY += 2;
  doc
    .moveTo(SUM_X_LABEL, rowY)
    .lineTo(RIGHT, rowY)
    .strokeColor('#333')
    .lineWidth(0.8)
    .stroke();
  rowY += 5;
  summaryRow('Total', formatPaise(order.totalPaise), true);

  // ── Payment details ────────────────────────────────────────────────────
  rowY += 14;
  doc
    .moveTo(LEFT, rowY)
    .lineTo(RIGHT, rowY)
    .strokeColor('#ccc')
    .lineWidth(0.5)
    .stroke();
  rowY += 10;

  doc.fontSize(8).font('Helvetica').fillColor('#666');
  doc.text(`Payment Method: ${order.paymentMethod}`, LEFT + 6, rowY);
  doc.text(`Payment Status: ${order.paymentStatus}`, LEFT + 6, rowY + 13);

  // ── Footer ─────────────────────────────────────────────────────────────
  doc
    .fontSize(7)
    .font('Helvetica')
    .fillColor('#bbb')
    .text(
      'This is a computer-generated invoice. No signature is required. All amounts are in INR.',
      LEFT,
      760,
      { align: 'center', width: WIDTH },
    );
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generates a PDF invoice for an order.
 *
 * Access rules:
 *  - A student may only request their own order's invoice.
 *  - An admin may request any order's invoice.
 *  - An invoice is only available when the order has been paid
 *    (paymentStatus PAID or PARTIALLY_REFUNDED).
 */
export async function generateInvoice(db: Database, params: InvoiceParams): Promise<Buffer> {
  const order = await db.order.findFirst({
    where: {
      id: params.orderId,
      // Non-admins may only see their own orders; a missing order is indistinguishable
      // from someone else's (404 in both cases).
      ...(!params.isAdmin && { userId: params.requestingUserId }),
    },
    include: {
      outlet: { select: { name: true, location: true } },
      items: { orderBy: { name: 'asc' } },
      user: { select: { displayName: true, email: true } },
    },
  });

  if (!order) throw notFound('Order not found');

  if (!PAID_STATUSES.has(order.paymentStatus)) {
    throw new AppError(
      409,
      'INVOICE_NOT_AVAILABLE',
      'An invoice is only available for orders that have been paid.',
      { paymentStatus: order.paymentStatus },
    );
  }

  // Only the owner (or an admin) should get the invoice. The DB query already
  // enforces ownership for non-admins, but we add an explicit guard here to
  // make the intent clear and future-proof against query changes.
  if (!params.isAdmin && order.userId !== params.requestingUserId) {
    throw forbidden();
  }

  const invNo = invoiceNumber(order.id, order.placedAt);
  const taxPaise = Math.round((order.totalPaise * GST_RATE) / (1 + GST_RATE));

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4', autoFirstPage: true });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', (err: unknown) => reject(err instanceof Error ? err : new Error(String(err))));

    buildPdf(doc, { invNo, order, taxPaise });
    doc.end();
  });
}
