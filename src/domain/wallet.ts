import { InsufficientFundsError } from './errors';
import { WalletLedgerEntry, LedgerDirection } from './ledger-entry';
import { Money, type MoneyProps } from './money';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: MoneyProps;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  public static open(props: { id: string; playerId: string; initialBalance: Money; now: Date }): Wallet {
    return new Wallet(props.id, props.playerId, props.initialBalance.currency, props.initialBalance, 1, props.now, props.now);
  }
  public static rehydrate(state: WalletState): Wallet {
    return new Wallet(state.id, state.playerId, state.currency, Money.from(state.balance), state.version, state.createdAt, state.updatedAt);
  }

  public get balance(): Money { return this._balance; }
  public get version(): number { return this._version; }
  public get updatedAt(): Date { return this._updatedAt; }

  public debit(input: { entryId: string; transactionId: string; money: Money; now: Date }): WalletLedgerEntry {
    this.assertSameCurrency(input.money);
    if (this._balance.isLessThan(input.money)) throw new InsufficientFundsError();
    const before = this._balance;
    const after = before.subtract(input.money);
    const entry = WalletLedgerEntry.create({
      id: input.entryId, walletId: this.id, transactionId: input.transactionId,
      direction: LedgerDirection.Debit, money: input.money, balanceBefore: before,
      balanceAfter: after, createdAt: input.now,
    });
    this.apply(after, input.now);
    return entry;
  }

  public credit(input: { entryId: string; transactionId: string; money: Money; now: Date }): WalletLedgerEntry {
    this.assertSameCurrency(input.money);
    const before = this._balance;
    const after = before.add(input.money);
    const entry = WalletLedgerEntry.create({
      id: input.entryId, walletId: this.id, transactionId: input.transactionId,
      direction: LedgerDirection.Credit, money: input.money, balanceBefore: before,
      balanceAfter: after, createdAt: input.now,
    });
    this.apply(after, input.now);
    return entry;
  }

  private apply(balance: Money, now: Date): void { this._balance = balance; this._version += 1; this._updatedAt = now; }
  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) throw new Error('Wallet currency does not match transaction currency.');
  }
}
