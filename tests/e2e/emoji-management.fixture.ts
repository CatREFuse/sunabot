import type { Page, Route } from "@playwright/test";
import sharp from "sharp";
import type { EmojiPayload, EmojiRecord, EmojiSource, EmojiVersionRecord } from "../../apps/admin-web/src/types/emojis";
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
  versionsByAgent: Record<string, Record<string, EmojiVersionRecord[]>>;
  sendSizeByAgent: Record<string, 64 | 128 | 256 | 512 | 1024>;
  sendSeparatelyByAgent: Record<string, boolean>;
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
    versionsByAgent: {},
    sendSizeByAgent: { plana: 512, arona: 256 },
    sendSeparatelyByAgent: { plana: false, arona: false },
    requests: [],
    uploadFixture
  };
  for (const [agentId, agentRecords] of Object.entries(state.recordsByAgent)) {
    state.versionsByAgent[agentId] = Object.fromEntries(agentRecords.map((record) => [
      record.key,
      [{ ...record, current: true }]
    ]));
  }

  await page.route("**/api/emojis**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const agentId = url.searchParams.get("agentId") || "plana";
    const body = request.postData() ? request.postDataJSON() as Record<string, unknown> : undefined;
    state.requests.push({ method, path, agentId, body });

    if (path.endsWith("/content") && method === "GET") {
      return route.fulfill({ status: 200, contentType: "image/png", body: uploadFixture });
    }
    const versionList = path.match(/^\/api\/emojis\/([^/]+)\/versions$/u);
    if (versionList && method === "GET") {
      const key = decodeURIComponent(versionList[1] ?? "");
      return fulfillJson(route, versionPayload(state, agentId, key));
    }
    const versionRemove = path.match(/^\/api\/emojis\/([^/]+)\/versions\/([^/]+)$/u);
    if (versionRemove && method === "DELETE") {
      const key = decodeURIComponent(versionRemove[1] ?? "");
      const fileName = decodeURIComponent(versionRemove[2] ?? "");
      state.versionsByAgent[agentId]![key] = versions(state, agentId, key)
        .filter((version) => version.current || version.fileName !== fileName);
      return route.fulfill({ status: 204 });
    }
    if (path === "/api/emojis" && method === "GET") {
      return fulfillJson(route, payload(state, agentId));
    }
    if (path === "/api/emojis/settings" && method === "PATCH") {
      const sendSize = body?.sendSize;
      const sendSeparately = body?.sendSeparately;
      if (sendSize !== 64 && sendSize !== 128 && sendSize !== 256 && sendSize !== 512 && sendSize !== 1024) {
        return fulfillJson(route, { error: { code: "EMOJI_SETTINGS_INVALID", message: "表情发送尺寸无效。" } }, 400);
      }
      if (typeof sendSeparately !== "boolean") {
        return fulfillJson(route, { error: { code: "EMOJI_SETTINGS_INVALID", message: "表情发送方式无效。" } }, 400);
      }
      state.sendSizeByAgent[agentId] = sendSize;
      state.sendSeparatelyByAgent[agentId] = sendSeparately;
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
    const rename = path.match(/^\/api\/emojis\/([^/]+)$/u);
    if (rename && method === "PATCH") {
      const key = decodeURIComponent(rename[1] ?? "");
      const nextKey = requireKey(body);
      state.recordsByAgent[agentId] = records(state, agentId).map((record) => (
        record.key === key ? { ...record, key: nextKey } : record
      ));
      state.versionsByAgent[agentId]![nextKey] = versions(state, agentId, key).map((version) => ({
        ...version,
        key: nextKey
      }));
      delete state.versionsByAgent[agentId]![key];
      return fulfillJson(route, payload(state, agentId));
    }
    const remove = path.match(/^\/api\/emojis\/([^/]+)$/u);
    if (remove && method === "DELETE") {
      const key = decodeURIComponent(remove[1] ?? "");
      state.recordsByAgent[agentId] = records(state, agentId).filter((record) => record.key !== key);
      delete state.versionsByAgent[agentId]?.[key];
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
    emojis: records(state, agentId),
    sendSize: state.sendSizeByAgent[agentId] ?? 512,
    sendSeparately: state.sendSeparatelyByAgent[agentId] ?? false,
    revision: `${agentId}-revision`
  };
}

function records(state: EmojiManagementMock, agentId: string) {
  return state.recordsByAgent[agentId] ??= [];
}

function versions(state: EmojiManagementMock, agentId: string, key: string) {
  state.versionsByAgent[agentId] ??= {};
  return state.versionsByAgent[agentId]![key] ??= [];
}

function upsert(state: EmojiManagementMock, agentId: string, next: EmojiRecord) {
  const history = versions(state, agentId, next.key).map((version) => ({ ...version, current: false }));
  const matching = history.find((version) => version.fileName === next.fileName);
  state.versionsByAgent[agentId]![next.key] = [
    { ...(matching ?? next), ...next, current: true },
    ...history.filter((version) => version.fileName !== next.fileName)
  ];
  state.recordsByAgent[agentId] = [...records(state, agentId).filter((record) => record.key !== next.key), next];
}

function versionPayload(state: EmojiManagementMock, agentId: string, key: string) {
  return {
    key,
    versions: versions(state, agentId, key).map((version) => {
      const contentPath = `/api/emojis/${encodeURIComponent(key)}/versions/${encodeURIComponent(version.fileName)}/content?agentId=${encodeURIComponent(agentId)}`;
      return {
        ...version,
        originalUrl: `${contentPath}&variant=original`,
        displayUrl: `${contentPath}&variant=display`,
        placeholderUrl: `${contentPath}&variant=placeholder`
      };
    })
  };
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
