import { readonly, shallowRef } from "vue";
import type {
  ReleaseCatalog,
  ReleaseChangeGroup,
  ReleaseRecord
} from "../types/releases";
import { apiRequestUnscoped } from "./useAdminApi";

export function useReleaseCatalog() {
  const catalog = shallowRef<ReleaseCatalog | null>(null);
  const loading = shallowRef(false);
  const error = shallowRef("");
  let requestId = 0;

  async function load() {
    const currentRequestId = ++requestId;
    loading.value = true;
    error.value = "";
    try {
      const result = parseReleaseCatalog(await apiRequestUnscoped<unknown>("/api/releases"));
      if (currentRequestId !== requestId) return false;
      catalog.value = result;
      return true;
    } catch (cause) {
      if (currentRequestId !== requestId) return false;
      error.value = cause instanceof Error && cause.message.trim()
        ? cause.message
        : "版本信息加载失败。";
      return false;
    } finally {
      if (currentRequestId === requestId) loading.value = false;
    }
  }

  function dispose() {
    requestId += 1;
    loading.value = false;
  }

  return {
    catalog: readonly(catalog),
    loading: readonly(loading),
    error: readonly(error),
    load,
    dispose
  };
}

function parseReleaseCatalog(value: unknown): ReleaseCatalog {
  const catalog = record(value);
  if (
    catalog.schemaVersion !== 1
    || typeof catalog.currentVersion !== "string"
    || !catalog.currentVersion.trim()
    || !Array.isArray(catalog.releases)
  ) throw new Error("版本信息格式无效。");

  const releases = catalog.releases.map(parseRelease);
  const versions = new Set(releases.map((release) => release.version));
  if (versions.size !== releases.length || !versions.has(catalog.currentVersion)) {
    throw new Error("版本信息格式无效。");
  }
  return {
    schemaVersion: 1,
    currentVersion: catalog.currentVersion,
    releases
  };
}

function parseRelease(value: unknown): ReleaseRecord {
  const release = record(value);
  if (
    typeof release.version !== "string"
    || !release.version.trim()
    || typeof release.releasedAt !== "string"
    || !/^\d{4}-\d{2}-\d{2}$/u.test(release.releasedAt)
    || typeof release.title !== "string"
    || !release.title.trim()
    || typeof release.summary !== "string"
    || !release.summary.trim()
    || !Array.isArray(release.groups)
  ) throw new Error("版本信息格式无效。");
  return {
    version: release.version,
    releasedAt: release.releasedAt,
    title: release.title,
    summary: release.summary,
    groups: release.groups.map(parseChangeGroup)
  };
}

function parseChangeGroup(value: unknown): ReleaseChangeGroup {
  const group = record(value);
  if (
    typeof group.title !== "string"
    || !group.title.trim()
    || !Array.isArray(group.items)
    || group.items.some((item) => typeof item !== "string" || !item.trim())
  ) throw new Error("版本信息格式无效。");
  return {
    title: group.title,
    items: group.items as string[]
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("版本信息格式无效。");
  }
  return value as Record<string, unknown>;
}
