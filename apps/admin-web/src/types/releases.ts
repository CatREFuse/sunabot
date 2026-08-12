export interface ReleaseChangeGroup {
  title: string;
  items: readonly string[];
}

export interface ReleaseRecord {
  version: string;
  releasedAt: string;
  title: string;
  summary: string;
  groups: readonly ReleaseChangeGroup[];
}

export interface ReleaseCatalog {
  schemaVersion: 1;
  currentVersion: string;
  releases: readonly ReleaseRecord[];
}
