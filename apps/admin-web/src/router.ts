import { defineAsyncComponent } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import RouteLoading from "./components/ui/RouteLoading.vue";

const routeComponent = (loader: () => Promise<unknown>) => defineAsyncComponent({
  loader: loader as () => Promise<{ default: object }>,
  loadingComponent: RouteLoading,
  delay: 80,
  timeout: 20_000
});
const OverviewView = routeComponent(() => import("./views/OverviewView.vue"));
const ConversationsView = routeComponent(() => import("./views/ConversationsView.vue"));
const WebChatView = routeComponent(() => import("./views/WebChatView.vue"));
const PromptsView = routeComponent(() => import("./views/PromptsView.vue"));
const MemoryView = routeComponent(() => import("./views/MemoryView.vue"));
const ImagesView = routeComponent(() => import("./views/ImagesView.vue"));
const LogsView = routeComponent(() => import("./views/LogsView.vue"));
const SettingsView = routeComponent(() => import("./views/SettingsView.vue"));

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
