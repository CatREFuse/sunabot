export type WorkbenchBackend = "native" | "docker";

export function workbenchLabel(workbench: WorkbenchBackend) {
  return workbench === "native" ? "Native" : "Docker";
}

export function workbenchResourceKey(workbench: WorkbenchBackend, id: string) {
  return `${workbench}:${id}`;
}
