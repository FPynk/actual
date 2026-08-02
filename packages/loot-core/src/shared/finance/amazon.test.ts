import {
  buildAmazonPaymentSources,
  matchAmazonPayments,
  parseAmazonEmail,
  parseAmazonJson,
} from './amazon';

const canonicalOrder = {
  marketplace: 'amazon.com',
  externalOrderId: '123-1234567-1234567',
  orderDate: '2026-01-09',
  currencyCode: 'USD',
  itemSubtotal: 2_500,
  taxTotal: 200,
  shippingTotal: 300,
  discountTotal: 100,
  giftCardTotal: 500,
  refundTotal: 600,
  orderTotal: 2_900,
};

describe('native Amazon parsing and allocation', () => {
  it('parses canonical orders, items, shipments, and refunds in minor units', () => {
    const [order] = parseAmazonJson(
      JSON.stringify({
        orders: [canonicalOrder],
        shipments: [
          {
            marketplace: 'amazon.com',
            externalOrderId: canonicalOrder.externalOrderId,
            externalShipmentId: 'SHIP-1',
            shipmentDate: '2026-01-10',
            shipmentTotal: null,
            orderedItemSignatures: ['ITEM-1'],
          },
        ],
        items: [
          {
            marketplace: 'amazon.com',
            externalOrderId: canonicalOrder.externalOrderId,
            shipmentKey: 'shipment/SHIP-1',
            externalItemId: 'ITEM-1',
            asin: 'ASIN-1',
            sku: null,
            seller: 'Synthetic seller',
            title: 'Coffee filters',
            quantity: 1,
            unitAmount: 2_500,
            taxAmount: 200,
            shippingAmount: 300,
            discountAmount: 100,
            refundAmount: 600,
            currencyCode: 'USD',
          },
        ],
        refunds: [
          {
            marketplace: 'amazon.com',
            externalOrderId: canonicalOrder.externalOrderId,
            itemKey: 'ITEM-1',
            externalRefundId: 'REFUND-1',
            refundDate: '2026-01-20',
            amount: 600,
            currencyCode: 'USD',
            reason: 'Partial refund',
          },
        ],
      }),
    );

    expect(order).toMatchObject({
      orderId: canonicalOrder.externalOrderId,
      orderTotal: 2_900,
      giftCardTotal: 500,
      items: [{ id: 'ITEM-1', shipmentId: 'SHIP-1' }],
      shipments: [{ id: 'SHIP-1', total: null }],
      refunds: [{ id: 'REFUND-1', amount: 600 }],
    });
  });

  it('creates balanced item, tax, shipping, discount, gift-card, and refund evidence', () => {
    const [order] = parseAmazonJson(
      JSON.stringify({
        orders: [canonicalOrder],
        shipments: [],
        items: [
          {
            marketplace: 'amazon.com',
            externalOrderId: canonicalOrder.externalOrderId,
            shipmentKey: null,
            externalItemId: 'ITEM-1',
            asin: null,
            sku: null,
            seller: null,
            title: 'Coffee filters',
            quantity: 1,
            unitAmount: 2_500,
            taxAmount: 200,
            shippingAmount: 300,
            discountAmount: 100,
            refundAmount: 600,
            currencyCode: 'USD',
          },
        ],
        refunds: [
          {
            marketplace: 'amazon.com',
            externalOrderId: canonicalOrder.externalOrderId,
            itemKey: 'ITEM-1',
            externalRefundId: 'REFUND-1',
            refundDate: '2026-01-20',
            amount: 600,
            currencyCode: 'USD',
            reason: 'Partial refund',
          },
        ],
      }),
    );
    const [charge, refund] = buildAmazonPaymentSources([order]);

    expect(charge.amount).toBe(-2_400);
    expect(charge.allocations.map(value => value.kind)).toEqual([
      'merchandise',
      'tax',
      'shipping',
      'discount',
      'gift-card',
    ]);
    expect(
      charge.allocations.reduce((sum, value) => sum + value.amount, 0),
    ).toBe(charge.amount);
    expect(refund).toMatchObject({ amount: 600, kind: 'refund' });
  });

  it('keeps multiple shipment charges separate and balances each charge', () => {
    const [order] = parseAmazonJson(
      JSON.stringify({
        orders: [
          {
            ...canonicalOrder,
            itemSubtotal: 2_000,
            taxTotal: 0,
            shippingTotal: 0,
            discountTotal: 0,
            giftCardTotal: 0,
            refundTotal: 0,
            orderTotal: 2_000,
          },
        ],
        shipments: [
          {
            marketplace: 'amazon.com',
            externalOrderId: canonicalOrder.externalOrderId,
            externalShipmentId: 'SHIP-A',
            shipmentDate: '2026-01-10',
            shipmentTotal: 1_000,
            orderedItemSignatures: ['A'],
          },
          {
            marketplace: 'amazon.com',
            externalOrderId: canonicalOrder.externalOrderId,
            externalShipmentId: 'SHIP-B',
            shipmentDate: '2026-01-11',
            shipmentTotal: 1_000,
            orderedItemSignatures: ['B'],
          },
        ],
        items: [],
        refunds: [],
      }),
    );

    const sources = buildAmazonPaymentSources([order]);
    expect(sources).toHaveLength(2);
    expect(sources.map(source => source.amount)).toEqual([-1_000, -1_000]);
    expect(
      sources.every(
        source =>
          source.allocations.reduce((sum, value) => sum + value.amount, 0) ===
          source.amount,
      ),
    ).toBe(true);
  });

  it('falls back to one balanced card charge when gift cards prevent safe shipment allocation', () => {
    const [order] = parseAmazonJson(
      JSON.stringify({
        orders: [canonicalOrder],
        shipments: [
          {
            marketplace: 'amazon.com',
            externalOrderId: canonicalOrder.externalOrderId,
            externalShipmentId: 'SHIP-1',
            shipmentDate: '2026-01-10',
            shipmentTotal: 2_900,
          },
        ],
        items: [],
        refunds: [],
      }),
    );

    const [source] = buildAmazonPaymentSources([order]);
    expect(source).toMatchObject({
      id: `charge:${canonicalOrder.externalOrderId}`,
      amount: -2_400,
    });
    expect(
      source.allocations.reduce((sum, value) => sum + value.amount, 0),
    ).toBe(source.amount);
  });

  it('parses a normal multipart shipment email without retaining raw content', () => {
    const email = [
      'From: auto-confirm@amazon.com',
      'Subject: Your Amazon.com order has shipped',
      'Date: Fri, 09 Jan 2026 10:00:00 -0600',
      'Content-Type: multipart/alternative; boundary="part"',
      '',
      '--part',
      'Content-Type: text/html',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      '<html><body>Order placed: January 9, 2026<br>Shipment Total: $19.99<br>Product Name: Coffee filters<br>Order # 123-1234567-1234567</body></html>',
      '--part--',
    ].join('\r\n');

    const [order] = parseAmazonEmail(email);
    expect(order).toMatchObject({
      orderId: '123-1234567-1234567',
      date: '2026-01-09',
      shipments: [{ total: 1_999 }],
      items: [{ title: 'Coffee filters' }],
    });
    expect(JSON.stringify(order)).not.toContain('auto-confirm@amazon.com');
  });

  it('uses the shipment total and preserves the stated calendar date', () => {
    const email = [
      'From: auto-confirm@amazon.com',
      'Subject: Your Amazon.com order has shipped',
      'Date: Fri, 09 Jan 2026 23:30:00 -0600',
      'Content-Type: text/html',
      '',
      '<p>Order Total: $29.99</p><p>Shipment Total: $19.99</p><p>Order # 123-1234567-1234567</p>',
    ].join('\r\n');

    const [order] = parseAmazonEmail(email);
    expect(order).toMatchObject({
      date: '2026-01-09',
      shipments: [{ total: 1_999 }],
    });
  });

  it('does not treat an order email refund-policy footer as refund evidence', () => {
    const email = [
      'Subject: Your Amazon.com order confirmation',
      'Date: Fri, 09 Jan 2026 10:00:00 -0600',
      'Content-Type: text/html',
      '',
      '<p>Order Total: $19.99</p><p>Order # 123-1234567-1234567</p><p>See our refund policy for help.</p>',
    ].join('\r\n');

    const [order] = parseAmazonEmail(email);
    expect(order).toMatchObject({
      orderTotal: 1_999,
      refunds: [],
      shipments: [],
    });
  });

  it('rejects invalid dates, duplicate children, and child currency conflicts', () => {
    const sections = {
      orders: [canonicalOrder],
      shipments: [],
      items: [],
      refunds: [],
    };
    expect(() =>
      parseAmazonJson(
        JSON.stringify({
          ...sections,
          orders: [{ ...canonicalOrder, orderDate: '2026-02-30' }],
        }),
      ),
    ).toThrow('Invalid Amazon date.');
    expect(() =>
      parseAmazonJson(
        JSON.stringify({
          ...sections,
          refunds: [
            {
              marketplace: 'amazon.com',
              externalOrderId: canonicalOrder.externalOrderId,
              externalRefundId: 'REFUND-1',
              refundDate: '2026-01-20',
              amount: 100,
              currencyCode: 'EUR',
              reason: null,
            },
          ],
        }),
      ),
    ).toThrow('Amazon child currency does not match its order.');
    expect(() =>
      parseAmazonJson(
        JSON.stringify({
          ...sections,
          shipments: [
            {
              marketplace: 'amazon.com',
              externalOrderId: canonicalOrder.externalOrderId,
              externalShipmentId: 'SHIP-1',
              shipmentDate: '2026-01-10',
              shipmentTotal: 1_000,
            },
            {
              marketplace: 'amazon.com',
              externalOrderId: canonicalOrder.externalOrderId,
              externalShipmentId: 'SHIP-1',
              shipmentDate: '2026-01-11',
              shipmentTotal: 1_900,
            },
          ],
        }),
      ),
    ).toThrow('Duplicate Amazon shipment.');
  });

  it('parses flat refund records as positive refund evidence', () => {
    const [order] = parseAmazonJson(
      JSON.stringify([
        {
          'Order ID': canonicalOrder.externalOrderId,
          'Refund Date': '2026-01-20',
          'Refund Amount': '$6.00',
          Currency: 'USD',
          Status: 'Refunded',
        },
      ]),
    );

    expect(buildAmazonPaymentSources([order])).toMatchObject([
      { kind: 'refund', amount: 600, currency: 'USD' },
    ]);
  });

  it('uses the declared currency precision for flat display amounts', () => {
    const [order] = parseAmazonJson(
      JSON.stringify([
        {
          'Order ID': canonicalOrder.externalOrderId,
          'Order Date': '2026-01-20',
          'Order Total': 'JPY 1999',
          Currency: 'JPY',
          Title: 'Synthetic item',
        },
      ]),
    );

    expect(order).toMatchObject({ currency: 'JPY', orderTotal: 1_999 });
  });

  it('rejects conflicting duplicate imports instead of guessing', () => {
    const order = parseAmazonJson(
      JSON.stringify({
        orders: [canonicalOrder],
        shipments: [],
        items: [],
        refunds: [],
      }),
    )[0];
    expect(() =>
      buildAmazonPaymentSources([
        order,
        { ...order, orderTotal: order.orderTotal + 1 },
      ]),
    ).toThrow('Conflicting duplicate Amazon order.');
  });
});

describe('native Amazon matching', () => {
  const source = {
    id: 'charge:123-1234567-1234567',
    orderId: '123-1234567-1234567',
    kind: 'charge' as const,
    date: '2026-01-09',
    currency: 'USD',
    amount: -1_999,
    description: 'Amazon order 123-1234567-1234567',
    allocations: [
      {
        id: 'item',
        kind: 'merchandise' as const,
        label: 'Coffee filters',
        amount: -1_999,
      },
    ],
  };

  it('marks one exact nearby Amazon transaction ready', () => {
    expect(
      matchAmazonPayments(
        [source],
        [
          {
            id: 'transaction',
            amount: -1_999,
            date: '2026-01-10',
            imported_payee: 'AMZN Marketplace',
          },
        ],
        'USD',
      )[0],
    ).toMatchObject({
      status: 'ready',
      transaction: { id: 'transaction' },
    });
  });

  it('uses resolved payee names and the configured non-USD budget currency', () => {
    expect(
      matchAmazonPayments(
        [{ ...source, currency: 'EUR' }],
        [
          {
            id: 'transaction',
            amount: -1_999,
            date: '2026-01-10',
            payee: 'opaque-payee-id',
            payee_name: 'Amazon EU',
          },
        ],
        'EUR',
      )[0],
    ).toMatchObject({ status: 'ready' });
  });

  it('never selects ambiguous, reconciled, split, stale, or reused targets', () => {
    const matches = matchAmazonPayments(
      [source, { ...source, id: `${source.id}:duplicate` }],
      [
        {
          id: 'eligible',
          amount: -1_999,
          date: '2026-01-10',
          imported_payee: 'Amazon',
        },
        {
          id: 'reconciled',
          amount: -1_999,
          date: '2026-01-09',
          imported_payee: 'Amazon',
          reconciled: true,
        },
        {
          id: 'split-child',
          amount: -1_999,
          date: '2026-01-09',
          imported_payee: 'Amazon',
          is_child: true,
        },
      ],
      'USD',
    );
    expect(matches.map(match => match.status)).toEqual([
      'ambiguous',
      'ambiguous',
    ]);
    expect(matches.every(match => match.transaction === null)).toBe(true);
  });

  it('excludes starting balances and treats every competing exact target as ambiguous', () => {
    expect(
      matchAmazonPayments(
        [source],
        [
          {
            id: 'starting-balance',
            amount: -1_999,
            date: '2026-01-09',
            imported_payee: 'Amazon',
            starting_balance_flag: true,
          },
        ],
        'USD',
      )[0],
    ).toMatchObject({ status: 'unmatched', transaction: null });

    expect(
      matchAmazonPayments(
        [source],
        [
          {
            id: 'same-day',
            amount: -1_999,
            date: '2026-01-09',
            imported_payee: 'Amazon',
          },
          {
            id: 'later',
            amount: -1_999,
            date: '2026-01-13',
            imported_payee: 'Amazon',
          },
        ],
        'USD',
      )[0],
    ).toMatchObject({ status: 'ambiguous', transaction: null });
  });

  it('blocks unsupported currencies', () => {
    expect(
      matchAmazonPayments(
        [{ ...source, currency: 'EUR' }],
        [
          {
            id: 'transaction',
            amount: -1_999,
            date: '2026-01-10',
            imported_payee: 'Amazon',
          },
        ],
        'USD',
      )[0],
    ).toMatchObject({ status: 'unsupported', transaction: null });
  });
});
