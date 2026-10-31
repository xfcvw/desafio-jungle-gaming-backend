import { Money, type MoneyProps } from './money';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

/** Immutable audit record. There are no mutation methods by design. */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  public static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = new WalletLedgerEntry(
      props.id, props.walletId, props.transactionId, props.direction, props.money,
      props.balanceBefore, props.balanceAfter, props.createdAt,
    );
    if (!entry.isBalanced()) throw new Error('Ledger entry arithmetic is invalid.');
    return entry;
  }

  public static rehydrate(state: WalletLedgerEntry): WalletLedgerEntry { return state; }

  public isBalanced(): boolean {
    const expected = this.direction === LedgerDirection.Credit
      ? this.balanceBefore.add(this.money)
      : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }

  public toJSON(): { money: MoneyProps; balanceBefore: MoneyProps; balanceAfter: MoneyProps } {
    return { money: this.money.toJSON(), balanceBefore: this.balanceBefore.toJSON(), balanceAfter: this.balanceAfter.toJSON() };
  }
}
