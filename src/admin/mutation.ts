import { AsyncMutex } from "../../packages/platform/mutex.js";

export class AdminMutationMutex extends AsyncMutex {}

export const adminMutationMutex = new AdminMutationMutex();

export class AdminRecoveryState {
  private message?: string;

  get() {
    return this.message;
  }

  requireRecovery(message: string) {
    this.message = message;
  }
}

export const adminRecoveryState = new AdminRecoveryState();
