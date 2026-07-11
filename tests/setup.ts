import { config } from "@vue/test-utils";
import { afterEach } from "vitest";
import { closeApplicationDataStores } from "../src/dataStore.js";

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
