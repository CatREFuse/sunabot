import { describe, expect, it } from "vitest";
import { isSpaRoute } from "../../apps/api/spaRouting.js";

describe("admin SPA routing", () => {
  it.each([
    "/",
    "/emojis",
    "/emojis/",
    "/scheduled-tasks",
    "/scheduled-tasks/",
    "/voice",
    "/voice/"
  ])("serves the admin application for %s", (pathname) => {
    expect(isSpaRoute(pathname)).toBe(true);
  });

  it.each([
    "/api/emojis",
    "/emoji",
    "/emojis-archive",
    "/scheduled-task",
    "/voices",
    "/definitely-missing"
  ])("keeps non-SPA paths outside the history fallback: %s", (pathname) => {
    expect(isSpaRoute(pathname)).toBe(false);
  });
});
