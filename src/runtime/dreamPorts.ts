import type {
  DreamMemoryRecord,
  DreamRecallStatsSnapshot
} from "../../services/memory/dream/public.js";

export interface RuntimeDreamContextSnapshot {
  workingMemory: string;
  workingRecords: DreamMemoryRecord[];
  longTermRecords: DreamMemoryRecord[];
  storedLongTermRecords: DreamMemoryRecord[];
  workingDigest: string;
  workingRevision?: string;
  longTermDigest: string;
  recallStats: DreamRecallStatsSnapshot[];
  userProfiles: unknown[];
  recentConversations: unknown[];
  activeTasks: unknown[];
  plannedDailySchedule: unknown | null;
  persona: Record<string, unknown>;
}

export interface RuntimeDreamContextPort {
  capture(input: {
    now: Date;
    localDate: string;
    timeZone: string;
    window: { start: string; end: string };
    signal?: AbortSignal;
  }): Promise<RuntimeDreamContextSnapshot>;
}

export interface RuntimeDreamPromptPort {
  render(promptId: string, variables: Readonly<Record<string, unknown>>): Promise<unknown>;
}
