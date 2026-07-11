import type { Config } from "tailwindcss";

export default {
  content: ["./apps/admin-web/index.html", "./apps/admin-web/src/**/*.{vue,ts}"],
  theme: {
    extend: {
      fontFamily: {
        display: ["Doto", "system-ui", "sans-serif"],
        sans: ["Space Grotesk", "system-ui", "sans-serif"],
        mono: ["Space Mono", "ui-monospace", "monospace"]
      },
      colors: {
        ink: "rgb(var(--color-ink) / <alpha-value>)",
        display: "rgb(var(--color-display) / <alpha-value>)",
        mute: "rgb(var(--color-mute) / <alpha-value>)",
        disabled: "rgb(var(--color-disabled) / <alpha-value>)",
        page: "rgb(var(--color-page) / <alpha-value>)",
        panel: "rgb(var(--color-panel) / <alpha-value>)",
        raised: "rgb(var(--color-raised) / <alpha-value>)",
        line: "rgb(var(--color-line) / <alpha-value>)",
        visible: "rgb(var(--color-visible) / <alpha-value>)",
        accent: "rgb(var(--color-accent) / <alpha-value>)",
        success: "rgb(var(--color-success) / <alpha-value>)",
        warning: "rgb(var(--color-warning) / <alpha-value>)"
      }
    }
  },
  plugins: []
} satisfies Config;
