import type { Page, Route } from "@playwright/test";
import sharp from "sharp";
import type { EmojiPayload, EmojiRecord, EmojiSource } from "../../apps/admin-web/src/types/emojis";
import { installMockApi } from "./mock-api";

export const emojiPresetKeys = [
  "开心",
  "哭",
  "抓狂",
  "惊慌",
  "害羞",
  "极度害羞",
  "困倦",
  "认真",
  "嫌弃脸",
  "生气",
  "汗颜"
] as const;

export interface EmojiMockRequest {
  method: string;
  path: string;
  agentId: string;
  body?: Record<string, unknown>;
}

export interface EmojiManagementMock {
  recordsByAgent: Record<string, EmojiRecord[]>;
  requests: EmojiMockRequest[];
  uploadFixture: Buffer;
}

export async function installEmojiManagementMock(page: Page): Promise<EmojiManagementMock> {
  await installMockApi(page);
  const uploadFixture = await createEmojiFixture();
  const state: EmojiManagementMock = {
    recordsByAgent: {
      plana: [
        emojiRecord("开心", "generated", "plana", 0),
        emojiRecord("害羞", "upload", "plana", 1),
        emojiRecord("摸鱼", "upload", "plana", 2)
      ],
      arona: [
        emojiRecord("认真", "generated", "arona", 3),
        emojiRecord("打招呼", "upload", "arona", 4)
      ]
    },
    requests: [],
    uploadFixture
  };

  await page.route("**/api/emojis**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const agentId = url.searchParams.get("agentId") || "plana";
    const body = request.postData() ? request.postDataJSON() as Record<string, unknown> : undefined;
    state.requests.push({ method, path, agentId, body });

    if (/^\/api\/emojis\/[^/]+\/content$/u.test(path) && method === "GET") {
      return route.fulfill({ status: 200, contentType: "image/png", body: uploadFixture });
    }
    if (path === "/api/emojis" && method === "GET") {
      return fulfillJson(route, payload(state, agentId));
    }
    if (path === "/api/emojis/generate" && method === "POST") {
      const key = requireKey(body);
      upsert(state, agentId, emojiRecord(key, "generated", agentId, state.requests.length));
      return fulfillJson(route, payload(state, agentId));
    }
    if (path === "/api/emojis" && method === "POST") {
      const key = requireKey(body);
      upsert(state, agentId, emojiRecord(key, "upload", agentId, state.requests.length));
      return fulfillJson(route, payload(state, agentId));
    }
    const remove = path.match(/^\/api\/emojis\/([^/]+)$/u);
    if (remove && method === "DELETE") {
      const key = decodeURIComponent(remove[1] ?? "");
      state.recordsByAgent[agentId] = records(state, agentId).filter((record) => record.key !== key);
      return route.fulfill({ status: 204 });
    }
    return fulfillJson(route, {
      error: { code: "MOCK_EMOJI_ROUTE_MISSING", message: `${method} ${path}` }
    }, 404);
  });

  return state;
}

function payload(state: EmojiManagementMock, agentId: string): EmojiPayload {
  return {
    presetKeys: [...emojiPresetKeys],
    emojis: records(state, agentId)
  };
}

function records(state: EmojiManagementMock, agentId: string) {
  return state.recordsByAgent[agentId] ??= [];
}

function upsert(state: EmojiManagementMock, agentId: string, next: EmojiRecord) {
  state.recordsByAgent[agentId] = [...records(state, agentId).filter((record) => record.key !== next.key), next];
}

function requireKey(body: Record<string, unknown> | undefined) {
  const key = typeof body?.key === "string" ? body.key.normalize("NFC").trim() : "";
  if (!key) throw new Error("Emoji mock request is missing key");
  return key;
}

function emojiRecord(key: string, source: EmojiSource, agentId: string, version: number): EmojiRecord {
  const contentPath = `/api/emojis/${encodeURIComponent(key)}/content?agentId=${encodeURIComponent(agentId)}`;
  return {
    key,
    source,
    fileName: `emoji-${agentId}-${version}.png`,
    sizeBytes: 42_496 + version * 128,
    width: 1_024,
    height: 1_024,
    updatedAt: `2026-07-18T08:${String(version).padStart(2, "0")}:00.000Z`,
    originalUrl: contentPath,
    displayUrl: `${contentPath}&variant=display`,
    placeholderUrl: `${contentPath}&variant=placeholder`
  };
}

async function fulfillJson(route: Route, value: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(value)
  });
}

async function createEmojiFixture() {
  const source = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
      <rect width="1024" height="1024" fill="#f6d9df"/>
      <circle cx="512" cy="514" r="342" fill="#fff7f4"/>
      <circle cx="390" cy="470" r="34" fill="#332b31"/>
      <circle cx="634" cy="470" r="34" fill="#332b31"/>
      <path d="M354 642c92 96 224 96 316 0" fill="none" stroke="#d15068" stroke-width="34" stroke-linecap="round"/>
      <circle cx="298" cy="570" r="58" fill="#f5a8b9" opacity=".72"/>
      <circle cx="726" cy="570" r="58" fill="#f5a8b9" opacity=".72"/>
    </svg>
  `);
  return sharp(source).png().toBuffer();
}
