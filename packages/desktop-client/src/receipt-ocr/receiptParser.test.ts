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
    expect(draft.purchaseDate).toBe('2026-08-04');
    expect(draft.total).toBe(325);
    expect(draft.currency).toBe('USD');
    expect(draft.lineItems).toEqual([{ label: 'Milk', amount: 325 }]);
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

    expect(draft.total).toBe(5678);
  });
});

describe('redactReceiptText', () => {
  it('redacts email, payment card, and phone number without changing other text', () => {
    expect(
      redactReceiptText('a@shop.test 4111 1111 1111 1111 312-555-0100 Milk'),
    ).toBe('[redacted email] •••• 1111 [redacted phone] Milk');
  });
});

const syntheticParserFixtures = [
  ['narrow clear', ['Shop', '2026-01-02', 'TOTAL $1.00'], 100, '2026-01-02'],
  [
    'wide clear',
    ['Big Market', '2026-02-03', 'GRAND TOTAL $12.34'],
    1234,
    '2026-02-03',
  ],
  ['amount due', ['Cafe', '2026-03-04', 'AMOUNT DUE $5.50'], 550, '2026-03-04'],
  [
    'subtotal excluded',
    ['Shop', '2026-04-05', 'SUBTOTAL $9.00', 'TOTAL $10.00'],
    1000,
    '2026-04-05',
  ],
  [
    'tax excluded',
    ['Shop', '2026-05-06', 'TAX $1.00', 'TOTAL $11.00'],
    1100,
    '2026-05-06',
  ],
  [
    'tip excluded',
    ['Shop', '2026-06-07', 'TIP $2.00', 'TOTAL $12.00'],
    1200,
    '2026-06-07',
  ],
  [
    'change excluded',
    ['Shop', '2026-07-08', 'CHANGE $3.00', 'TOTAL $7.00'],
    700,
    '2026-07-08',
  ],
  [
    'savings excluded',
    ['Shop', '2026-08-09', 'SAVINGS $4.00', 'TOTAL $16.00'],
    1600,
    '2026-08-09',
  ],
  [
    'dollar grouping',
    ['Shop', '2026-09-10', 'TOTAL $1,234.56'],
    123456,
    '2026-09-10',
  ],
  ['euro decimal', ['Shop', '2026-10-11', 'TOTAL €12,34'], 1234, '2026-10-11'],
  [
    'pounds explicit',
    ['Shop', '2026-11-12', 'TOTAL £12.34'],
    1234,
    '2026-11-12',
  ],
  [
    'currency code',
    ['Shop', '2026-12-13', 'TOTAL CAD 12.34'],
    1234,
    '2026-12-13',
  ],
  ['integer total', ['Shop', '2026-01-14', 'TOTAL $12'], 1200, '2026-01-14'],
  ['one decimal', ['Shop', '2026-02-15', 'TOTAL $12.3'], 1230, '2026-02-15'],
  [
    'ocr label correction',
    ['Shop', '2026-03-16', 'T0TAL $12.34'],
    1234,
    '2026-03-16',
  ],
  [
    'amount digit correction',
    ['Shop', '2026-04-17', 'TOTAL $1O.00'],
    1000,
    '2026-04-17',
  ],
  [
    'day first unambiguous',
    ['Shop', '13/04/2026', 'TOTAL $1.00'],
    100,
    '2026-04-13',
  ],
  [
    'month first unambiguous',
    ['Shop', '04/13/2026', 'TOTAL $1.00'],
    100,
    '2026-04-13',
  ],
  [
    'year first slash',
    ['Shop', '2026/04/13', 'TOTAL $1.00'],
    100,
    '2026-04-13',
  ],
  ['year first dot', ['Shop', '2026.04.13', 'TOTAL $1.00'], 100, '2026-04-13'],
  ['leap day', ['Shop', '2024-02-29', 'TOTAL $1.00'], 100, '2024-02-29'],
  ['two digit year', ['Shop', '13-04-26', 'TOTAL $1.00'], 100, '2026-04-13'],
  [
    'compact date and pm time',
    ['Shop', '07/10/202607:53PM', 'TOTAL $1.00'],
    100,
    '2026-07-10',
  ],
  [
    'compact date and am time',
    ['Shop', '07/10/202612:01AM', 'TOTAL $1.00'],
    100,
    '2026-07-10',
  ],
  [
    'line item',
    ['Shop', '2026-01-01', 'Milk $3.25', 'TOTAL $3.25'],
    325,
    '2026-01-01',
  ],
  [
    'multiple line items',
    ['Shop', '2026-01-01', 'Milk $3.25', 'Bread $2.75', 'TOTAL $6.00'],
    600,
    '2026-01-01',
  ],
  [
    'payment excluded',
    ['Shop', '2026-01-01', 'VISA $6.00', 'TOTAL $6.00'],
    600,
    '2026-01-01',
  ],
  [
    'grand total wins',
    ['Shop', '2026-01-01', 'TOTAL $6.00', 'GRAND TOTAL $7.00'],
    700,
    '2026-01-01',
  ],
  [
    'amount due wins fallback',
    ['Shop', '2026-01-01', 'AMOUNT DUE $8.00'],
    800,
    '2026-01-01',
  ],
  ['low confidence', ['Shop', '2026-01-01', 'TOTAL $9.00'], 900, '2026-01-01'],
] as const;

function syntheticReceipt(lines: readonly string[], score = 0.98) {
  return {
    items: lines.map((text, index) => ({
      poly: [
        [0, index * 20],
        [100, index * 20],
      ] as [number, number][],
      text,
      score,
    })),
  };
}

describe.each(syntheticParserFixtures)(
  'synthetic parser fixture: %s',
  (_name, lines, expectedTotal, expectedDate) => {
    it('produces bounded deterministic structured fields', () => {
      const draft = createReceiptOcrDraft(syntheticReceipt(lines));

      expect(draft.total).toBe(expectedTotal);
      expect(draft.purchaseDate).toBe(expectedDate);
      expect(draft.warnings.length).toBeLessThanOrEqual(32);
      expect(
        Object.values(draft.fieldConfidence).every(
          value => value >= 0 && value <= 1,
        ),
      ).toBe(true);
    });
  },
);

describe('parser ambiguity and bounds', () => {
  it('warns about ambiguous dates, conflicting totals, and preserves raw corrections', () => {
    const draft = createReceiptOcrDraft(
      syntheticReceipt([
        'Shop',
        '07/10/202607:53PM',
        'TOTAL $10.00',
        'GRAND TOTAL $12.00',
      ]),
    );

    expect(draft.purchaseTime).toBe('19:53');
    expect(draft.warnings).toContain('ambiguous-date');
    expect(draft.warnings).toContain('conflicting-total-candidates');
    expect(draft.rawTranscript).toContain('07/10/202607:53PM');
  });

  it('uses the supplied budget currency only when the OCR amount has no currency', () => {
    const draft = createReceiptOcrDraft(
      syntheticReceipt(['Shop', '2026-01-01', 'TOTAL 12.34']),
      { budgetCurrency: 'cad' },
    );

    expect(draft.currency).toBe('CAD');
    expect(draft.warnings).toContain('assumed-currency');
  });

  it('uses the largest plausible decimal amount only as a reviewable fallback', () => {
    const draft = createReceiptOcrDraft(
      syntheticReceipt([
        'Corner Shop',
        '2026-01-01',
        'Milk 4.50',
        'Bread 3.25',
        '$19.75',
      ]),
      { budgetCurrency: 'USD' },
    );

    expect(draft.total).toBe(1975);
    expect(draft.fieldConfidence.total).toBeLessThan(0.7);
    expect(draft.warnings).toContain('largest-amount-total-needs-review');
    expect(draft.warnings).toContain('low-confidence-total');
  });

  it('keeps raw OCR text while recording only conservative local corrections', () => {
    const draft = createReceiptOcrDraft(
      syntheticReceipt(['Shop', '2026-01-01', 'T0TAL $1O.00']),
    );

    expect(draft.rawTranscript).toContain('T0TAL $1O.00');
    expect(draft.corrections.map(correction => correction.reason)).toEqual([
      'known-label',
      'amount-digit',
    ]);
    expect(draft.total).toBe(1000);
  });
});
