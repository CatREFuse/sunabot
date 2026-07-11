import { computed, readonly, shallowRef, watch } from "vue";

export type ThemePreference = "system" | "light" | "dark";
const STORAGE_KEY = "sunabot.theme";
const stored = localStorage.getItem(STORAGE_KEY);
const preference = shallowRef<ThemePreference>(stored === "light" || stored === "dark" ? stored : "system");
const systemDark = shallowRef(matchMedia("(prefers-color-scheme: dark)").matches);
const effectiveTheme = computed<"light" | "dark">(() =>
  preference.value === "system" ? (systemDark.value ? "dark" : "light") : preference.value
);
let initialized = false;

function applyTheme() {
  document.documentElement.dataset.theme = effectiveTheme.value;
  document.documentElement.style.colorScheme = effectiveTheme.value;
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute("content", effectiveTheme.value === "dark" ? "#000000" : "#f5f5f5");
}

export function useTheme() {
  if (!initialized) {
    initialized = true;
    const query = matchMedia("(prefers-color-scheme: dark)");
    query.addEventListener("change", (event) => (systemDark.value = event.matches));
    watch(effectiveTheme, applyTheme, { immediate: true });
  }

  function setTheme(next: ThemePreference) {
    preference.value = next;
    localStorage.setItem(STORAGE_KEY, next);
  }

  return { preference: readonly(preference), effectiveTheme, setTheme };
}
