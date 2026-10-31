export class DomainError extends Error {
  public constructor(message: string, public readonly code: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class InvalidMoneyError extends DomainError {
  public constructor(message: string) {
    super(message, 'INVALID_MONEY');
  }
}

export class CurrencyMismatchError extends DomainError {
  public constructor() {
    super('Money values must use the same currency.', 'CURRENCY_MISMATCH');
  }
}

export class InsufficientFundsError extends DomainError {
  public constructor() {
    super('The wallet has insufficient funds for this operation.', 'INSUFFICIENT_FUNDS');
  }
}

export class InvalidTransactionStateError extends DomainError {
  public constructor() {
    super('A terminal transaction cannot transition to another state.', 'INVALID_TRANSACTION_STATE');
  }
}
