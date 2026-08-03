import { getCurrency } from '#shared/currencies';

export type AmazonItem = Readonly<{
  id: string;
  shipmentId: string | null;
  title: string;
  quantity: number;
  unitAmount: number;
  taxAmount: number;
  shippingAmount: number;
  discountAmount: number;
  refundAmount: number;
}>;

export type AmazonShipment = Readonly<{
  id: string;
  date: string | null;
  total: number | null;
}>;

export type AmazonRefund = Readonly<{
  id: string;
  itemId: string | null;
  date: string;
  amount: number;
  reason: string | null;
}>;

export type AmazonOrder = Readonly<{
  orderId: string;
  marketplace: string;
  date: string;
  currency: string;
  itemSubtotal: number;
  taxTotal: number;
  shippingTotal: number;
  discountTotal: number;
  giftCardTotal: number;
  refundTotal: number;
  orderTotal: number;
  items: readonly AmazonItem[];
  shipments: readonly AmazonShipment[];
  refunds: readonly AmazonRefund[];
}>;

export type AmazonAllocationKind =
  | 'merchandise'
  | 'tax'
  | 'shipping'
  | 'discount'
  | 'gift-card'
  | 'refund'
  | 'rounding';

export type AmazonAllocation = Readonly<{
  id: string;
  kind: AmazonAllocationKind;
  label: string;
  amount: number;
}>;

export type AmazonPaymentSource = Readonly<{
  id: string;
  orderId: string;
  kind: 'charge' | 'refund';
  date: string;
  currency: string;
  amount: number;
  description: string;
  allocations: readonly AmazonAllocation[];
}>;

export type AmazonTransaction = Readonly<{
  id: string;
  account?: string;
  amount: number;
  category?: string | null;
  cleared?: boolean;
  date: string;
  notes?: string | null;
  payee?: string | null;
  payee_name?: string | null;
  imported_payee?: string | null;
  is_parent?: boolean;
  is_child?: boolean;
  starting_balance_flag?: boolean;
  reconciled?: boolean;
  tombstone?: boolean;
  _deleted?: boolean;
  transfer_id?: string | null;
}>;

export type AmazonMatchReason =
  | 'exact-amount'
  | 'nearby-date'
  | 'amazon-merchant'
  | 'merchant-not-confirmed'
  | 'multiple-targets'
  | 'target-reused'
  | 'unsupported-currency'
  | 'no-target';

export type AmazonMatch = Readonly<{
  candidateKey: string;
  evidenceFingerprint: string;
  source: AmazonPaymentSource;
  transaction: AmazonTransaction | null;
  status: 'ready' | 'review' | 'ambiguous' | 'unmatched' | 'unsupported';
  score: number;
  reasons: readonly AmazonMatchReason[];
}>;

type JsonRecord = Record<string, unknown>;

const maximumRecords = 5_000;
const maximumIdentifierLength = 120;
const canonicalCurrencyPattern = /^[A-Z]{3}$/;
const canonicalDatePattern = /^\d{4}-\d{2}-\d{2}$/;
export const maximumAmazonImportFileSize = 10 * 1024 * 1024;

/**
 * Validates the compact normalized representation kept in budget metadata.
 * It deliberately reconstructs the same canonical input used for uploads so
 * persisted values get exactly the same bounds and canonicalization checks.
 */
export function normalizeAmazonReviewOrders(
  value: unknown,
): readonly AmazonOrder[] {
  if (!Array.isArray(value)) {
    throw new Error('Amazon review orders are invalid.');
  }
  const sections: Record<string, unknown[]> = {
    items: [],
    orders: [],
    refunds: [],
    shipments: [],
  };
  for (const rawOrder of value) {
    const order = requireRecord(rawOrder);
    const items = order.items;
    const shipments = order.shipments;
    const refunds = order.refunds;
    if (
      !Array.isArray(items) ||
      !Array.isArray(shipments) ||
      !Array.isArray(refunds)
    ) {
      throw new Error('Amazon review order children are invalid.');
    }
    sections.orders.push({
      currencyCode: order.currency,
      discountTotal: order.discountTotal,
      externalOrderId: order.orderId,
      giftCardTotal: order.giftCardTotal,
      itemSubtotal: order.itemSubtotal,
      marketplace: order.marketplace,
      orderDate: order.date,
      orderTotal: order.orderTotal,
      refundTotal: order.refundTotal,
      shippingTotal: order.shippingTotal,
      taxTotal: order.taxTotal,
    });
    for (const rawShipment of shipments) {
      const shipment = requireRecord(rawShipment);
      sections.shipments.push({
        externalOrderId: order.orderId,
        externalShipmentId: shipment.id,
        shipmentDate: shipment.date,
        shipmentTotal: shipment.total,
      });
    }
    for (const rawItem of items) {
      const item = requireRecord(rawItem);
      sections.items.push({
        discountAmount: item.discountAmount,
        externalItemId: item.id,
        externalOrderId: order.orderId,
        quantity: item.quantity,
        refundAmount: item.refundAmount,
        shipmentKey: item.shipmentId,
        shippingAmount: item.shippingAmount,
        taxAmount: item.taxAmount,
        title: item.title,
        unitAmount: item.unitAmount,
      });
    }
    for (const rawRefund of refunds) {
      const refund = requireRecord(rawRefund);
      sections.refunds.push({
        amount: refund.amount,
        externalOrderId: order.orderId,
        externalRefundId: refund.id,
        itemKey: refund.itemId,
        reason: refund.reason,
        refundDate: refund.date,
      });
    }
  }
  return parseCanonicalSections(sections);
}

export function parseAmazonJson(contents: string): readonly AmazonOrder[] {
  if (contents.length > maximumAmazonImportFileSize) {
    throw new Error('Amazon JSON file is too large.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error('Invalid Amazon JSON file.');
  }

  if (isRecord(parsed) && hasCanonicalSections(parsed)) {
    return parseCanonicalSections(parsed);
  }

  const root = isRecord(parsed) ? parsed : null;
  const records = Array.isArray(parsed)
    ? parsed
    : [root?.orders, root?.Orders, root?.data, root?.items].find(Array.isArray);
  if (!Array.isArray(records) || records.length > maximumRecords) {
    throw new Error('Unsupported Amazon JSON file.');
  }
  return parseFlatRecords(records);
}

export function parseAmazonEmail(contents: string): readonly AmazonOrder[] {
  if (contents.length > maximumAmazonImportFileSize) {
    throw new Error('Amazon email is too large.');
  }
  const visibleText = extractVisibleEmailText(contents);
  const adapterRecords = [
    ...visibleText.matchAll(/^Actual-Amazon-Record-V1:\s*(\{.*\})$/gim),
  ].map(match => JSON.parse(match[1]) as unknown);
  if (adapterRecords.length > 0) {
    const sections: Record<string, unknown[]> = {
      orders: [],
      shipments: [],
      items: [],
      refunds: [],
    };
    for (const record of adapterRecords) {
      if (!isRecord(record) || typeof record.kind !== 'string') {
        throw new Error('Invalid Amazon email record.');
      }
      const section = `${record.kind}s`;
      if (!Object.hasOwn(sections, section)) {
        throw new Error('Invalid Amazon email record kind.');
      }
      sections[section].push(record);
    }
    return parseCanonicalSections(sections);
  }

  const orderIds = unique(
    [...visibleText.matchAll(/\b\d{3}-\d{7}-\d{7}\b/g)].map(match => match[0]),
  );
  if (orderIds.length !== 1) {
    throw new Error('Amazon email must identify exactly one order.');
  }
  const subject = headerValue(contents, 'subject') ?? 'Amazon purchase';
  const refundTotalValue = firstLabelledValue(visibleText, [
    'Refund Total',
    'Refund Amount',
    'Amount Refunded',
  ]);
  const shipmentTotalValue = firstLabelledValue(visibleText, [
    'Shipment Total',
  ]);
  const orderTotalValue = firstLabelledValue(visibleText, ['Order Total']);
  const kind =
    /refund|returned|return received/i.test(subject) ||
    refundTotalValue !== null
      ? 'refund'
      : /shipped|shipment|on the way|delivered/i.test(subject) ||
          shipmentTotalValue !== null
        ? 'shipment'
        : 'order';
  const date = parseDisplayDate(
    firstLabelledValue(
      visibleText,
      kind === 'refund'
        ? ['Refund issued', 'Refund date']
        : ['Order placed', 'Ordered on', 'Order date'],
    ) ?? headerValue(contents, 'date'),
  );
  const totalValue =
    kind === 'refund'
      ? refundTotalValue
      : kind === 'shipment'
        ? shipmentTotalValue
        : orderTotalValue;
  const currency = detectDisplayCurrency(totalValue ?? '');
  const total = parseDisplayMoney(totalValue, currency);
  if (date === null || total === null || total === 0) {
    throw new Error('Amazon email is missing its date or total.');
  }
  const titles = unique(
    labelledValues(visibleText, ['Product Name', 'Item', 'Item name']),
  );
  const orderId = orderIds[0];
  const itemTitle = canonicalDisplayText(
    titles[0] ?? (subject.replace(/^.*?:\s*/, '').trim() || 'Amazon item'),
    160,
  );
  return [
    {
      orderId,
      marketplace: 'amazon.com',
      date,
      currency,
      itemSubtotal: kind === 'refund' ? 0 : total,
      taxTotal: 0,
      shippingTotal: 0,
      discountTotal: 0,
      giftCardTotal: 0,
      refundTotal: kind === 'refund' ? total : 0,
      orderTotal: kind === 'refund' ? 0 : total,
      items:
        kind === 'refund'
          ? []
          : [
              {
                id: `${orderId}:email-item`,
                shipmentId: kind === 'shipment' ? `${orderId}:shipment` : null,
                title: itemTitle,
                quantity: 1,
                unitAmount: total,
                taxAmount: 0,
                shippingAmount: 0,
                discountAmount: 0,
                refundAmount: 0,
              },
            ],
      shipments:
        kind === 'shipment' ? [{ id: `${orderId}:shipment`, date, total }] : [],
      refunds:
        kind === 'refund'
          ? [
              {
                id: `${orderId}:email-refund`,
                itemId: null,
                date,
                amount: total,
                reason: null,
              },
            ]
          : [],
    },
  ];
}

export function buildAmazonPaymentSources(
  orders: readonly AmazonOrder[],
): readonly AmazonPaymentSource[] {
  const sources: AmazonPaymentSource[] = [];
  for (const order of deduplicateOrders(orders)) {
    if (order.giftCardTotal > order.orderTotal) {
      throw new Error('Amazon gift card total exceeds the order total.');
    }
    const shipmentTotal = safeSum(
      order.shipments.map(shipment => shipment.total ?? 0),
      'Amazon shipment totals exceed the safe integer range.',
    );
    const canUseShipmentCharges =
      order.shipments.length > 0 &&
      order.shipments.every(
        shipment => shipment.total !== null && shipment.total > 0,
      ) &&
      order.giftCardTotal === 0 &&
      shipmentTotal === order.orderTotal;
    if (canUseShipmentCharges) {
      for (const shipment of order.shipments) {
        const amount = -(shipment.total ?? 0);
        const shipmentItems = order.items.filter(
          item => item.shipmentId === shipment.id,
        );
        sources.push({
          id: `charge:${order.orderId}:${shipment.id}`,
          orderId: order.orderId,
          kind: 'charge',
          date: shipment.date ?? order.date,
          currency: order.currency,
          amount,
          description: `Amazon shipment ${order.orderId}`,
          allocations: balanceAllocations(
            itemAllocations(shipmentItems),
            amount,
            `shipment-rounding:${shipment.id}`,
          ),
        });
      }
    } else {
      const amount = -safeSubtract(
        order.orderTotal,
        order.giftCardTotal,
        'Invalid Amazon card charge total.',
      );
      if (amount !== 0) {
        const allocations = itemAllocations(order.items);
        const itemMerchandise = safeSum(
          order.items.map(item =>
            safeMultiply(
              item.quantity,
              item.unitAmount,
              'Amazon item total exceeds the safe integer range.',
            ),
          ),
          'Amazon item subtotal exceeds the safe integer range.',
        );
        const itemTax = safeSum(
          order.items.map(item => item.taxAmount),
          'Amazon item tax exceeds the safe integer range.',
        );
        const itemShipping = safeSum(
          order.items.map(item => item.shippingAmount),
          'Amazon item shipping exceeds the safe integer range.',
        );
        const itemDiscount = safeSum(
          order.items.map(item => item.discountAmount),
          'Amazon item discounts exceed the safe integer range.',
        );
        if (
          itemMerchandise > order.itemSubtotal ||
          itemTax > order.taxTotal ||
          itemShipping > order.shippingTotal ||
          itemDiscount > order.discountTotal
        ) {
          throw new Error('Amazon item totals exceed their order totals.');
        }
        if (order.itemSubtotal > itemMerchandise) {
          allocations.push(
            allocation(
              `${order.orderId}:merchandise`,
              'merchandise',
              'Unassigned merchandise',
              -(order.itemSubtotal - itemMerchandise),
            ),
          );
        }
        if (order.taxTotal > itemTax) {
          allocations.push(
            allocation(
              `${order.orderId}:tax`,
              'tax',
              'Unassigned tax',
              -(order.taxTotal - itemTax),
            ),
          );
        }
        if (order.shippingTotal > itemShipping) {
          allocations.push(
            allocation(
              `${order.orderId}:shipping`,
              'shipping',
              'Unassigned shipping',
              -(order.shippingTotal - itemShipping),
            ),
          );
        }
        if (order.discountTotal > itemDiscount) {
          allocations.push(
            allocation(
              `${order.orderId}:discount`,
              'discount',
              'Unassigned discount',
              order.discountTotal - itemDiscount,
            ),
          );
        }
        if (order.giftCardTotal > 0) {
          allocations.push(
            allocation(
              `${order.orderId}:gift-card`,
              'gift-card',
              'Gift card payment',
              order.giftCardTotal,
            ),
          );
        }
        sources.push({
          id: `charge:${order.orderId}`,
          orderId: order.orderId,
          kind: 'charge',
          date: order.date,
          currency: order.currency,
          amount,
          description: `Amazon order ${order.orderId}`,
          allocations: balanceAllocations(
            allocations,
            amount,
            `${order.orderId}:rounding`,
          ),
        });
      }
    }

    for (const refund of order.refunds) {
      if (refund.amount === 0) continue;
      sources.push({
        id: `refund:${order.orderId}:${refund.id}`,
        orderId: order.orderId,
        kind: 'refund',
        date: refund.date,
        currency: order.currency,
        amount: refund.amount,
        description: `Amazon refund ${order.orderId}`,
        allocations: [
          allocation(
            `${order.orderId}:${refund.id}`,
            'refund',
            refund.reason ?? 'Amazon refund',
            refund.amount,
          ),
        ],
      });
    }
  }
  return sources.sort(
    (left, right) =>
      left.date.localeCompare(right.date) || left.id.localeCompare(right.id),
  );
}

export function matchAmazonPayments(
  sources: readonly AmazonPaymentSource[],
  transactions: readonly AmazonTransaction[],
  budgetCurrency: string,
): readonly AmazonMatch[] {
  const eligibleTransactions = transactions.filter(isEligibleTransaction);
  const initialMatches = sources.map(source => {
    if (source.currency !== budgetCurrency) {
      return createMatch(source, null, 'unsupported', 0, [
        'unsupported-currency',
      ]);
    }
    const candidates = eligibleTransactions
      .filter(transaction => transaction.amount === source.amount)
      .map(transaction => {
        const dayDistance = dateDistance(source.date, transaction.date);
        const merchantEvidence = /amazon|amzn|audible|whole foods/i.test(
          `${transaction.payee_name ?? ''} ${transaction.imported_payee ?? ''}`,
        );
        return {
          transaction,
          dayDistance,
          merchantEvidence,
          score:
            60 +
            (merchantEvidence ? 25 : 0) +
            (dayDistance === 0 ? 15 : dayDistance <= 3 ? 10 : 5),
        };
      })
      .filter(candidate => candidate.dayDistance <= 14)
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.dayDistance - right.dayDistance ||
          left.transaction.id.localeCompare(right.transaction.id),
      );
    const best = candidates[0];
    if (best === undefined) {
      return createMatch(source, null, 'unmatched', 0, ['no-target']);
    }
    const reasons: AmazonMatchReason[] = [
      'exact-amount',
      'nearby-date',
      best.merchantEvidence ? 'amazon-merchant' : 'merchant-not-confirmed',
    ];
    if (candidates.length > 1) {
      return createMatch(source, null, 'ambiguous', best.score, [
        ...reasons,
        'multiple-targets',
      ]);
    }
    return createMatch(
      source,
      best.transaction,
      best.merchantEvidence && best.dayDistance <= 7 ? 'ready' : 'review',
      best.score,
      reasons,
    );
  });

  const targetUseCount = new Map<string, number>();
  for (const match of initialMatches) {
    if (match.transaction !== null) {
      targetUseCount.set(
        match.transaction.id,
        (targetUseCount.get(match.transaction.id) ?? 0) + 1,
      );
    }
  }
  return initialMatches.map(match =>
    match.transaction !== null &&
    (targetUseCount.get(match.transaction.id) ?? 0) > 1
      ? createMatch(match.source, null, 'ambiguous', match.score, [
          ...match.reasons,
          'target-reused',
        ])
      : match,
  );
}

function parseCanonicalSections(value: JsonRecord): readonly AmazonOrder[] {
  const orderRows = requiredSection(value, 'orders');
  const shipmentRows = optionalSection(value, 'shipments');
  const itemRows = optionalSection(value, 'items');
  const refundRows = optionalSection(value, 'refunds');
  if (
    orderRows.length +
      shipmentRows.length +
      itemRows.length +
      refundRows.length >
    maximumRecords
  ) {
    throw new Error('Amazon JSON file has too many records.');
  }

  const orders = new Map<string, AmazonOrder>();
  for (const rawOrder of orderRows) {
    const row = requireRecord(rawOrder);
    const orderId = canonicalIdentifier(row.externalOrderId);
    const order: AmazonOrder = {
      orderId,
      marketplace: canonicalMarketplace(row.marketplace),
      date: canonicalDate(row.orderDate),
      currency: canonicalCurrency(row.currencyCode),
      itemSubtotal: canonicalMoney(row.itemSubtotal),
      taxTotal: canonicalMoney(row.taxTotal),
      shippingTotal: canonicalMoney(row.shippingTotal),
      discountTotal: canonicalMoney(row.discountTotal),
      giftCardTotal: canonicalMoney(row.giftCardTotal),
      refundTotal: canonicalMoney(row.refundTotal),
      orderTotal: canonicalMoney(row.orderTotal),
      items: [],
      shipments: [],
      refunds: [],
    };
    if (orders.has(orderId)) throw new Error('Duplicate Amazon order.');
    orders.set(orderId, order);
  }

  for (const rawShipment of shipmentRows) {
    const row = requireRecord(rawShipment);
    const order = requiredOrder(orders, row.externalOrderId);
    assertChildCompatibility(order, row);
    const shipment = {
      id:
        optionalCanonicalIdentifier(row.externalShipmentId) ??
        `${order.orderId}:shipment:${order.shipments.length + 1}`,
      date: row.shipmentDate == null ? null : canonicalDate(row.shipmentDate),
      total:
        row.shipmentTotal == null ? null : canonicalMoney(row.shipmentTotal),
    } satisfies AmazonShipment;
    if (order.shipments.some(existing => existing.id === shipment.id)) {
      throw new Error('Duplicate Amazon shipment.');
    }
    replaceOrder(orders, order, {
      shipments: [...order.shipments, shipment],
    });
  }

  for (const rawItem of itemRows) {
    const row = requireRecord(rawItem);
    const order = requiredOrder(orders, row.externalOrderId);
    assertChildCompatibility(order, row);
    const shipmentKey = optionalCanonicalIdentifier(row.shipmentKey);
    const item = {
      id:
        optionalCanonicalIdentifier(row.externalItemId) ??
        optionalCanonicalIdentifier(row.asin) ??
        `${order.orderId}:item:${order.items.length + 1}`,
      shipmentId: shipmentKey?.replace(/^shipment\//, '') ?? null,
      title: canonicalDisplayText(row.title, 160),
      quantity: canonicalPositiveInteger(row.quantity),
      unitAmount: canonicalMoney(row.unitAmount),
      taxAmount: canonicalMoney(row.taxAmount),
      shippingAmount: canonicalMoney(row.shippingAmount),
      discountAmount: canonicalMoney(row.discountAmount),
      refundAmount: canonicalMoney(row.refundAmount),
    } satisfies AmazonItem;
    safeMultiply(
      item.quantity,
      item.unitAmount,
      'Amazon item total exceeds the safe integer range.',
    );
    if (order.items.some(existing => existing.id === item.id)) {
      throw new Error('Duplicate Amazon item.');
    }
    replaceOrder(orders, order, { items: [...order.items, item] });
  }

  for (const rawRefund of refundRows) {
    const row = requireRecord(rawRefund);
    const order = requiredOrder(orders, row.externalOrderId);
    assertChildCompatibility(order, row);
    const refund = {
      id:
        optionalCanonicalIdentifier(row.externalRefundId) ??
        `${order.orderId}:refund:${order.refunds.length + 1}`,
      itemId: optionalCanonicalIdentifier(row.itemKey),
      date: canonicalDate(row.refundDate),
      amount: canonicalMoney(row.amount),
      reason: optionalDisplayText(row.reason, 160),
    } satisfies AmazonRefund;
    if (order.refunds.some(existing => existing.id === refund.id)) {
      throw new Error('Duplicate Amazon refund.');
    }
    replaceOrder(orders, order, { refunds: [...order.refunds, refund] });
  }
  return [...orders.values()].sort((left, right) =>
    left.orderId.localeCompare(right.orderId),
  );
}

function parseFlatRecords(records: readonly unknown[]): readonly AmazonOrder[] {
  const orders = new Map<string, AmazonOrder>();
  for (const rawRecord of records) {
    const record = requireRecord(rawRecord);
    const rawOrderId = textValue(
      valueFor(record, ['orderid', 'amazonorderid', 'id']),
    );
    if (rawOrderId === null) {
      throw new Error('Amazon record is missing its order identifier.');
    }
    const orderId = canonicalIdentifier(rawOrderId);
    const refundValue = valueFor(record, ['refundamount', 'amountrefunded']);
    const status = textValue(valueFor(record, ['status', 'orderstatus'])) ?? '';
    const isRefund = refundValue !== undefined || /refund|return/i.test(status);
    const rawTotal = isRefund
      ? refundValue
      : valueFor(record, ['ordertotal', 'total', 'amount']);
    const date = parseDisplayDate(
      valueFor(
        record,
        isRefund
          ? ['refunddate', 'date', 'orderdate']
          : ['orderdate', 'date', 'purchasedate'],
      ),
    );
    const currency = displayCurrency(record, rawTotal);
    const total = parseDisplayMoney(rawTotal, currency);
    if (date === null || total === null) {
      throw new Error('Amazon record is missing its date or total.');
    }
    const existing = orders.get(orderId);
    if (existing !== undefined && existing.currency !== currency) {
      throw new Error('Conflicting Amazon order currency.');
    }
    const baseOrder: AmazonOrder = existing ?? {
      orderId,
      marketplace: 'amazon.com',
      date,
      currency,
      itemSubtotal: 0,
      taxTotal: 0,
      shippingTotal: 0,
      discountTotal: 0,
      giftCardTotal: 0,
      refundTotal: 0,
      orderTotal: 0,
      items: [],
      shipments: [],
      refunds: [],
    };
    if (isRefund) {
      const suppliedRefundId = textValue(
        valueFor(record, ['refundid', 'returnid']),
      );
      const refund = {
        id:
          suppliedRefundId === null
            ? `${orderId}:flat-refund:${baseOrder.refunds.length + 1}`
            : canonicalIdentifier(suppliedRefundId),
        itemId: null,
        date,
        amount: total,
        reason: optionalDisplayText(
          valueFor(record, ['reason', 'refundreason']),
          160,
        ),
      } satisfies AmazonRefund;
      if (baseOrder.refunds.some(value => value.id === refund.id)) {
        throw new Error('Duplicate Amazon refund.');
      }
      orders.set(orderId, {
        ...baseOrder,
        refundTotal: safeAdd(
          baseOrder.refundTotal,
          total,
          'Amazon refund total exceeds the safe integer range.',
        ),
        refunds: [...baseOrder.refunds, refund],
      });
      continue;
    }
    if (
      existing !== undefined &&
      existing.items.length > 0 &&
      existing.date !== date
    ) {
      throw new Error('Conflicting Amazon order date.');
    }
    const title = canonicalDisplayText(
      textValue(
        valueFor(record, ['productname', 'title', 'description', 'item']),
      ) ?? `Amazon order ${orderId}`,
      160,
    );
    const item: AmazonItem = {
      id: `${orderId}:item:${baseOrder.items.length + 1}`,
      shipmentId: null,
      title,
      quantity: 1,
      unitAmount: total,
      taxAmount: 0,
      shippingAmount: 0,
      discountAmount: 0,
      refundAmount: 0,
    };
    orders.set(orderId, {
      ...baseOrder,
      date,
      itemSubtotal: safeAdd(
        baseOrder.itemSubtotal,
        total,
        'Amazon item subtotal exceeds the safe integer range.',
      ),
      orderTotal: safeAdd(
        baseOrder.orderTotal,
        total,
        'Amazon order total exceeds the safe integer range.',
      ),
      items: [...baseOrder.items, item],
    });
  }
  return [...orders.values()];
}

function itemAllocations(items: readonly AmazonItem[]): AmazonAllocation[] {
  return items.flatMap(item => {
    const merchandiseAmount = safeMultiply(
      item.quantity,
      item.unitAmount,
      'Amazon item total exceeds the safe integer range.',
    );
    const values = [
      allocation(
        `${item.id}:merchandise`,
        'merchandise',
        `${item.title}${item.quantity > 1 ? ` x${item.quantity}` : ''}`,
        -merchandiseAmount,
      ),
      allocation(`${item.id}:tax`, 'tax', `${item.title} tax`, -item.taxAmount),
      allocation(
        `${item.id}:shipping`,
        'shipping',
        `${item.title} shipping`,
        -item.shippingAmount,
      ),
      allocation(
        `${item.id}:discount`,
        'discount',
        `${item.title} discount`,
        item.discountAmount,
      ),
    ];
    return values.filter(value => value.amount !== 0);
  });
}

function balanceAllocations(
  allocations: readonly AmazonAllocation[],
  targetAmount: number,
  roundingId: string,
): readonly AmazonAllocation[] {
  const currentAmount = allocations.reduce(
    (sum, value) =>
      safeAdd(
        sum,
        value.amount,
        'Amazon allocations exceed the safe integer range.',
      ),
    0,
  );
  const difference = safeSubtract(
    targetAmount,
    currentAmount,
    'Amazon allocation adjustment exceeds the safe integer range.',
  );
  return difference === 0
    ? allocations
    : [
        ...allocations,
        allocation(
          roundingId,
          'rounding',
          'Amazon order adjustment',
          difference,
        ),
      ];
}

function allocation(
  id: string,
  kind: AmazonAllocationKind,
  label: string,
  amount: number,
): AmazonAllocation {
  return { id, kind, label, amount };
}

function createMatch(
  source: AmazonPaymentSource,
  transaction: AmazonTransaction | null,
  status: AmazonMatch['status'],
  score: number,
  reasons: readonly AmazonMatchReason[],
): AmazonMatch {
  // Source identifiers are bounded; including a transaction identifier could
  // exceed the metadata decision-key limit without adding review value.
  const candidateKey = `amazon:${source.id}`;
  return {
    candidateKey,
    evidenceFingerprint: JSON.stringify({
      source,
      transaction:
        transaction === null
          ? null
          : {
              id: transaction.id,
              account: transaction.account ?? null,
              amount: transaction.amount,
              category: transaction.category ?? null,
              cleared: Boolean(transaction.cleared),
              date: transaction.date,
              payeeId: transaction.payee ?? null,
              payeeName: transaction.payee_name ?? null,
              importedPayee: transaction.imported_payee ?? null,
              isParent: Boolean(transaction.is_parent),
              isChild: Boolean(transaction.is_child),
              isStartingBalance: Boolean(transaction.starting_balance_flag),
              notes: transaction.notes ?? null,
              reconciled: Boolean(transaction.reconciled),
              tombstone: Boolean(transaction.tombstone || transaction._deleted),
              transferId: transaction.transfer_id ?? null,
            },
    }),
    source,
    transaction,
    status,
    score,
    reasons,
  };
}

function isEligibleTransaction(transaction: AmazonTransaction): boolean {
  return !(
    transaction.tombstone ||
    transaction._deleted ||
    transaction.is_parent ||
    transaction.is_child ||
    transaction.starting_balance_flag ||
    transaction.reconciled ||
    transaction.transfer_id != null
  );
}

function dateDistance(left: string, right: string): number {
  return (
    Math.abs(
      Date.parse(`${left}T00:00:00.000Z`) -
        Date.parse(`${right}T00:00:00.000Z`),
    ) / 86_400_000
  );
}

function hasCanonicalSections(value: JsonRecord): boolean {
  return (
    Array.isArray(value.orders) &&
    value.orders.some(order => isRecord(order) && 'externalOrderId' in order)
  );
}

function requiredSection(value: JsonRecord, name: string): readonly unknown[] {
  const section = value[name];
  if (!Array.isArray(section)) {
    throw new Error(`Missing Amazon ${name} section.`);
  }
  return section;
}

function optionalSection(value: JsonRecord, name: string): readonly unknown[] {
  const section = value[name];
  if (section === undefined) return [];
  if (!Array.isArray(section)) {
    throw new Error(`Invalid Amazon ${name} section.`);
  }
  return section;
}

function requiredOrder(
  orders: ReadonlyMap<string, AmazonOrder>,
  value: unknown,
): AmazonOrder {
  const order = orders.get(canonicalIdentifier(value));
  if (order === undefined) throw new Error('Amazon child record has no order.');
  return order;
}

function assertChildCompatibility(order: AmazonOrder, row: JsonRecord): void {
  if (
    row.marketplace != null &&
    canonicalMarketplace(row.marketplace) !== order.marketplace
  ) {
    throw new Error('Amazon child marketplace does not match its order.');
  }
  if (
    row.currencyCode != null &&
    canonicalCurrency(row.currencyCode) !== order.currency
  ) {
    throw new Error('Amazon child currency does not match its order.');
  }
}

function replaceOrder(
  orders: Map<string, AmazonOrder>,
  order: AmazonOrder,
  value: Partial<AmazonOrder>,
): void {
  orders.set(order.orderId, { ...order, ...value });
}

function canonicalIdentifier(
  value: unknown,
  maximum = maximumIdentifierLength,
): string {
  if (typeof value !== 'string') throw new Error('Invalid Amazon identifier.');
  const normalized = value.normalize('NFC').trim();
  if (
    normalized.length === 0 ||
    normalized.length > maximum ||
    containsControlCharacters(normalized)
  ) {
    throw new Error('Invalid Amazon identifier.');
  }
  return normalized;
}

function optionalCanonicalIdentifier(value: unknown): string | null {
  return value == null ? null : canonicalIdentifier(value);
}

function canonicalDate(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !canonicalDatePattern.test(value) ||
    !isExactCalendarDate(value)
  ) {
    throw new Error('Invalid Amazon date.');
  }
  return value;
}

function canonicalCurrency(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Invalid Amazon currency.');
  }
  const currency = value.trim().toUpperCase();
  if (!canonicalCurrencyPattern.test(currency)) {
    throw new Error('Invalid Amazon currency.');
  }
  return currency;
}

function canonicalMarketplace(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Invalid Amazon marketplace.');
  }
  const marketplace = value.normalize('NFC').trim().toLowerCase();
  if (
    marketplace.length === 0 ||
    marketplace.length > maximumIdentifierLength ||
    !/^[a-z0-9.-]+$/.test(marketplace)
  ) {
    throw new Error('Invalid Amazon marketplace.');
  }
  return marketplace;
}

function canonicalMoney(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error('Invalid Amazon amount.');
  }
  return Number(value);
}

function canonicalPositiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error('Invalid Amazon quantity.');
  }
  return Number(value);
}

function safeAdd(left: number, right: number, message: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new Error(message);
  return result;
}

function safeSubtract(left: number, right: number, message: string): number {
  const result = left - right;
  if (!Number.isSafeInteger(result)) throw new Error(message);
  return result;
}

function safeMultiply(left: number, right: number, message: string): number {
  const result = left * right;
  if (!Number.isSafeInteger(result)) throw new Error(message);
  return result;
}

function safeSum(values: readonly number[], message: string): number {
  return values.reduce((sum, value) => safeAdd(sum, value, message), 0);
}

function optionalDisplayText(value: unknown, maximum: number): string | null {
  if (value == null) return null;
  return canonicalDisplayText(value, maximum);
}

function canonicalDisplayText(value: unknown, maximum: number): string {
  if (typeof value !== 'string') {
    throw new Error('Invalid Amazon display text.');
  }
  const normalized = value
    .normalize('NFC')
    .split('')
    .map(character => (isControlCharacter(character) ? ' ' : character))
    .join('')
    .replace(/\s+/gu, ' ')
    .trim();
  if (normalized.length === 0) {
    throw new Error('Invalid Amazon display text.');
  }
  return [...normalized].slice(0, maximum).join('');
}

function containsControlCharacters(value: string): boolean {
  return [...value].some(isControlCharacter);
}

function isControlCharacter(value: string): boolean {
  const codePoint = value.codePointAt(0) ?? 0;
  return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
}

function requireRecord(value: unknown): JsonRecord {
  if (!isRecord(value)) throw new Error('Invalid Amazon record.');
  return value;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function valueFor(record: JsonRecord, names: readonly string[]): unknown {
  return Object.entries(record).find(([key]) =>
    names.includes(key.replace(/[ _-]/g, '').toLowerCase()),
  )?.[1];
}

function textValue(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  return text.length === 0 ? null : text;
}

function parseDisplayMoney(
  value: unknown,
  currencyCode: string,
): number | null {
  const currency = getCurrency(currencyCode);
  if (currency.code !== currencyCode) return null;
  const multiplier = 10 ** currency.decimalPlaces;
  if (typeof value === 'number') {
    const amount = Math.round(Math.abs(value) * multiplier);
    return Number.isSafeInteger(amount) ? amount : null;
  }
  const raw = textValue(value)?.replaceAll(',', '');
  const match = raw?.match(
    /-?\s*(?:(?:USD|GBP|EUR)\s*|[$£€]\s*)?(\d+(?:\.\d{1,2})?)/i,
  );
  if (!match) return null;
  const amount = Math.round(Number(match[1]) * multiplier);
  return Number.isSafeInteger(amount) ? amount : null;
}

function parseDisplayDate(value: unknown): string | null {
  const text = textValue(value);
  if (text === null) return null;
  const isoDate = text.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1];
  if (isoDate && isExactCalendarDate(isoDate)) return isoDate;

  const monthNames =
    'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
  const monthFirst = text.match(
    new RegExp(`\\b(${monthNames})\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, 'i'),
  );
  const dayFirst = text.match(
    new RegExp(`\\b(\\d{1,2})\\s+(${monthNames})\\s+(\\d{4})\\b`, 'i'),
  );
  const parts = monthFirst
    ? {
        day: Number(monthFirst[2]),
        month: monthNumber(monthFirst[1]),
        year: Number(monthFirst[3]),
      }
    : dayFirst
      ? {
          day: Number(dayFirst[1]),
          month: monthNumber(dayFirst[2]),
          year: Number(dayFirst[3]),
        }
      : null;
  if (parts !== null) {
    const date = `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
    return isExactCalendarDate(date) ? date : null;
  }

  const timestamp = Date.parse(text);
  return Number.isNaN(timestamp)
    ? null
    : new Date(timestamp).toISOString().slice(0, 10);
}

function isExactCalendarDate(value: string): boolean {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function monthNumber(value: string): number {
  return (
    [
      'jan',
      'feb',
      'mar',
      'apr',
      'may',
      'jun',
      'jul',
      'aug',
      'sep',
      'oct',
      'nov',
      'dec',
    ].indexOf(value.slice(0, 3).toLowerCase()) + 1
  );
}

function displayCurrency(record: JsonRecord, amount: unknown): string {
  const explicitCurrency = textValue(
    valueFor(record, ['currency', 'currencycode']),
  );
  return explicitCurrency === null
    ? detectDisplayCurrency(textValue(amount) ?? '')
    : canonicalCurrency(explicitCurrency);
}

function detectDisplayCurrency(value: string): string {
  if (/\bCAD\b|(?:CA|CDN)\$/i.test(value)) return 'CAD';
  if (/\bAUD\b|(?:^|[^A-Z])A\$/i.test(value)) return 'AUD';
  if (/\bGBP\b|£/i.test(value)) return 'GBP';
  if (/\bEUR\b|€/i.test(value)) return 'EUR';
  if (/\bJPY\b|¥/i.test(value)) return 'JPY';
  if (/\bUSD\b|(?:^|[^A-Z])\$/i.test(value)) return 'USD';
  return '---';
}

function headerValue(contents: string, name: string): string | null {
  return (
    contents.match(new RegExp(`^${name}:\\s*(.*)$`, 'im'))?.[1]?.trim() ?? null
  );
}

function labelledValue(text: string, labels: readonly string[]): string | null {
  return labelledValues(text, labels)[0] ?? null;
}

function firstLabelledValue(
  text: string,
  labels: readonly string[],
): string | null {
  for (const label of labels) {
    const value = labelledValue(text, [label]);
    if (value !== null) return value;
  }
  return null;
}

function labelledValues(text: string, labels: readonly string[]): string[] {
  const label = labels
    .map(value => escapeRegularExpression(value).replaceAll(' ', '\\s*'))
    .join('|');
  return [
    ...text.matchAll(
      new RegExp(
        `(?:^|\\n)\\s*(?:${label})\\s*[:#-]?\\s*([^\\n]{1,160})`,
        'gi',
      ),
    ),
  ]
    .map(match => match[1].trim())
    .filter(Boolean);
}

function extractVisibleEmailText(contents: string): string {
  const boundary = contents.match(/boundary=["']?([^"';\s]+)/i)?.[1];
  const parts = boundary
    ? contents.split(
        new RegExp(`--${escapeRegularExpression(boundary)}(?:--)?\\r?\\n`),
      )
    : [contents];
  return parts
    .flatMap(part => {
      const separator = part.search(/\r?\n\r?\n/);
      if (separator < 0) return [];
      const headers = part.slice(0, separator);
      if (/content-disposition:\s*attachment/i.test(headers)) return [];
      const encoded = part.slice(separator).replace(/^\r?\n\r?\n/, '');
      const decoded = /content-transfer-encoding:\s*base64/i.test(headers)
        ? decodeBase64(encoded)
        : /content-transfer-encoding:\s*quoted-printable/i.test(headers)
          ? decodeQuotedPrintable(encoded)
          : encoded;
      return [
        /content-type:\s*text\/html/i.test(headers)
          ? decodeHtml(decoded)
          : decoded,
      ];
    })
    .join('\n');
}

function decodeBase64(value: string): string {
  const compact = value.replace(/\s/g, '');
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      compact,
    )
  ) {
    throw new Error('Invalid base64 Amazon email body.');
  }
  const binary = globalThis.atob(compact);
  return new TextDecoder().decode(
    Uint8Array.from(binary, character => character.charCodeAt(0)),
  );
}

function decodeQuotedPrintable(value: string): string {
  const bytes: number[] = [];
  const unfolded = value.replace(/=\r?\n/g, '');
  for (let index = 0; index < unfolded.length; index += 1) {
    if (unfolded[index] === '=') {
      const encoded = unfolded.slice(index + 1, index + 3);
      if (!/^[\dA-F]{2}$/i.test(encoded)) {
        throw new Error('Invalid quoted-printable Amazon email body.');
      }
      bytes.push(Number.parseInt(encoded, 16));
      index += 2;
    } else {
      bytes.push(unfolded.charCodeAt(index));
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function decodeHtml(value: string): string {
  return value
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?\s*>|<\/(?:div|p|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n');
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function deduplicateOrders(
  orders: readonly AmazonOrder[],
): readonly AmazonOrder[] {
  const byId = new Map<string, AmazonOrder>();
  for (const order of orders) {
    const existing = byId.get(order.orderId);
    if (existing === undefined) {
      byId.set(order.orderId, order);
    } else if (JSON.stringify(existing) !== JSON.stringify(order)) {
      throw new Error('Conflicting duplicate Amazon order.');
    }
  }
  return [...byId.values()];
}
