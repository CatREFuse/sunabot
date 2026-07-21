const SPA_ROUTE_SEGMENTS = [
  "overview",
  "conversations",
  "web-chat",
  "extensions",
  "agent-prompts",
  "system-prompts",
  "prompts",
  "memory",
  "knowledge",
  "images",
  "emojis",
  "scheduled-tasks",
  "voice",
  "logs",
  "agents",
  "agent-settings",
  "settings",
  "config-doctor"
] as const;

export function isSpaRoute(pathname: string) {
  return pathname === "/" || SPA_ROUTE_SEGMENTS.some(
    (segment) => pathname === `/${segment}` || pathname.startsWith(`/${segment}/`)
  );
}
