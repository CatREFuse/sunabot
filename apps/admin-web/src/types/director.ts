export interface DirectorScheduleShare {
  enabled: boolean;
  at: string | null;
  textIntent: string | null;
  selfiePrompt: string | null;
}

export interface DirectorScheduleItem {
  id: string;
  startAt: string;
  endAt: string;
  activity: string;
  location: string;
  participants: readonly string[];
  intent: string;
  variant: string;
  share: DirectorScheduleShare;
}

export interface DirectorSchedule {
  schemaVersion: 1;
  date: string;
  timeZone: string;
  theme: string;
  summary: string;
  items: readonly DirectorScheduleItem[];
  revision: number;
  source: "daily_plan" | "character_revision";
  generatedAt: string;
  updatedAt: string;
}

export interface DirectorSchedulesResponse {
  schedules: DirectorSchedule[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    pageCount: number;
  };
}
