export type EmojiSource = "generated" | "upload";
export type EmojiSendSize = 64 | 128 | 256 | 512 | 1024;

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

export interface EmojiVersionRecord extends EmojiRecord {
  current: boolean;
}

export interface EmojiVersionsPayload {
  key: string;
  versions: EmojiVersionRecord[];
}

export interface EmojiPayload {
  presetKeys: string[];
  emojis: EmojiRecord[];
  sendSize?: EmojiSendSize;
  revision?: string;
}

export interface EmojiUploadInput {
  key: string;
  file: File;
}

export interface EmojiStatus {
  kind: "idle" | "success" | "error";
  message: string;
}
