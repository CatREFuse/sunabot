import { readonly, shallowRef } from "vue";
import { ApiRequestError, apiRequest } from "./useAdminApi";
import type { AgentFileDetail, AgentFileSummary } from "../types";

const SELFIE_PROMPT_ID = "image.selfie-rewrite";

const allFiles: AgentFileSummary[] = [
  file("persona.agents", "AGENTS", "persona", "AGENTS.md", "fragment"),
  file("persona.soul", "SOUL", "persona", "SOUL.md", "fragment"),
  file("persona.preference", "PREFERENCE", "persona", "PREFERENCE.md", "fragment"),
  file(
    "persona.dialogue_style_examples",
    "对话风格示例",
    "persona",
    "DIALOGUE_STYLE_EXAMPLES.md",
    "fragment"
  ),
  file("persona.user", "USER", "persona", "USER.md", "fragment"),
  file("persona.relation", "RELATION", "persona", "RELATION.md", "fragment"),
  file("conversation.private-reply", "单聊回复", "conversation", "conversation_private_reply.json", "final"),
  file("conversation.group-reply", "群聊回复", "conversation", "conversation_group_reply.json", "final"),
  file("conversation.tone-rewrite", "语气改写", "conversation", "tone_rewrite.json", "final"),
  file("memory.compress-in", "记忆写入压缩", "memory", "work_memory_compress_in.json", "final"),
  file("memory.compress-out", "记忆归档压缩", "memory", "work_memory_compress_out.json", "final"),
  file("memory.user-profile", "用户画像", "memory", "user_profile_prompt.json", "final"),
  file("memory.dream", "梦境整理", "memory", "memory_dream.json", "final"),
  file("orchestrator.user-group", "用户群聊编排器", "orchestrator", "user_groupchat_orchestrator.json", "final"),
  file("conversation.group-summary", "群聊摘要", "conversation", "group_chat_summary.json", "final"),
  file("scheduler.cron-callback", "定时任务回调", "调度", "cron_callback.json", "final"),
  file("air.read", "读空气提示词", "场域知识", "read_air.json", "final"),
  file("image.selfie-rewrite", "自拍提示词改写", "image", "selfie_prompt_rewrite.json", "final")
];

export type PromptLibraryScope = "persona" | "system";

export function usePromptLibrary(scope: PromptLibraryScope, includeSystem = () => false) {
  const files = shallowRef<AgentFileSummary[]>(expectedFiles());
  const loadingList = shallowRef(false);
  const listError = shallowRef("");
  const endpoint = scope === "system" ? "/api/system-prompt-files" : "/api/agent-files";

  async function loadList() {
    loadingList.value = true;
    try {
      const payload = await apiRequest<unknown>(endpoint);
      const received = Array.isArray(payload)
        ? payload
        : isRecord(payload) && Array.isArray(payload.files)
          ? payload.files
          : [];
      const map = new Map(received.filter(isSummary).map((item) => [item.id, item]));
      files.value = expectedFiles().map((expected) => ({ ...expected, ...map.get(expected.id) }));
      listError.value = "";
    } catch (error) {
      listError.value = error instanceof Error ? error.message : "文件列表读取失败";
    } finally {
      loadingList.value = false;
    }
  }

  async function loadFile(id: string) {
    const payload = await apiRequest<unknown>(`${endpoint}/${encodeURIComponent(id)}`);
    if (isRecord(payload) && isRecord(payload.file)) return payload.file as unknown as AgentFileDetail;
    return payload as AgentFileDetail;
  }

  async function saveFile(file: AgentFileDetail, content: string) {
    try {
      const payload = await apiRequest<unknown>(`${endpoint}/${encodeURIComponent(file.id)}`, {
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

  function expectedFiles() {
    if (scope === "system") return allFiles.filter(isSystemFile);
    return allFiles.filter((item) => isAgentFile(item) || (includeSystem() && isSystemFile(item)));
  }

  return {
    files: readonly(files),
    loadingList: readonly(loadingList),
    listError: readonly(listError),
    loadList,
    loadFile,
    saveFile
  };
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
function isAgentFile(file: AgentFileSummary) { return file.kind === "fragment" || file.id === SELFIE_PROMPT_ID; }
function isSystemFile(file: AgentFileSummary) { return file.kind === "final" && file.id !== SELFIE_PROMPT_ID; }
function isSummary(value: unknown): value is AgentFileSummary {
  return isRecord(value) && typeof value.id === "string" && typeof value.title === "string" && typeof value.fileName === "string";
}
