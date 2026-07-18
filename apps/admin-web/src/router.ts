import { createRouter, createWebHistory } from "vue-router";
import ConversationsView from "./views/ConversationsView.vue";
import ConfigDoctorView from "./views/ConfigDoctorView.vue";
import ImagesView from "./views/ImagesView.vue";
import EmojisView from "./views/EmojisView.vue";
import LogsView from "./views/LogsView.vue";
import MemoryView from "./views/MemoryView.vue";
import OverviewView from "./views/OverviewView.vue";
import PromptsView from "./views/PromptsView.vue";
import SettingsView from "./views/SettingsView.vue";
import WebChatView from "./views/WebChatView.vue";
import AgentsView from "./views/AgentsView.vue";
import AgentExtensionsView from "./views/AgentExtensionsView.vue";
import ConversationSettingsView from "./views/ConversationSettingsView.vue";
import ScheduledTasksView from "./views/ScheduledTasksView.vue";
import VoiceView from "./views/VoiceView.vue";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/overview" },
    { path: "/overview", name: "overview", component: OverviewView },
    { path: "/conversations/:conversationId/settings/:section?", name: "conversation-settings", component: ConversationSettingsView },
    { path: "/conversations/:conversationId?", name: "conversations", component: ConversationsView },
    { path: "/scheduled-tasks", name: "scheduled-tasks", component: ScheduledTasksView },
    { path: "/voice", name: "voice", component: VoiceView },
    { path: "/web-chat", name: "web-chat", component: WebChatView },
    { path: "/agent-prompts/:fileId?", name: "agent-prompts", component: PromptsView, props: { scope: "persona" } },
    { path: "/system-prompts/:fileId?", name: "system-prompts", component: PromptsView, props: { scope: "system" } },
    {
      path: "/prompts/:fileId?",
      redirect: (to) => ({ name: "agent-prompts", params: { fileId: to.params.fileId } })
    },
    { path: "/memory", name: "memory", component: MemoryView },
    { path: "/images", name: "images", component: ImagesView },
    { path: "/emojis", name: "emojis", component: EmojisView },
    { path: "/logs", name: "logs", component: LogsView },
    { path: "/agents", name: "agents", component: AgentsView },
    { path: "/extensions", name: "extensions", component: AgentExtensionsView },
    { path: "/agent-settings/:section?", name: "agent-settings", component: SettingsView, props: { scope: "agent" } },
    { path: "/settings/:section?", name: "settings", component: SettingsView, props: { scope: "system" } },
    { path: "/config-doctor", name: "config-doctor", component: ConfigDoctorView },
    { path: "/:pathMatch(.*)*", redirect: "/overview" }
  ],
  scrollBehavior: () => ({ top: 0 })
});
