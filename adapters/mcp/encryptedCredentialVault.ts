import {
  constants as fsConstants,
  promises as fs,
  type BigIntStats
} from "node:fs";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import path from "node:path";
import type {
  McpCredentialBinding,
  McpCredentialVault,
  McpOAuthTokens
} from "./oauth.js";

const VAULT_SCHEMA_VERSION = 1;
const MAX_VAULT_BYTES = 16 * 1024 * 1024;
const MAX_RECORDS = 4_096;
const AES_GCM_NONCE_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;

interface EncryptedRecord {
  nonce: string;
  ciphertext: string;
  tag: string;
}

interface VaultDocument {
  schemaVersion: typeof VAULT_SCHEMA_VERSION;
  records: Record<string, EncryptedRecord>;
}

export interface McpOAuthRegistration {
  tokenEndpoint: string;
  clientId: string;
}

interface StoredCredential {
  binding: McpCredentialBinding;
  tokens: McpOAuthTokens;
  oauth?: McpOAuthRegistration;
  revision: string;
}

export interface McpRefreshCredential {
  tokens: McpOAuthTokens;
  oauth: McpOAuthRegistration;
  revision: string;
}

export interface McpOAuthCredentialVault extends McpCredentialVault {
  storeOAuth(
    binding: McpCredentialBinding,
    tokens: McpOAuthTokens,
    registration: McpOAuthRegistration
  ): Promise<string>;
  resolveForRefresh(handle: string, binding: McpCredentialBinding): Promise<McpRefreshCredential>;
  rotateOAuth(
    handle: string,
    binding: McpCredentialBinding,
    expectedRevision: string,
    tokens: McpOAuthTokens
  ): Promise<string>;
}

export interface EncryptedFileMcpCredentialVaultOptions {
  filePath: string;
  key: Uint8Array;
  now?: () => number;
}

/** AES-256-GCM vault stored as a mode-0600 atomic file below a private directory. */
export class EncryptedFileMcpCredentialVault implements McpOAuthCredentialVault {
  private readonly filePath: string;
  private readonly key: Buffer;
  private readonly now: () => number;
  private operation: Promise<void> = Promise.resolve();

  constructor(options: EncryptedFileMcpCredentialVaultOptions) {
    if (!path.isAbsolute(options.filePath) || options.filePath.includes("\0")) {
      throw stableError("MCP_CREDENTIAL_VAULT_PATH_INVALID");
    }
    if (!(options.key instanceof Uint8Array) || options.key.byteLength !== 32) {
      throw stableError("MCP_CREDENTIAL_VAULT_KEY_INVALID");
    }
    this.filePath = path.normalize(options.filePath);
    this.key = Buffer.from(options.key);
    this.now = options.now ?? Date.now;
  }

  async store(binding: McpCredentialBinding, tokens: McpOAuthTokens) {
    return this.serialized(() => this.storeCredential(binding, tokens));
  }

  async storeOAuth(
    binding: McpCredentialBinding,
    tokens: McpOAuthTokens,
    registration: McpOAuthRegistration
  ) {
    return this.serialized(() => this.storeCredential(binding, tokens, registration));
  }

  async resolve(handle: string, binding: McpCredentialBinding) {
    return this.serialized(async () => {
      const stored = await this.loadCredential(handle, binding);
      if (stored.tokens.expiresAt !== undefined && stored.tokens.expiresAt <= this.now()) {
        throw stableError("MCP_CREDENTIAL_EXPIRED");
      }
      return copyTokens(stored.tokens);
    });
  }

  async resolveForRefresh(handle: string, binding: McpCredentialBinding) {
    return this.serialized(async () => {
      const stored = await this.loadCredential(handle, binding);
      if (!stored.oauth) throw stableError("MCP_OAUTH_REFRESH_UNAVAILABLE");
      return {
        tokens: copyTokens(stored.tokens),
        oauth: { ...stored.oauth },
        revision: stored.revision
      };
    });
  }

  async rotateOAuth(
    handle: string,
    binding: McpCredentialBinding,
    expectedRevision: string,
    tokens: McpOAuthTokens
  ) {
    return this.serialized(async () => {
      validateHandle(handle);
      const normalizedBinding = validateBinding(binding);
      const normalizedTokens = validateTokens(tokens);
      validateRevision(expectedRevision);
      const document = await this.readDocument();
      const record = document.records[handle];
      if (!record) throw stableError("MCP_CREDENTIAL_UNAVAILABLE");
      const stored = this.decrypt(handle, record);
      if (!sameBinding(stored.binding, normalizedBinding)) throw stableError("MCP_CREDENTIAL_UNAVAILABLE");
      if (!stored.oauth) throw stableError("MCP_OAUTH_REFRESH_UNAVAILABLE");
      if (!constantTimeEqual(stored.revision, expectedRevision)) throw stableError("MCP_CREDENTIAL_CONFLICT");
      const revision = randomToken(18);
      document.records[handle] = this.encrypt(handle, {
        binding: normalizedBinding,
        tokens: normalizedTokens,
        oauth: stored.oauth,
        revision
      });
      await this.writeDocument(document);
      return revision;
    });
  }

  async remove(handle: string, binding: McpCredentialBinding) {
    return this.serialized(async () => {
      validateHandle(handle);
      const normalizedBinding = validateBinding(binding);
      const document = await this.readDocument();
      const record = document.records[handle];
      if (!record) throw stableError("MCP_CREDENTIAL_UNAVAILABLE");
      const stored = this.decrypt(handle, record);
      if (!sameBinding(stored.binding, normalizedBinding)) throw stableError("MCP_CREDENTIAL_UNAVAILABLE");
      delete document.records[handle];
      await this.writeDocument(document);
    });
  }

  private async storeCredential(
    binding: McpCredentialBinding,
    tokens: McpOAuthTokens,
    oauth?: McpOAuthRegistration
  ) {
    const normalizedBinding = validateBinding(binding);
    const normalizedTokens = validateTokens(tokens);
    const normalizedOAuth = oauth ? validateRegistration(oauth) : undefined;
    const document = await this.readDocument();
    if (Object.keys(document.records).length >= MAX_RECORDS) throw stableError("MCP_CREDENTIAL_VAULT_LIMIT");
    let handle: string;
    do handle = `mcpcred_${randomToken(24)}`;
    while (document.records[handle]);
    document.records[handle] = this.encrypt(handle, {
      binding: normalizedBinding,
      tokens: normalizedTokens,
      oauth: normalizedOAuth,
      revision: randomToken(18)
    });
    await this.writeDocument(document);
    return handle;
  }

  private async loadCredential(handle: string, binding: McpCredentialBinding) {
    validateHandle(handle);
    const normalizedBinding = validateBinding(binding);
    const document = await this.readDocument();
    const record = document.records[handle];
    if (!record) throw stableError("MCP_CREDENTIAL_UNAVAILABLE");
    const stored = this.decrypt(handle, record);
    if (!sameBinding(stored.binding, normalizedBinding)) throw stableError("MCP_CREDENTIAL_UNAVAILABLE");
    return stored;
  }

  private encrypt(handle: string, stored: StoredCredential): EncryptedRecord {
    const nonce = randomBytes(AES_GCM_NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce, { authTagLength: AES_GCM_TAG_BYTES });
    cipher.setAAD(aad(handle));
    const plaintext = Buffer.from(JSON.stringify(stored));
    try {
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return {
        nonce: nonce.toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url")
      };
    } finally {
      plaintext.fill(0);
    }
  }

  private decrypt(handle: string, record: EncryptedRecord): StoredCredential {
    try {
      const nonce = decode(record.nonce, AES_GCM_NONCE_BYTES);
      const ciphertext = decode(record.ciphertext, undefined, MAX_VAULT_BYTES);
      const tag = decode(record.tag, AES_GCM_TAG_BYTES);
      const decipher = createDecipheriv("aes-256-gcm", this.key, nonce, { authTagLength: AES_GCM_TAG_BYTES });
      decipher.setAAD(aad(handle));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      try {
        return validateStoredCredential(JSON.parse(plaintext.toString("utf8")));
      } finally {
        plaintext.fill(0);
      }
    } catch {
      throw stableError("MCP_CREDENTIAL_VAULT_CORRUPT");
    }
  }

  private async readDocument(): Promise<VaultDocument> {
    const parent = await secureParent(this.filePath);
    let before;
    try {
      before = await fs.lstat(this.filePath, { bigint: true });
    } catch (error) {
      if (hasCode(error, "ENOENT")) return emptyDocument();
      throw stableError("MCP_CREDENTIAL_VAULT_UNAVAILABLE");
    }
    validateVaultFile(before);
    if (before.size > BigInt(MAX_VAULT_BYTES)) throw stableError("MCP_CREDENTIAL_VAULT_CORRUPT");
    let handle;
    try {
      handle = await fs.open(this.filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      const opened = await handle.stat({ bigint: true });
      assertSameFile(before, opened);
      const contents = await handle.readFile({ encoding: "utf8" });
      const after = await handle.stat({ bigint: true });
      assertSameFile(before, after);
      const pathAfter = await fs.lstat(this.filePath, { bigint: true });
      assertSameFile(before, pathAfter);
      await assertParentUnchanged(path.dirname(this.filePath), parent);
      return validateDocument(JSON.parse(contents));
    } catch (error) {
      if (isStableError(error)) throw error;
      throw stableError("MCP_CREDENTIAL_VAULT_CORRUPT");
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async writeDocument(document: VaultDocument) {
    const validated = validateDocument(document);
    const contents = `${JSON.stringify(validated)}\n`;
    if (Buffer.byteLength(contents) > MAX_VAULT_BYTES) throw stableError("MCP_CREDENTIAL_VAULT_LIMIT");
    const parentPath = path.dirname(this.filePath);
    const parent = await secureParent(this.filePath);
    const temporary = path.join(parentPath, `.${path.basename(this.filePath)}.${randomToken(12)}.tmp`);
    let handle;
    try {
      handle = await fs.open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
      await handle.writeFile(contents, { encoding: "utf8" });
      await handle.sync();
      await handle.close();
      handle = undefined;
      await assertParentUnchanged(parentPath, parent);
      await fs.rename(temporary, this.filePath);
      await fs.chmod(this.filePath, 0o600);
      const written = await fs.lstat(this.filePath, { bigint: true });
      validateVaultFile(written);
      await assertParentUnchanged(parentPath, parent);
      const directory = await fs.open(parentPath, fsConstants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      if (isStableError(error)) throw error;
      throw stableError("MCP_CREDENTIAL_VAULT_UNAVAILABLE");
    } finally {
      await handle?.close().catch(() => undefined);
      await fs.unlink(temporary).catch(() => undefined);
    }
  }

  private serialized<T>(action: () => Promise<T>) {
    const result = this.operation.then(action, action);
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }
}

function emptyDocument(): VaultDocument {
  return { schemaVersion: VAULT_SCHEMA_VERSION, records: {} };
}

function validateDocument(value: unknown): VaultDocument {
  if (!isRecord(value) || value.schemaVersion !== VAULT_SCHEMA_VERSION || !isRecord(value.records)) {
    throw stableError("MCP_CREDENTIAL_VAULT_CORRUPT");
  }
  const records: Record<string, EncryptedRecord> = {};
  const entries = Object.entries(value.records);
  if (entries.length > MAX_RECORDS) throw stableError("MCP_CREDENTIAL_VAULT_CORRUPT");
  for (const [handle, candidate] of entries) {
    validateHandle(handle);
    if (!isRecord(candidate)
      || Object.keys(candidate).length !== 3
      || typeof candidate.nonce !== "string"
      || typeof candidate.ciphertext !== "string"
      || typeof candidate.tag !== "string") {
      throw stableError("MCP_CREDENTIAL_VAULT_CORRUPT");
    }
    records[handle] = {
      nonce: candidate.nonce,
      ciphertext: candidate.ciphertext,
      tag: candidate.tag
    };
  }
  return { schemaVersion: VAULT_SCHEMA_VERSION, records };
}

function validateStoredCredential(value: unknown): StoredCredential {
  if (!isRecord(value)
    || !isRecord(value.binding)
    || !isRecord(value.tokens)
    || typeof value.revision !== "string") {
    throw stableError("MCP_CREDENTIAL_VAULT_CORRUPT");
  }
  const oauth = value.oauth === undefined ? undefined : validateRegistration(value.oauth as McpOAuthRegistration);
  return {
    binding: validateBinding(value.binding as unknown as McpCredentialBinding),
    tokens: validateTokens(value.tokens as unknown as McpOAuthTokens),
    oauth,
    revision: validateRevision(value.revision)
  };
}

function validateBinding(binding: McpCredentialBinding): McpCredentialBinding {
  return {
    agentId: identifier(binding.agentId),
    serverId: identifier(binding.serverId),
    subject: identifier(binding.subject),
    resource: resourceUrl(binding.resource)
  };
}

function validateTokens(tokens: McpOAuthTokens): McpOAuthTokens {
  if (!isRecord(tokens)
    || typeof tokens.accessToken !== "string"
    || !validSecret(tokens.accessToken)
    || (tokens.refreshToken !== undefined && (typeof tokens.refreshToken !== "string" || !validSecret(tokens.refreshToken)))
    || (tokens.expiresAt !== undefined && (!Number.isSafeInteger(tokens.expiresAt) || tokens.expiresAt < 0))) {
    throw stableError("MCP_CREDENTIAL_INVALID");
  }
  return copyTokens(tokens);
}

function validateRegistration(registration: McpOAuthRegistration) {
  if (!isRecord(registration)
    || typeof registration.tokenEndpoint !== "string"
    || typeof registration.clientId !== "string"
    || !validIdentifier(registration.clientId)) {
    throw stableError("MCP_OAUTH_REGISTRATION_INVALID");
  }
  return {
    tokenEndpoint: secureHttpsUrl(registration.tokenEndpoint, "MCP_OAUTH_TOKEN_ENDPOINT_INVALID"),
    clientId: registration.clientId
  };
}

function validateRevision(value: string) {
  if (!/^[A-Za-z0-9_-]{16,64}$/u.test(value)) throw stableError("MCP_CREDENTIAL_VAULT_CORRUPT");
  return value;
}

function validateHandle(handle: string) {
  if (!/^mcpcred_[A-Za-z0-9_-]{24,128}$/u.test(handle)) throw stableError("MCP_CREDENTIAL_UNAVAILABLE");
}

function identifier(value: string) {
  if (!validIdentifier(value)) throw stableError("MCP_CREDENTIAL_BINDING_INVALID");
  return value;
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value === value.trim()
    && !value.includes("\0")
    && Buffer.byteLength(value) <= 256;
}

function validSecret(value: string) {
  return value.length > 0 && !value.includes("\0") && Buffer.byteLength(value) <= 16 * 1024;
}

function resourceUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw stableError("MCP_CREDENTIAL_BINDING_INVALID");
  }
  const localhost = url.hostname.toLowerCase() === "localhost";
  if ((url.protocol !== "https:" && !(localhost && url.protocol === "http:"))
    || url.username || url.password || url.hash) {
    throw stableError("MCP_CREDENTIAL_BINDING_INVALID");
  }
  return url.toString();
}

function secureHttpsUrl(raw: string, code: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw stableError(code);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw stableError(code);
  return url.toString();
}

async function secureParent(filePath: string) {
  const parentPath = path.dirname(filePath);
  try {
    const parent = await fs.lstat(parentPath, { bigint: true });
    if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077n) !== 0n || !ownedByCurrentUser(parent.uid)) {
      throw stableError("MCP_CREDENTIAL_VAULT_PERMISSIONS");
    }
    return parent;
  } catch (error) {
    if (isStableError(error)) throw error;
    throw stableError("MCP_CREDENTIAL_VAULT_UNAVAILABLE");
  }
}

async function assertParentUnchanged(parentPath: string, expected: BigIntStats) {
  const current = await fs.lstat(parentPath, { bigint: true });
  if (current.dev !== expected.dev || current.ino !== expected.ino || !current.isDirectory() || current.isSymbolicLink()) {
    throw stableError("MCP_CREDENTIAL_VAULT_UNAVAILABLE");
  }
}

function validateVaultFile(stats: BigIntStats) {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1n || (stats.mode & 0o077n) !== 0n || !ownedByCurrentUser(stats.uid)) {
    throw stableError("MCP_CREDENTIAL_VAULT_PERMISSIONS");
  }
}

function assertSameFile(left: BigIntStats, right: BigIntStats) {
  if (left.dev !== right.dev || left.ino !== right.ino || left.size !== right.size || left.mtimeNs !== right.mtimeNs) {
    throw stableError("MCP_CREDENTIAL_VAULT_UNAVAILABLE");
  }
}

function ownedByCurrentUser(uid: bigint) {
  return typeof process.getuid !== "function" || uid === BigInt(process.getuid());
}

function aad(handle: string) {
  return Buffer.from(`sunabot-mcp-oauth-v${VAULT_SCHEMA_VERSION}\0${handle}`);
}

function decode(value: string, exactBytes?: number, maxBytes = 64 * 1024) {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length > maxBytes * 2) throw stableError("MCP_CREDENTIAL_VAULT_CORRUPT");
  const decoded = Buffer.from(value, "base64url");
  if ((exactBytes !== undefined && decoded.byteLength !== exactBytes) || decoded.byteLength > maxBytes) {
    throw stableError("MCP_CREDENTIAL_VAULT_CORRUPT");
  }
  return decoded;
}

function sameBinding(left: McpCredentialBinding, right: McpCredentialBinding) {
  return left.agentId === right.agentId
    && left.serverId === right.serverId
    && left.subject === right.subject
    && left.resource === right.resource;
}

function constantTimeEqual(left: string, right: string) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function copyTokens(tokens: McpOAuthTokens): McpOAuthTokens {
  return {
    accessToken: tokens.accessToken,
    ...(tokens.refreshToken === undefined ? {} : { refreshToken: tokens.refreshToken }),
    ...(tokens.expiresAt === undefined ? {} : { expiresAt: tokens.expiresAt })
  };
}

function randomToken(bytes: number) {
  return randomBytes(bytes).toString("base64url");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasCode(error: unknown, code: string) {
  return isRecord(error) && error.code === code;
}

function isStableError(error: unknown) {
  return error instanceof Error && error.name === "McpCredentialVaultError";
}

function stableError(code: string) {
  const error = new Error(code);
  error.name = "McpCredentialVaultError";
  return error;
}
