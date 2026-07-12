import { createApp } from "vue";
import "@fontsource-variable/doto/wght.css";
import "@fontsource-variable/space-grotesk/wght.css";
import "@fontsource/space-mono/400.css";
import "@fontsource/space-mono/700.css";
import "boxicons/css/boxicons.min.css";
import App from "./App.vue";
import { router } from "./router";
import "./assets/main.css";

createApp(App).use(router).mount("#app");
