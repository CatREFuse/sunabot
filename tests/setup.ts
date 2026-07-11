import { config } from "@vue/test-utils";
import { afterEach } from "vitest";
import { closeApplicationDataStores, sqliteMemoryPersistence } from "../adapters/sqlite/applicationDataStore.js";
import { configureMemoryPersistence } from "../services/memory/persistence.js";

configureMemoryPersistence(sqliteMemoryPersistence);

config.global.stubs = {
  ...config.global.stubs,
  DialogOverlay: {
    props: ["open"],
    template: '<div v-if="open"><slot /></div>'
  }
};

afterEach(() => {
  closeApplicationDataStores();
  if (typeof document !== "undefined") {
    document.documentElement.removeAttribute("data-theme");
    document.body.innerHTML = "";
  }
  if (typeof localStorage !== "undefined") localStorage.clear();
  if (typeof sessionStorage !== "undefined") sessionStorage.clear();
});
