export interface OneBotMessageSegment {
  type: string;
  data?: Record<string, unknown>;
}

export interface OneBotEvent {
  post_type?: string;
  notice_type?: string;
  message_type?: "private" | "group";
  sub_type?: string;
  message_id?: number;
  user_id?: number;
  group_id?: number;
  self_id?: number;
  raw_message?: string;
  message?: string | OneBotMessageSegment[];
  sender?: Record<string, unknown>;
  file?: Record<string, unknown>;
  time?: number;
  echo?: string;
  status?: string;
  retcode?: number;
  msg?: string;
  wording?: string;
  data?: unknown;
}
