import { SessionTurnStore } from "./sessionTurnStore.js";
import type { RecoveryResult, SessionStoreOptions } from "./sessionTypes.js";

export * from "./sessionTypes.js";

const SCHEMA_VERSION = 4;

export class SessionStore extends SessionTurnStore {
  constructor(options: SessionStoreOptions) {
    super(options);
    this.migrate();
    if (options.recoverOnOpen === "expired") this.recoverExpiredLeases();
    if (options.recoverOnOpen === "all") this.recoverAllLeases();
  }

  recoverExpiredLeases(): RecoveryResult {
    return this.recoverLeases(false);
  }

  recoverAllLeases(): RecoveryResult {
    return this.recoverLeases(true);
  }

  private migrate() {
    this.initializeMigrationTable();
    let currentVersion = this.currentSchemaVersion();
    if (currentVersion > SCHEMA_VERSION) {
      throw new Error(`SessionStore schema ${currentVersion} is newer than supported schema ${SCHEMA_VERSION}.`);
    }
    if (currentVersion === SCHEMA_VERSION) return;

    if (currentVersion < 1) this.transaction(() => {
      this.createSessionSchema();
      this.createEventSchema();
      this.createTurnSchema();
      this.createOutboxSchema();
      this.createToolJobSchema();
      this.recordSchemaMigration(1);
    });
    currentVersion = Math.max(currentVersion, 1);

    if (currentVersion < 2) this.transaction(() => {
      this.migrateToolJobSchemaV2();
      this.recordSchemaMigration(2);
    });
    currentVersion = Math.max(currentVersion, 2);

    if (currentVersion < 3) this.transaction(() => {
      this.migrateOutboxSchemaV3();
      this.recordSchemaMigration(3);
    });
    currentVersion = Math.max(currentVersion, 3);

    if (currentVersion < 4) this.transaction(() => {
      this.migrateOutboxSchemaV4();
      this.recordSchemaMigration(4);
    });
  }

  private recoverLeases(all: boolean): RecoveryResult {
    const now = this.now();
    return this.transaction(() => ({
      turns: this.recoverTurnLeases(all, now),
      toolJobs: this.recoverToolJobLeases(all, now),
      outbox: this.recoverOutboxLeases(all, now)
    }));
  }
}
