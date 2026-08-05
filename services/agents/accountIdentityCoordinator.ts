import { ServiceError } from "../../packages/contracts/errors/serviceError.js";
import { AsyncMutex } from "../../packages/platform/mutex.js";
import type { AgentAccount, AgentRegistry } from "./agentRegistry.js";

export interface AccountIdentityLoginControl {
  status(): Promise<{ isLogin: boolean; manualLogin: boolean; error?: string }>;
  beginManualLogin(): Promise<void>;
  cancelManualLogin(): Promise<void>;
}

export interface AccountIdentityGateway {
  isConnected(accountId: string): boolean;
  exit(accountId: string): Promise<void>;
}

export interface AccountIdentityAssignment {
  account: AgentAccount;
  previousAccount?: AgentAccount;
  transferred: boolean;
}

export class AccountIdentityCoordinator {
  private readonly mutex = new AsyncMutex();

  constructor(private readonly options: {
    registry: AgentRegistry;
    controlFor: (account: AgentAccount) => AccountIdentityLoginControl;
    gateway: AccountIdentityGateway;
  }) {}

  assign(accountId: string, qqId: string): Promise<AccountIdentityAssignment> {
    return this.mutex.runExclusive(() => this.assignExclusive(accountId, qqId));
  }

  private async assignExclusive(accountId: string, qqId: string): Promise<AccountIdentityAssignment> {
    const current = this.options.registry.account(accountId);
    if (!current) throw new ServiceError(404, "AGENT_ACCOUNT_NOT_FOUND", "QQ 账号不存在。");
    const previous = (await this.options.registry.list())
      .flatMap((agent) => agent.accounts)
      .find((account) => account.qqId === qqId.trim());
    if (!previous || previous.id === accountId) {
      return {
        account: await this.options.registry.updateAccountIdentity(accountId, qqId),
        transferred: false
      };
    }

    const currentStatus = await this.options.controlFor(current).status().catch(() => undefined);
    if (!currentStatus || currentStatus.error || !currentStatus.isLogin || currentStatus.manualLogin) {
      throw new ServiceError(
        409,
        "QQ_ACCOUNT_TRANSFER_UNAVAILABLE",
        "当前 QQ 登录仍在切换中，请稍后重试。"
      );
    }
    const control = this.options.controlFor(previous);
    const connected = this.options.gateway.isConnected(previous.id);
    if (!connected) {
      const status = await control.status().catch(() => undefined);
      if (!status || status.error || status.isLogin) {
        throw new ServiceError(
          409,
          "QQ_ACCOUNT_TRANSFER_UNAVAILABLE",
          "原 QQ 账号状态异常，暂时无法自动转移。请稍后重试。"
        );
      }
    }

    let manualLoginPrepared = false;
    try {
      await control.beginManualLogin();
      manualLoginPrepared = true;
      if (connected) await this.options.gateway.exit(previous.id);
      const account = await this.options.registry.updateAccountIdentity(accountId, qqId, undefined, true);
      return { account, previousAccount: previous, transferred: true };
    } catch (error) {
      if (manualLoginPrepared) await control.cancelManualLogin().catch(() => undefined);
      if (error instanceof ServiceError) throw error;
      throw new ServiceError(
        502,
        "QQ_ACCOUNT_TRANSFER_FAILED",
        "QQ 账号自动转移失败，请稍后重试。"
      );
    }
  }
}
