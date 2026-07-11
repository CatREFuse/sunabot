import { createRouter, createWebHistory } from "vue-router";

const OverviewView = () => import("./views/OverviewView.vue");
const ConversationsView = () => import("./views/ConversationsView.vue");
const PromptsView = () => import("./views/PromptsView.vue");
const MemoryView = () => import("./views/MemoryView.vue");
const ImagesView = () => import("./views/ImagesView.vue");
const SettingsView = () => import("./views/SettingsView.vue");

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/overview" },
    { path: "/overview", name: "overview", component: OverviewView },
    { path: "/conversations/:conversationId?", name: "conversations", component: ConversationsView },
    { path: "/prompts/:fileId?", name: "prompts", component: PromptsView },
    { path: "/memory", name: "memory", component: MemoryView },
    { path: "/images", name: "images", component: ImagesView },
    { path: "/settings/:section?", name: "settings", component: SettingsView },
    { path: "/:pathMatch(.*)*", redirect: "/overview" }
  ],
  scrollBehavior: () => ({ top: 0 })
});
