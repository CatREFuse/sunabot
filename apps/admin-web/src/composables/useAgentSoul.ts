import { onScopeDispose, readonly, shallowRef, watch } from "vue";
import type {
  AgentSoulImportRequest,
  AgentSoulPreview,
  AgentSoulUpload
} from "../../../../packages/contracts/admin/agentSoul.js";
import { AGENT_SOUL_FILE_EXTENSION } from "../../../../packages/contracts/admin/agentSoul.js";
import { apiBlob, apiRequest } from "./useAdminApi";

const MAX_AGENT_SOUL_BYTES = 3 * 1024 * 1024;

export function useAgentSoul(agentId: () => string) {
  const preview = shallowRef<AgentSoulPreview>();
  const upload = shallowRef<AgentSoulUpload>();
  const operation = shallowRef<"" | "export" | "preview" | "import">("");
  const error = shallowRef("");
  const message = shallowRef("");
  let controller: AbortController | undefined;

  watch(agentId, reset);
  onScopeDispose(() => controller?.abort());

  async function exportSoul() {
    const currentAgentId = agentId();
    begin("export");
    try {
      const blob = await apiBlob(`/api/agents/${encodeURIComponent(currentAgentId)}/soul/export`, {
        signal: controller?.signal
      });
      if (currentAgentId !== agentId()) return;
      download(blob, `${currentAgentId}${AGENT_SOUL_FILE_EXTENSION}`);
      message.value = "灵魂文件已导出";
    } catch (cause) {
      if (!aborted(cause)) error.value = errorMessage(cause, "灵魂文件导出失败");
    } finally {
      finish("export");
    }
  }

  async function inspect(file: File | undefined) {
    if (!file) return resetPreview();
    if (!file.name.endsWith(AGENT_SOUL_FILE_EXTENSION)) {
      return fail(`请选择 ${AGENT_SOUL_FILE_EXTENSION} 文件。`);
    }
    if (!file.size || file.size > MAX_AGENT_SOUL_BYTES) {
      return fail("灵魂文件必须小于 3 MiB。");
    }
    const currentAgentId = agentId();
    begin("preview");
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (currentAgentId !== agentId()) return;
      const payload = { fileName: file.name, dataBase64: bytesToBase64(bytes) };
      const result = await apiRequest<AgentSoulPreview>(
        `/api/agents/${encodeURIComponent(currentAgentId)}/soul/preview`,
        { method: "POST", body: JSON.stringify(payload), signal: controller?.signal }
      );
      if (currentAgentId !== agentId()) return;
      upload.value = payload;
      preview.value = result;
    } catch (cause) {
      if (!aborted(cause)) error.value = errorMessage(cause, "灵魂文件校验失败");
    } finally {
      finish("preview");
    }
  }

  async function apply() {
    if (!preview.value || !upload.value) return;
    const currentAgentId = agentId();
    const request: AgentSoulImportRequest = {
      ...upload.value,
      packageSha256: preview.value.packageSha256,
      targetRevision: preview.value.targetRevision
    };
    begin("import");
    try {
      await apiRequest(`/api/agents/${encodeURIComponent(currentAgentId)}/soul/import`, {
        method: "POST",
        body: JSON.stringify(request),
        signal: controller?.signal
      });
      if (currentAgentId !== agentId()) return;
      resetPreview();
      message.value = "灵魂文件已导入";
      return true;
    } catch (cause) {
      if (!aborted(cause)) error.value = errorMessage(cause, "灵魂文件导入失败");
      return false;
    } finally {
      finish("import");
    }
  }

  function begin(next: "export" | "preview" | "import") {
    controller?.abort();
    controller = new AbortController();
    operation.value = next;
    error.value = "";
    message.value = "";
  }

  function finish(expected: "export" | "preview" | "import") {
    if (operation.value === expected) operation.value = "";
  }

  function reset() {
    controller?.abort();
    controller = undefined;
    operation.value = "";
    error.value = "";
    message.value = "";
    resetPreview();
  }

  function resetPreview() {
    preview.value = undefined;
    upload.value = undefined;
  }

  function fail(value: string) {
    resetPreview();
    error.value = value;
  }

  return {
    preview: readonly(preview),
    operation: readonly(operation),
    error: readonly(error),
    message: readonly(message),
    exportSoul,
    inspect,
    apply,
    resetPreview
  };
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function download(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function aborted(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}
