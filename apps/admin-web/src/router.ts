import { createRouter, createWebHistory } from "vue-router";

const ConversationsView = () => import("./views/ConversationsView.vue");
const ConfigDoctorView = () => import("./views/ConfigDoctorView.vue");
const ImagesView = () => import("./views/ImagesView.vue");
const EmojisView = () => import("./views/EmojisView.vue");
const LogsView = () => import("./views/LogsView.vue");
const MemoryView = () => import("./views/MemoryView.vue");
const KnowledgeView = () => import("./views/KnowledgeView.vue");
const OverviewView = () => import("./views/OverviewView.vue");
const PromptsView = () => import("./views/PromptsView.vue");
const SettingsView = () => import("./views/SettingsView.vue");
const WebChatView = () => import("./views/WebChatView.vue");
const AgentsView = () => import("./views/AgentsView.vue");
const AgentExtensionsView = () => import("./views/AgentExtensionsView.vue");
const ConversationSettingsView = () => import("./views/ConversationSettingsView.vue");
const ScheduledTasksView = () => import("./views/ScheduledTasksView.vue");
const DirectorView = () => import("./views/DirectorView.vue");
const VoiceView = () => import("./views/VoiceView.vue");
const ReleasesView = () => import("./views/ReleasesView.vue");

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/overview" },
    { path: "/overview", name: "overview", component: OverviewView },
    { path: "/conversations/:conversationId/settings/:section?", name: "conversation-settings", component: ConversationSettingsView },
    { path: "/conversations/:conversationId?", name: "conversations", component: ConversationsView },
    { path: "/scheduled-tasks", name: "scheduled-tasks", component: ScheduledTasksView },
    { path: "/director", name: "director", component: DirectorView },
    { path: "/voice", name: "voice", component: VoiceView },
    { path: "/web-chat", name: "web-chat", component: WebChatView },
    { path: "/agent-prompts/:fileId?", name: "agent-prompts", component: PromptsView, props: { scope: "persona" } },
    { path: "/system-prompts/:fileId?", name: "system-prompts", component: PromptsView, props: { scope: "system" } },
    {
      path: "/prompts/:fileId?",
      redirect: (to) => ({ name: "agent-prompts", params: { fileId: to.params.fileId } })
    },
    { path: "/memory", name: "memory", component: MemoryView },
    { path: "/knowledge", name: "knowledge", component: KnowledgeView },
    { path: "/images", name: "images", component: ImagesView },
    { path: "/emojis", name: "emojis", component: EmojisView },
    { path: "/logs", name: "logs", component: LogsView },
    { path: "/agents", name: "agents", component: AgentsView },
    { path: "/extensions", name: "extensions", component: AgentExtensionsView },
    { path: "/agent-settings/:section?", name: "agent-settings", component: SettingsView, props: { scope: "agent" } },
    { path: "/settings/:section?", name: "settings", component: SettingsView, props: { scope: "system" } },
    { path: "/config-doctor", name: "config-doctor", component: ConfigDoctorView },
    { path: "/releases", name: "releases", component: ReleasesView },
    { path: "/:pathMatch(.*)*", redirect: "/overview" }
  ],
  scrollBehavior: () => ({ top: 0 })
});
