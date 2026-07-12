import { createRouter, createWebHistory } from "vue-router";
import ConversationsView from "./views/ConversationsView.vue";
import ImagesView from "./views/ImagesView.vue";
import LogsView from "./views/LogsView.vue";
import MemoryView from "./views/MemoryView.vue";
import OverviewView from "./views/OverviewView.vue";
import PromptsView from "./views/PromptsView.vue";
import SettingsView from "./views/SettingsView.vue";
import WebChatView from "./views/WebChatView.vue";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/overview" },
    { path: "/overview", name: "overview", component: OverviewView },
    { path: "/conversations/:conversationId?", name: "conversations", component: ConversationsView },
    { path: "/web-chat", name: "web-chat", component: WebChatView },
    { path: "/prompts/:fileId?", name: "prompts", component: PromptsView },
    { path: "/memory", name: "memory", component: MemoryView },
    { path: "/images", name: "images", component: ImagesView },
    { path: "/logs", name: "logs", component: LogsView },
    { path: "/settings/:section?", name: "settings", component: SettingsView },
    { path: "/:pathMatch(.*)*", redirect: "/overview" }
  ],
  scrollBehavior: () => ({ top: 0 })
});
