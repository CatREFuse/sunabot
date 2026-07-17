const HOST_PATH = "[HOST_PATH]";

export function redactMcpHostPaths(value: string) {
  return value
    .replace(/file:\/\/[^\s"'<>]*/giu, (candidate) => safeVirtualFileUri(candidate) ? candidate : HOST_PATH)
    .replace(/(?:%2f)(?:[^\s"'<>%]|%[0-9a-f]{2})+/giu, (candidate) => {
      try {
        const decoded = decodeURIComponent(candidate);
        return decoded.startsWith("/") && !safeVirtualPosixPath(decoded) ? HOST_PATH : candidate;
      } catch {
        return HOST_PATH;
      }
    })
    .replace(/[A-Za-z]:\\[^\s"'<>]*/gu, HOST_PATH)
    .replace(/\\\\[^\\\s"'<>]+\\[^\s"'<>]*/gu, HOST_PATH)
    .replace(/(^|[\s"'=(:,;\[])\/(?!\/)[^\s"'<>]*/gu, (candidate, prefix: string) => {
      const path = candidate.slice(prefix.length);
      return `${prefix}${safeVirtualPosixPath(path) ? path : HOST_PATH}`;
    });
}

function safeVirtualFileUri(value: string) {
  return /^file:\/\/\/(?:workbench|skills)(?:\/[A-Za-z0-9._-]+)*$/u.test(value);
}

function safeVirtualPosixPath(value: string) {
  if (value !== "/workbench" && value !== "/skills" &&
      !value.startsWith("/workbench/") && !value.startsWith("/skills/")) return false;
  return value.split("/").slice(2).every((segment) => Boolean(segment) && segment !== "." && segment !== "..");
}
