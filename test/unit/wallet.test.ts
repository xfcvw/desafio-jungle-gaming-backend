import { describe, expect, test } from 'bun:test';
import { InsufficientFundsError } from '../../src/domain/errors';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';

describe('Wallet', () => {
  test('creates a debit entry and increments its version', () => {
    const wallet = Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }), now: new Date() });
    const entry = wallet.debit({ entryId: 'l1', transactionId: 't1', money: Money.from({ amount: '80.00', currency: 'BRL' }), now: new Date() });
    expect(wallet.balance.toJSON().amount).toBe('20.00');
    expect(wallet.version).toBe(2);
    expect(entry.isBalanced()).toBe(true);
  });
  test('never allows the aggregate balance below zero', () => {
    const wallet = Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: Money.from({ amount: '10.00', currency: 'BRL' }), now: new Date() });
    expect(() => wallet.debit({ entryId: 'l1', transactionId: 't1', money: Money.from({ amount: '10.01', currency: 'BRL' }), now: new Date() })).toThrow(InsufficientFundsError);
  });
});
