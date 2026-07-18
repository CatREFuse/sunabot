export type EmojiSource = "generated" | "upload";

export interface EmojiRecord {
  key: string;
  source: EmojiSource;
  fileName: string;
  sizeBytes: number;
  width: number;
  height: number;
  updatedAt: string;
  originalUrl: string;
  displayUrl: string;
  placeholderUrl: string;
}

export interface EmojiPayload {
  presetKeys: string[];
  emojis: EmojiRecord[];
}

export interface EmojiUploadInput {
  key: string;
  file: File;
}

export interface EmojiStatus {
  kind: "idle" | "success" | "error";
  message: string;
}
