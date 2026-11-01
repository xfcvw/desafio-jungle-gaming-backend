import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

/**
 * Ponto de extensão para autenticação OIDC de provedores.
 *
 * O desafio deixa a autenticação fora do escopo funcional. Em produção, este
 * guard deve validar o JWT emitido por um IdP externo (Keycloak, Zitadel etc.)
 * e associar a identidade ao providerId; não deve existir tabela local de senha.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  public canActivate(context: ExecutionContext): boolean {
    void context;
    return true;
  }
}
