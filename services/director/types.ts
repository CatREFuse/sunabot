export const DIRECTOR_SEED_PROMPT_ID = "persona.director-seed";
export const DIRECTOR_SEED_FILE = "DIRECTOR_SEED.md";

export const DIRECTOR_DAILY_PLAN_PROMPT_ID = "director.daily-plan";
export const DIRECTOR_DAILY_PLAN_PROMPT_FILE = "director_daily_plan.json";
export const DIRECTOR_DAILY_PLAN_PAYLOAD_VARIABLE = "director.plan.payload";

export const DIRECTOR_SCHEDULE_REVISION_PROMPT_ID = "director.schedule-revision";
export const DIRECTOR_SCHEDULE_REVISION_PROMPT_FILE = "director_schedule_revision.json";
export const DIRECTOR_SCHEDULE_REVISION_PAYLOAD_VARIABLE = "director.revision.payload";

export const DIRECTOR_SEED_VARIABLE = "director.seed";
export const DIRECTOR_CONVERSATION_SCHEDULE_VARIABLE = "conversation.director.schedule";

export type DirectorScheduleSource = "daily_plan" | "character_revision";

export interface DirectorScheduleShareV1 {
  enabled: boolean;
  at: string | null;
  textIntent: string | null;
  selfiePrompt: string | null;
}

export interface DirectorScheduleItemV1 {
  id: string;
  startAt: string;
  endAt: string;
  activity: string;
  location: string;
  participants: string[];
  intent: string;
  variant: string;
  share: DirectorScheduleShareV1;
}

export interface DirectorScheduleDraftV1 {
  schemaVersion: 1;
  date: string;
  timeZone: string;
  theme: string;
  summary: string;
  items: DirectorScheduleItemV1[];
}

export interface DirectorScheduleV1 extends DirectorScheduleDraftV1 {
  revision: number;
  source: DirectorScheduleSource;
  generatedAt: string;
  updatedAt: string;
}

export interface DirectorScheduleTaskLink {
  scheduleDate: string;
  revision: number;
  itemId: string;
  taskId: string;
  runAt: string;
  createdAt: string;
}

export interface DirectorScheduleCommitInput {
  draft: DirectorScheduleDraftV1;
  seedHash: string;
  source: DirectorScheduleSource;
  requestText?: string;
  expectedRevision?: number;
  now?: Date;
}

export type DirectorScheduleCommitResult =
  | { status: "committed"; schedule: DirectorScheduleV1 }
  | { status: "existing"; schedule: DirectorScheduleV1 }
  | { status: "conflict"; schedule: DirectorScheduleV1 };

export interface DirectorStore {
  read(date: string): DirectorScheduleV1 | undefined;
  commit(input: DirectorScheduleCommitInput): DirectorScheduleCommitResult;
  listTaskLinks(date: string): DirectorScheduleTaskLink[];
  linkTask(link: DirectorScheduleTaskLink): void;
  deleteTaskLink(taskId: string): void;
}
