import path from "node:path";
import { EmojiJsonlStore } from "../../adapters/filesystem/emojiJsonlStore.js";
import { applicationDataStore } from "../../adapters/sqlite/applicationDataStore.js";
import { AGENT_RESOURCE_LAYOUT } from "../../packages/platform/agentResourceLayout.js";
import type { AgentWorkbenchBackend } from "../../packages/platform/agentResourceLayout.js";
import { resolveProjectPath } from "../../packages/platform/projectPaths.js";
import { isEmojiFileName } from "../../services/emojis/emojiCatalog.js";
import type { AppConfig } from "../types.js";

export const EMOJI_CATALOG_FILE = "emojis.jsonl";

const stores = new Map<string, EmojiJsonlStore>();

export function emojiMediaDirectory(
  config: Pick<AppConfig, "persona">,
  backend: AgentWorkbenchBackend = "native"
) {
  const agentWorkspace = resolveProjectPath(config.persona.agentWorkspace);
  if (!agentWorkspace) throw new Error("Emoji Agent workspace is invalid.");
  return path.join(
    agentWorkspace,
    backend === "native" ? AGENT_RESOURCE_LAYOUT.emoji : AGENT_RESOURCE_LAYOUT.dockerEmoji
  );
}

export function emojiMediaLocation(
  config: Pick<AppConfig, "persona">,
  fileName: string,
  backend: AgentWorkbenchBackend = "native"
) {
  if (!isEmojiFileName(fileName)) throw new Error("Emoji image file name is invalid.");
  const agentId = config.persona.defaultAgentId.trim() || "plana";
  return {
    filePath: path.join(emojiMediaDirectory(config, backend), fileName),
    url: `/generated-images/${backend === "native" ? "workbench" : "docker-workbench"}/${encodeURIComponent(agentId)}/emoji/${encodeURIComponent(fileName)}`
  };
}

export function emojiCatalogLocation(
  config: Pick<AppConfig, "persona">,
  backend: AgentWorkbenchBackend = "native"
) {
  return path.join(emojiMediaDirectory(config, backend), EMOJI_CATALOG_FILE);
}

export function emojiStore(config: AppConfig, backend: AgentWorkbenchBackend = "native") {
  const catalogPath = emojiCatalogLocation(config, backend);
  const existing = stores.get(catalogPath);
  if (existing) return existing;
  const legacy = applicationDataStore(config);
  const legacyCurrent = backend === "native" ? legacy.readEmojis() : [];
  const store = new EmojiJsonlStore(catalogPath, {
    current: legacyCurrent,
    versions: (key) => legacy.readEmojiVersions(key)
  });
  if (backend === "native" && legacyCurrent.length) {
    store.readAll();
    legacy.clearLegacyEmojis();
  }
  stores.set(catalogPath, store);
  return store;
}

export function closeEmojiStores() {
  stores.clear();
}
