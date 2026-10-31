import { Body, Controller, Get, Headers, HttpCode, Param, Post } from '@nestjs/common';
import { IsEnum, IsNotEmpty, IsOptional, IsString, Matches, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { WagerTransactionKind } from '../domain/transaction';
import { WageringService } from '../application/wagering.service';

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

@Controller()
export class WageringController {
  public constructor(private readonly wagering: WageringService) {}
  @Post('wallets')
  public createWallet(@Body() body: CreateWalletDto) { return this.wagering.createWallet(body); }
  @Get('wallets/:walletId')
  public getWallet(@Param('walletId') walletId: string) { return this.wagering.getWallet(walletId); }
  @Post('wagering/transactions')
  @HttpCode(200)
  public submit(@Body() body: SubmitWagerDto, @Headers('idempotency-key') idempotencyKey: string | undefined) {
    return this.wagering.submit(body, idempotencyKey ?? '');
  }
}
