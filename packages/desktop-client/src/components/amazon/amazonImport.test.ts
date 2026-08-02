import { describe, expect, it } from 'vitest';

import { matchAmazonPurchases, parseAmazonEmail, parseAmazonJson } from './amazonImport';

describe('Amazon import parsing', () => {
  it('parses a common Amazon order JSON export without retaining source content', () => {
    expect(parseAmazonJson(JSON.stringify({ orders: [{ 'Order ID': '123-1234567-1234567', 'Order Date': '2026-01-09', 'Order Total': '$19.99', 'Product Name': 'Coffee filters' }] }))).toEqual([{
      id: '123-1234567-1234567', date: '2026-01-09', amount: 1999, currency: null, kind: 'order', description: 'Coffee filters',
    }]);
  });

  it('parses a real-world style multipart shipment email instead of adapter headers', () => {
    const email = [
      'From: auto-confirm@amazon.com',
      'Subject: Your Amazon.com order has shipped',
      'Date: Fri, 09 Jan 2026 10:00:00 -0600',
      'Content-Type: multipart/alternative; boundary="part"',
      '', '--part', 'Content-Type: text/html', 'Content-Transfer-Encoding: quoted-printable', '',
      '<html><body>Order placed: January 9, 2026<br>Order Total: $19.99<br>Product Name: Coffee filters<br>Order # 123-1234567-1234567</body></html>', '--part--',
    ].join('\r\n');
    expect(parseAmazonEmail(email)).toMatchObject([{ id: '123-1234567-1234567', date: '2026-01-09', amount: 1999, kind: 'shipment', description: 'Coffee filters' }]);
  });

  it('does not select ambiguous matching charges', () => {
    const [match] = matchAmazonPurchases([{ id: '123-1234567-1234567', date: '2026-01-09', amount: 1999, currency: 'USD', kind: 'order', description: 'Coffee filters' }], [
      { id: 'one', amount: -1999, date: '2026-01-09', imported_payee: 'Amazon' },
      { id: 'two', amount: -1999, date: '2026-01-10', imported_payee: 'Amazon' },
    ]);
    expect(match).toMatchObject({ status: 'ambiguous', transaction: null });
  });

  it('only marks a nearby Amazon charge as ready', () => {
    const [match] = matchAmazonPurchases([{ id: '123-1234567-1234567', date: '2026-01-09', amount: 1999, currency: 'USD', kind: 'order', description: 'Coffee filters' }], [{ id: 'one', amount: -1999, date: '2026-01-10', imported_payee: 'AMAZON MARKETPLACE' }]);
    expect(match).toMatchObject({ status: 'ready', transaction: { id: 'one' } });
  });

  it('matches refunds only to nearby incoming Amazon transactions', () => {
    const [match] = matchAmazonPurchases([{ id: '123-1234567-1234567', date: '2026-01-09', amount: 1999, currency: 'USD', kind: 'refund', description: 'Coffee filters' }], [{ id: 'one', amount: 1999, date: '2026-01-10', imported_payee: 'AMAZON MARKETPLACE' }]);
    expect(match).toMatchObject({ status: 'ready', transaction: { id: 'one' } });
  });
});
