import { readonly, shallowRef } from "vue";
import { apiRequest } from "./useAdminApi";

export interface AgentConfigImportFilePayload {
  path: string;
  dataBase64: string;
}

export type AgentConfigImportPayload =
  | { source: "folder"; files: AgentConfigImportFilePayload[] }
  | { source: "zip"; fileName: string; dataBase64: string };

export interface AgentConfigImportPreview {
  source: "folder" | "zip";
  included: string[];
  missing: string[];
}

const MAX_FOLDER_BYTES = 80 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

export function useAgentConfigImport() {
  const preview = shallowRef<AgentConfigImportPreview>();
  const loading = shallowRef(false);
  const error = shallowRef("");

  async function selectFolder(files: FileList | File[]) {
    const selected = [...files];
    if (!selected.length) return clear();
    const total = selected.reduce((sum, file) => sum + file.size, 0);
    if (total > MAX_FOLDER_BYTES) rejectSelection("配置文件夹超过 80 MiB 限制。");
    const payload: AgentConfigImportPayload = {
      source: "folder",
      files: await Promise.all(selected.map(async (file) => ({
        path: directoryPath(file),
        dataBase64: await readBase64(file)
      })))
    };
    await inspect(payload);
    return payload;
  }

  async function selectZip(file: File | undefined) {
    if (!file) return clear();
    if (file.size > MAX_ARCHIVE_BYTES) rejectSelection("ZIP 配置包超过 64 MiB 限制。");
    const payload: AgentConfigImportPayload = {
      source: "zip",
      fileName: file.name,
      dataBase64: await readBase64(file)
    };
    await inspect(payload);
    return payload;
  }

  async function inspect(payload: AgentConfigImportPayload) {
    loading.value = true;
    error.value = "";
    try {
      preview.value = await apiRequest<AgentConfigImportPreview>("/api/agent-imports/preview", {
        method: "POST",
        body: JSON.stringify(payload)
      });
    } catch (cause) {
      preview.value = undefined;
      error.value = cause instanceof Error && cause.message ? cause.message : "配置包校验失败";
      throw cause;
    } finally {
      loading.value = false;
    }
  }

  function clear() {
    preview.value = undefined;
    error.value = "";
    return undefined;
  }

  function rejectSelection(message: string): never {
    preview.value = undefined;
    error.value = message;
    throw new Error(message);
  }

  return { preview: readonly(preview), loading: readonly(loading), error: readonly(error), selectFolder, selectZip, clear };
}

function directoryPath(file: File) {
  const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return relative?.trim() || file.name;
}

async function readBase64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}
