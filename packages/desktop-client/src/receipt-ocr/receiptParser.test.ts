import { describe, expect, it } from 'vitest';

import { createReceiptOcrDraft, redactReceiptText } from './receiptParser';

describe('createReceiptOcrDraft', () => {
  it('orders polygons deterministically and extracts basic editable receipt fields', () => {
    const draft = createReceiptOcrDraft({
      items: [
        {
          poly: [
            [0, 40],
            [20, 40],
          ],
          text: 'Milk $3.25',
          score: 0.9,
        },
        {
          poly: [
            [0, 0],
            [20, 0],
          ],
          text: 'Corner Store',
          score: 0.98,
        },
        {
          poly: [
            [0, 60],
            [20, 60],
          ],
          text: 'TOTAL $3.25',
          score: 0.99,
        },
        {
          poly: [
            [0, 20],
            [20, 20],
          ],
          text: '2026-08-04',
          score: 0.95,
        },
      ],
    });

    expect(draft.transcript).toBe(
      'Corner Store\n2026-08-04\nMilk $3.25\nTOTAL $3.25',
    );
    expect(draft.merchant).toBe('Corner Store');
    expect(draft.date).toBe('2026-08-04');
    expect(draft.total).toEqual({ amount: '3.25', currency: '$' });
    expect(draft.lineItems).toEqual([
      { description: 'Milk', total: { amount: '3.25', currency: '$' } },
    ]);
    expect(draft.lines[0]?.polygon).toEqual([
      { x: 0, y: 0 },
      { x: 20, y: 0 },
    ]);
  });

  it('recognizes totals with punctuation boundaries without matching partial digits', () => {
    const draft = createReceiptOcrDraft({
      items: [
        {
          poly: [
            [0, 0],
            [20, 0],
          ],
          text: 'TOTAL:$12.34',
          score: 0.99,
        },
        {
          poly: [
            [0, 20],
            [20, 20],
          ],
          text: 'TOTAL $56.78*',
          score: 0.99,
        },
        {
          poly: [
            [0, 40],
            [20, 40],
          ],
          text: 'TOTAL 123.456',
          score: 0.99,
        },
      ],
    });

    expect(draft.total).toEqual({ amount: '56.78', currency: '$' });
  });
});

describe('redactReceiptText', () => {
  it('redacts email, payment card, and phone number without changing other text', () => {
    expect(
      redactReceiptText('a@shop.test 4111 1111 1111 1111 312-555-0100 Milk'),
    ).toBe('[redacted email] •••• 1111 [redacted phone] Milk');
  });
});
