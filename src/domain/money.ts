import Decimal from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from './errors';

export interface MoneyProps {
  amount: string;
  currency: string;
}

const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)\.\d{2}$/;
const ISO_CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** Immutable monetary value. Decimal strings are the only public contract. */
export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  public static from(props: MoneyProps): Money {
    if (!ISO_CURRENCY_PATTERN.test(props.currency)) {
      throw new InvalidMoneyError('Currency must be a three-letter ISO-4217 code.');
    }
    if (!DECIMAL_PATTERN.test(props.amount)) {
      throw new InvalidMoneyError('Amount must be a non-negative decimal string with exactly two places.');
    }

    const value = new Decimal(props.amount);
    if (!value.isFinite() || value.isNegative()) {
      throw new InvalidMoneyError('Amount must be finite and non-negative.');
    }
    return new Money(value, props.currency);
  }

  public static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  public add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.from({ amount: this.value.plus(other.value).toFixed(2), currency: this.currency });
  }

  /** This operation is valid only when the result is not negative. */
  public subtract(other: Money): Money {
    this.assertSameCurrency(other);
    const result = this.value.minus(other.value);
    if (result.isNegative()) {
      throw new InvalidMoneyError('The resulting monetary value cannot be negative.');
    }
    return Money.from({ amount: result.toFixed(2), currency: this.currency });
  }

  public negate(): SignedMoney {
    return new SignedMoney(this.value.negated(), this.currency);
  }

  public isZero(): boolean { return this.value.isZero(); }
  public isPositive(): boolean { return this.value.isPositive(); }
  public isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }
  public equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }
  public toJSON(): MoneyProps { return { amount: this.value.toFixed(2), currency: this.currency }; }
  public toString(): string { return `${this.value.toFixed(2)} ${this.currency}`; }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) throw new CurrencyMismatchError();
  }
}

/** Internal arithmetic helper; it is deliberately not accepted at API boundaries. */
export class SignedMoney {
  public constructor(private readonly value: Decimal, public readonly currency: string) {}
  public toString(): string { return this.value.toFixed(2); }
}
