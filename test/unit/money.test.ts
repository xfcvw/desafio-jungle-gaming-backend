import { describe, expect, test } from 'bun:test';
import { InvalidMoneyError } from '../../src/domain/errors';
import { Money } from '../../src/domain/money';

describe('Money', () => {
  test('keeps exact decimal arithmetic', () => {
    const result = Money.from({ amount: '0.10', currency: 'BRL' }).add(Money.from({ amount: '0.20', currency: 'BRL' }));
    expect(result.toJSON()).toEqual({ amount: '0.30', currency: 'BRL' });
  });
  test('rejects fractional scale and scientific notation', () => {
    expect(() => Money.from({ amount: '1.001', currency: 'BRL' })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: '1e2', currency: 'BRL' })).toThrow(InvalidMoneyError);
  });
});
