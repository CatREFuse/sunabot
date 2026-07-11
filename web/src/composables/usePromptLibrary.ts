import { readonly, shallowRef } from "vue";
import { ApiRequestError, apiRequest } from "./useAdminApi";
import type { AgentFileDetail, AgentFileSummary } from "../types";

const expectedFiles: AgentFileSummary[] = [
  file("persona.agents", "AGENTS", "persona", "AGENTS.md", "fragment"),
  file("persona.soul", "SOUL", "persona", "SOUL.md", "fragment"),
  file("persona.preference", "PREFERENCE", "persona", "PREFERENCE.md", "fragment"),
  file("persona.user", "USER", "persona", "USER.md", "fragment"),
  file("persona.relation", "RELATION", "persona", "RELATION.md", "fragment"),
  file("conversation.reply", "对话回复", "conversation", "conversation_reply.json", "final"),
  file("memory.compress-in", "记忆写入压缩", "memory", "work_memory_compress_in.json", "final"),
  file("memory.compress-out", "记忆归档压缩", "memory", "work_memory_compress_out.json", "final"),
  file("memory.user-profile", "用户画像", "memory", "user_profile_prompt.json", "final"),
  file("orchestrator.user-group", "用户群聊编排器", "orchestrator", "user_groupchat_orchestrator.json", "final"),
  file("conversation.group-summary", "群聊摘要", "conversation", "group_chat_summary.json", "final"),
  file("image.selfie-rewrite", "自拍提示词改写", "image", "selfie_prompt_rewrite.json", "final")
];

const files = shallowRef<AgentFileSummary[]>(expectedFiles);
const loadingList = shallowRef(false);
const listError = shallowRef("");

async function loadList() {
  loadingList.value = true;
  try {
    const payload = await apiRequest<unknown>("/api/agent-files");
    const received = Array.isArray(payload)
      ? payload
      : isRecord(payload) && Array.isArray(payload.files)
        ? payload.files
        : [];
    const map = new Map(received.filter(isSummary).map((item) => [item.id, item]));
    files.value = expectedFiles.map((expected) => ({ ...expected, ...map.get(expected.id) }));
    listError.value = "";
  } catch (error) {
    listError.value = error instanceof Error ? error.message : "文件列表读取失败";
  } finally {
    loadingList.value = false;
  }
}

async function loadFile(id: string) {
  const payload = await apiRequest<unknown>(`/api/agent-files/${encodeURIComponent(id)}`);
  if (isRecord(payload) && isRecord(payload.file)) return payload.file as unknown as AgentFileDetail;
  return payload as AgentFileDetail;
}

async function saveFile(file: AgentFileDetail, content: string) {
  try {
    const payload = await apiRequest<unknown>(`/api/agent-files/${encodeURIComponent(file.id)}`, {
      method: "PUT",
      body: JSON.stringify({ content, revision: file.revision })
    });
    const result = isRecord(payload) && isRecord(payload.file) ? payload.file : payload;
    await loadList();
    return result as unknown as AgentFileDetail;
  } catch (error) {
    if (error instanceof ApiRequestError) throw error;
    throw error;
  }
}

function file(
  id: string,
  title: string,
  category: string,
  fileName: string,
  kind: AgentFileSummary["kind"]
): AgentFileSummary {
  return { id, title, category, kind, variables: [], fileName, revision: "" };
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value != null; }
function isSummary(value: unknown): value is AgentFileSummary {
  return isRecord(value) && typeof value.id === "string" && typeof value.title === "string" && typeof value.fileName === "string";
}

export function usePromptLibrary() {
  return {
    files: readonly(files),
    loadingList: readonly(loadingList),
    listError: readonly(listError),
    loadList,
    loadFile,
    saveFile
  };
}
