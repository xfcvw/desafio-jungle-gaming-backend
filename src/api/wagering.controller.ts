import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { WagerTransactionKind, WagerTransactionStatus } from '../domain/transaction';
import { WageringService } from '../application/wagering.service';
import { ProviderAuthGuard } from './provider-auth.guard';

class MoneyDto {
  @IsString() @Matches(/^(?:0|[1-9]\d*)\.\d{2}$/) amount!: string;
  @IsString() @Matches(/^[A-Z]{3}$/) currency!: string;
}
class CreateWalletDto {
  @IsString() @IsNotEmpty() playerId!: string;
  @ValidateNested() @Type(() => MoneyDto) initialBalance!: MoneyDto;
}
class SubmitWagerDto {
  @IsString() @IsNotEmpty() providerId!: string;
  @IsString() @IsNotEmpty() externalTransactionId!: string;
  @IsString() @IsNotEmpty() playerId!: string;
  @IsString() @IsNotEmpty() walletId!: string;
  @IsString() @IsNotEmpty() roundId!: string;
  @IsString() @IsNotEmpty() gameId!: string;
  @IsEnum(WagerTransactionKind) kind!: WagerTransactionKind;
  @ValidateNested() @Type(() => MoneyDto) money!: MoneyDto;
  @IsOptional() @IsString() @IsNotEmpty() referenceExternalTransactionId?: string;
}
class LedgerQueryDto {
  @IsOptional() @IsString() cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

interface HttpResponse { status(code: number): unknown }

@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  public constructor(private readonly wagering: WageringService) {}
  @Post('wallets')
  public createWallet(@Body() body: CreateWalletDto) { return this.wagering.createWallet(body); }
  @Get('wallets/:walletId')
  public getWallet(@Param('walletId') walletId: string) { return this.wagering.getWallet(walletId); }
  @Get('wallets/:walletId/ledger')
  public getLedger(@Param('walletId') walletId: string, @Query() query: LedgerQueryDto) { return this.wagering.getLedger(walletId, query.cursor, query.limit); }
  @Post('wallets/:walletId/reconciliation')
  public reconcile(@Param('walletId') walletId: string) { return this.wagering.reconcile(walletId); }
  @Post('wagering/transactions')
  @HttpCode(200)
  public async submit(
    @Body() body: SubmitWagerDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: HttpResponse,
  ) {
    const result = await this.wagering.submit(body, idempotencyKey ?? '');
    // Falhas de regra de negócio não são falhas do servidor: o cliente recebe o
    // identificador e o saldo observado, mas com uma semântica HTTP explícita.
    if (result.status === WagerTransactionStatus.Rejected) response.status(422);
    return result;
  }
  @Get('wagering/transactions/:transactionId')
  public getTransaction(@Param('transactionId') transactionId: string) { return this.wagering.getTransaction(transactionId); }
  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  public getTransactionByProvider(@Param('providerId') providerId: string, @Param('externalTransactionId') externalTransactionId: string) {
    return this.wagering.getTransactionByProvider(providerId, externalTransactionId);
  }
}
