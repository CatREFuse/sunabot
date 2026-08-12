import type { SunaRuntime } from "../runtime.js";

type RuntimeAttachmentRefreshHost = Pick<
  SunaRuntime,
  | "attachmentRefreshDirty"
  | "attachmentRefreshPromise"
  | "isRuntimeActive"
  | "refreshAttachmentCacheReferences"
>;

export class RuntimeAttachmentRefresh {
  constructor(private readonly host: RuntimeAttachmentRefreshHost) {}

  schedule() {
    if (!this.host.isRuntimeActive()) return;
    this.host.attachmentRefreshDirty = true;
    if (this.host.attachmentRefreshPromise) return;
    this.host.attachmentRefreshPromise = (async () => {
      while (this.host.attachmentRefreshDirty) {
        if (!this.host.isRuntimeActive()) return;
        this.host.attachmentRefreshDirty = false;
        await this.host.refreshAttachmentCacheReferences();
      }
    })()
      .catch((error) => console.error("[runtime] refresh attachment references failed", error))
      .finally(() => {
        this.host.attachmentRefreshPromise = undefined;
        if (this.host.attachmentRefreshDirty && this.host.isRuntimeActive()) this.schedule();
      });
  }
}
