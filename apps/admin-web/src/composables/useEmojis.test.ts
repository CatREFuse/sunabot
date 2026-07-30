import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmojiPayload, EmojiRecord, EmojiVersionRecord } from "../types/emojis";
import { useEmojis } from "./useEmojis";

const apiRequest = vi.hoisted(() => vi.fn());
vi.mock("./useAdminApi", () => ({ apiRequest }));

const happy: EmojiRecord = {
  key: "开心",
  source: "generated",
  fileName: "emoji-happy.png",
  sizeBytes: 240_000,
  width: 1024,
  height: 1024,
  updatedAt: "2026-07-18T10:00:00.000Z",
  originalUrl: "/api/emojis/%E5%BC%80%E5%BF%83/content?variant=original",
  displayUrl: "/api/emojis/%E5%BC%80%E5%BF%83/content?variant=display",
  placeholderUrl: "/api/emojis/%E5%BC%80%E5%BF%83/content?variant=placeholder"
};

const serious: EmojiRecord = {
  ...happy,
  key: "认真",
  fileName: "emoji-serious.png",
  originalUrl: "/api/emojis/%E8%AE%A4%E7%9C%9F/content?variant=original",
  displayUrl: "/api/emojis/%E8%AE%A4%E7%9C%9F/content?variant=display",
  placeholderUrl: "/api/emojis/%E8%AE%A4%E7%9C%9F/content?variant=placeholder"
};

describe("useEmojis", () => {
  beforeEach(() => { apiRequest.mockReset(); });

  it("uses an explicit Agent id and ignores a late response after switching Agents", async () => {
    let resolveKoharu!: (payload: EmojiPayload) => void;
    const koharuResponse = new Promise<EmojiPayload>((resolve) => { resolveKoharu = resolve; });
    apiRequest.mockImplementation((path: string) => {
      if (path === "/api/emojis?agentId=koharu&workbench=all") return koharuResponse;
      if (path === "/api/emojis?agentId=plana&workbench=all") return Promise.resolve({ presetKeys: ["哭"], emojis: [] });
      throw new Error(`Unexpected request: ${path}`);
    });
    const data = useEmojis();

    const first = data.load("koharu");
    const firstSignal = apiRequest.mock.calls[0]?.[1]?.signal as AbortSignal;
    const second = data.load("plana");
    await second;
    resolveKoharu({ presetKeys: ["开心"], emojis: [happy] });
    await first;

    expect(firstSignal.aborted).toBe(true);
    expect(data.presetKeys.value).toEqual(["哭"]);
    expect(data.emojis.value).toEqual([]);
  });

  it("uploads, generates, and deletes within the requested Agent", async () => {
    const uploadRecord: EmojiRecord = { ...happy, source: "upload", fileName: "happy-upload.png" };
    const canonicalPayloads: EmojiPayload[] = [
      { presetKeys: ["开心"], emojis: [] },
      { presetKeys: ["开心"], emojis: [uploadRecord] },
      { presetKeys: ["开心"], emojis: [happy] },
      { presetKeys: ["开心"], emojis: [] }
    ];
    apiRequest.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/api/emojis?agentId=koharu&workbench=all" && !init?.method) {
        return Promise.resolve(canonicalPayloads.shift());
      }
      if (path === "/api/emojis?agentId=koharu&workbench=native" && init?.method === "POST") {
        return Promise.resolve({ presetKeys: ["开心"], emojis: [] });
      }
      if (path === "/api/emojis/generate?agentId=koharu&workbench=native" && init?.method === "POST") {
        return Promise.resolve({ presetKeys: ["开心"], emojis: [uploadRecord] });
      }
      if (path === `/api/emojis/${encodeURIComponent("开心")}?agentId=koharu&workbench=native` && init?.method === "DELETE") {
        return Promise.resolve(undefined);
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const data = useEmojis();

    await data.load("koharu");
    const uploaded = await data.upload("koharu", {
      key: "开心",
      file: new File(["png"], "happy.png", { type: "image/png" })
    });
    expect(uploaded).toBe(true);
    const uploadCall = apiRequest.mock.calls.find(([path, init]) => (
      path === "/api/emojis?agentId=koharu&workbench=native" && init?.method === "POST"
    ));
    expect(JSON.parse(String(uploadCall?.[1]?.body))).toEqual({
      key: "开心",
      fileName: "happy.png",
      dataBase64: "cG5n"
    });
    expect(data.emojis.value).toEqual([uploadRecord]);

    expect(await data.generate("koharu", "开心")).toBe(true);
    const generateCall = apiRequest.mock.calls.find(([path, init]) => (
      path === "/api/emojis/generate?agentId=koharu&workbench=native" && init?.method === "POST"
    ));
    expect(JSON.parse(String(generateCall?.[1]?.body))).toEqual({ key: "开心" });
    expect(data.emojis.value).toEqual([happy]);

    expect(await data.remove("koharu", "开心")).toBe(true);
    expect(data.emojis.value).toEqual([]);
    expect(data.status.value).toEqual({ kind: "success", message: "“开心”已删除" });
  });

  it("loads both Workbench sources and keeps Docker operations source-bound", async () => {
    const dockerEmoji: EmojiRecord = {
      ...serious,
      key: "门缝小春",
      workbench: "docker"
    };
    let listed = false;
    apiRequest.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/api/emojis?agentId=koharu&workbench=all" && !init?.method) {
        if (!listed) {
          listed = true;
          return Promise.resolve({ presetKeys: ["开心"], emojis: [happy, dockerEmoji] });
        }
        return Promise.resolve({ presetKeys: ["开心"], emojis: [happy] });
      }
      if (
        path === `/api/emojis/${encodeURIComponent("门缝小春")}?agentId=koharu&workbench=docker`
        && init?.method === "DELETE"
      ) return Promise.resolve(undefined);
      throw new Error(`Unexpected request: ${path}`);
    });
    const data = useEmojis();

    await expect(data.load("koharu")).resolves.toBe(true);
    expect(data.emojis.value).toEqual([happy, dockerEmoji]);
    await expect(data.remove("koharu", "门缝小春", "docker")).resolves.toBe(true);
    expect(data.emojis.value).toEqual([happy]);
  });

  it("saves the selected sending size with the loaded revision", async () => {
    apiRequest.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/api/emojis?agentId=arona&workbench=all" && !init?.method) {
        return Promise.resolve({
          presetKeys: ["开心"], emojis: [], sendSize: 512, sendSeparately: false, revision: "arona-r1"
        });
      }
      if (path === "/api/emojis/settings?agentId=arona" && init?.method === "PATCH") {
        return Promise.resolve({
          presetKeys: ["开心"], emojis: [], sendSize: 128, sendSeparately: false, revision: "arona-r2"
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const data = useEmojis();

    await data.load("arona");
    expect(data.sendSize.value).toBe(512);
    expect(await data.setSendSize("arona", 128)).toBe(true);

    const request = apiRequest.mock.calls.find(([path]) => path === "/api/emojis/settings?agentId=arona");
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({
      sendSize: 128,
      sendSeparately: false,
      revision: "arona-r1"
    });
    expect(data.sendSize.value).toBe(128);
    expect(data.status.value).toEqual({ kind: "success", message: "发送尺寸已设为 128px" });
  });

  it("saves whether emojis use a separate message", async () => {
    apiRequest.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/api/emojis?agentId=arona&workbench=all" && !init?.method) {
        return Promise.resolve({
          presetKeys: ["开心"], emojis: [], sendSize: 512, sendSeparately: false, revision: "arona-r1"
        });
      }
      if (path === "/api/emojis/settings?agentId=arona" && init?.method === "PATCH") {
        return Promise.resolve({
          presetKeys: ["开心"], emojis: [], sendSize: 512, sendSeparately: true, revision: "arona-r2"
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const data = useEmojis();

    await data.load("arona");
    expect(await data.setSendSeparately("arona", true)).toBe(true);

    const request = apiRequest.mock.calls.find(([path]) => path === "/api/emojis/settings?agentId=arona");
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({
      sendSize: 512,
      sendSeparately: true,
      revision: "arona-r1"
    });
    expect(data.sendSeparately.value).toBe(true);
    expect(data.status.value).toEqual({ kind: "success", message: "表情将单独发送" });
  });

  it("renames a key and manages old versions within the active Agent", async () => {
    const oldVersion: EmojiVersionRecord = {
      ...happy,
      fileName: "emoji-old.png",
      current: false
    };
    const currentVersion: EmojiVersionRecord = { ...happy, current: true };
    const renamed: EmojiRecord = { ...happy, key: "大笑" };
    let listCount = 0;
    let versionCount = 0;
    apiRequest.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/api/emojis?agentId=arona&workbench=all" && !init?.method) {
        listCount += 1;
        return Promise.resolve({ presetKeys: ["开心"], emojis: listCount === 1 ? [happy] : [renamed] });
      }
      if (path === `/api/emojis/${encodeURIComponent("开心")}/versions?agentId=arona&workbench=native`) {
        return Promise.resolve({ key: "开心", versions: [currentVersion, oldVersion] });
      }
      if (path === `/api/emojis/${encodeURIComponent("开心")}?agentId=arona&workbench=native` && init?.method === "PATCH") {
        return Promise.resolve({ presetKeys: ["开心"], emojis: [renamed] });
      }
      if (path === `/api/emojis/${encodeURIComponent("大笑")}/versions?agentId=arona&workbench=native`) {
        versionCount += 1;
        return Promise.resolve({
          key: "大笑",
          versions: versionCount === 1
            ? [{ ...currentVersion, key: "大笑" }, { ...oldVersion, key: "大笑" }]
            : [{ ...currentVersion, key: "大笑" }]
        });
      }
      if (
        path === `/api/emojis/${encodeURIComponent("大笑")}/versions/${encodeURIComponent(oldVersion.fileName)}?agentId=arona&workbench=native`
        && init?.method === "DELETE"
      ) return Promise.resolve(undefined);
      throw new Error(`Unexpected request: ${path}`);
    });
    const data = useEmojis();

    await data.load("arona");
    expect(await data.loadVersions("arona", "开心")).toBe(true);
    expect(data.versions.value).toHaveLength(2);
    expect(await data.rename("arona", "开心", "大笑")).toBe(true);
    expect(JSON.parse(String(apiRequest.mock.calls.find(([path]) => path.includes("%E5%BC%80%E5%BF%83?"))?.[1]?.body)))
      .toEqual({ key: "大笑" });
    expect(data.versionKey.value).toBe("大笑");
    expect(await data.removeVersion("arona", "大笑", oldVersion.fileName)).toBe(true);
    expect(data.versions.value).toEqual([expect.objectContaining({ key: "大笑", current: true })]);
  });

  it("commits only the latest canonical GET when generate refreshes resolve in reverse order", async () => {
    const firstMutation = deferred<EmojiPayload>();
    const secondMutation = deferred<EmojiPayload>();
    const firstRefresh = deferred<EmojiPayload>();
    const secondRefresh = deferred<EmojiPayload>();
    let getCount = 0;
    apiRequest.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/api/emojis?agentId=koharu&workbench=all" && !init?.method) {
        getCount += 1;
        if (getCount === 1) return Promise.resolve({ presetKeys: ["开心", "认真"], emojis: [] });
        if (getCount === 2) return firstRefresh.promise;
        if (getCount === 3) return secondRefresh.promise;
      }
      if (path === "/api/emojis/generate?agentId=koharu&workbench=native" && init?.method === "POST") {
        const key = JSON.parse(String(init.body)).key;
        if (key === "开心") return firstMutation.promise;
        if (key === "认真") return secondMutation.promise;
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const data = useEmojis();
    await data.load("koharu");

    const first = data.generate("koharu", "开心");
    const second = data.generate("koharu", "认真");
    firstMutation.resolve({ presetKeys: ["开心", "认真"], emojis: [happy] });
    await vi.waitFor(() => expect(getCount).toBe(2));
    expect(data.emojis.value).toEqual([]);
    secondMutation.resolve({ presetKeys: ["开心", "认真"], emojis: [serious] });
    await vi.waitFor(() => expect(getCount).toBe(3));
    expect(data.emojis.value).toEqual([]);

    secondRefresh.resolve({ presetKeys: ["开心", "认真"], emojis: [happy, serious] });
    await vi.waitFor(() => expect(data.emojis.value).toEqual([happy, serious]));
    firstRefresh.resolve({ presetKeys: ["开心", "认真"], emojis: [happy] });
    await Promise.all([first, second]);

    expect(data.emojis.value).toEqual([happy, serious]);
  });

  it("keeps a deleted emoji absent when an older generate response and refresh arrive late", async () => {
    const generateMutation = deferred<EmojiPayload>();
    const deleteMutation = deferred<void>();
    const deleteRefresh = deferred<EmojiPayload>();
    const generateRefresh = deferred<EmojiPayload>();
    let getCount = 0;
    apiRequest.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/api/emojis?agentId=koharu&workbench=all" && !init?.method) {
        getCount += 1;
        if (getCount === 1) return Promise.resolve({ presetKeys: ["开心", "认真"], emojis: [happy] });
        if (getCount === 2) return deleteRefresh.promise;
        if (getCount === 3) return generateRefresh.promise;
      }
      if (path === "/api/emojis/generate?agentId=koharu&workbench=native" && init?.method === "POST") {
        return generateMutation.promise;
      }
      if (path === `/api/emojis/${encodeURIComponent("开心")}?agentId=koharu&workbench=native` && init?.method === "DELETE") {
        return deleteMutation.promise;
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const data = useEmojis();
    await data.load("koharu");

    const generated = data.generate("koharu", "认真");
    const deleted = data.remove("koharu", "开心");
    deleteMutation.resolve(undefined);
    await vi.waitFor(() => expect(getCount).toBe(2));
    expect(data.emojis.value).toEqual([happy]);
    generateMutation.resolve({ presetKeys: ["开心", "认真"], emojis: [happy, serious] });
    await vi.waitFor(() => expect(getCount).toBe(3));

    generateRefresh.resolve({ presetKeys: ["开心", "认真"], emojis: [serious] });
    await vi.waitFor(() => expect(data.emojis.value).toEqual([serious]));
    deleteRefresh.resolve({ presetKeys: ["开心", "认真"], emojis: [] });
    await Promise.all([generated, deleted]);

    expect(data.emojis.value).toEqual([serious]);
  });

  it("rejects an invalid key before sending a request", async () => {
    const data = useEmojis();
    const saved = await data.upload("koharu", {
      key: "坏/名称",
      file: new File(["text"], "emoji.txt", { type: "text/plain" })
    });

    expect(saved).toBe(false);
    expect(data.status.value).toEqual({ kind: "error", message: "表情名称不能包含括号、斜杠或控制字符" });
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it("rejects an unsupported image before sending a request", async () => {
    const data = useEmojis();
    const saved = await data.upload("koharu", {
      key: "开心",
      file: new File(["text"], "emoji.txt", { type: "text/plain" })
    });

    expect(saved).toBe(false);
    expect(data.status.value).toEqual({ kind: "error", message: "仅支持 PNG、JPEG、WebP、GIF" });
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it("accepts a GIF upload", async () => {
    apiRequest.mockResolvedValue({ presetKeys: ["挥手"], emojis: [] });
    const data = useEmojis();
    const saved = await data.upload("koharu", {
      key: "挥手",
      file: new File(["gif"], "wave.gif", { type: "image/gif" })
    });

    expect(saved).toBe(true);
    const uploadCall = apiRequest.mock.calls.find(([path, init]) => (
      path === "/api/emojis?agentId=koharu&workbench=native" && init?.method === "POST"
    ));
    expect(JSON.parse(String(uploadCall?.[1]?.body))).toMatchObject({
      key: "挥手",
      fileName: "wave.gif"
    });
  });

  it("rejects invalid Unicode before upload, generation, or URL encoding", async () => {
    const data = useEmojis();
    const file = new File(["png"], "emoji.png", { type: "image/png" });

    expect(await data.upload("koharu", { key: "\ud800", file })).toBe(false);
    expect(await data.generate("koharu", "\ud800")).toBe(false);
    expect(await data.remove("koharu", "\ud800")).toBe(false);
    expect(data.status.value).toEqual({ kind: "error", message: "表情名称包含无效字符" });
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it("rejects raw control characters before normalization or any request", async () => {
    const data = useEmojis();
    const file = new File(["png"], "emoji.png", { type: "image/png" });

    expect(await data.upload("koharu", { key: "\t开心", file })).toBe(false);
    expect(await data.generate("koharu", "开心\n")).toBe(false);
    expect(await data.remove("koharu", "\r开心")).toBe(false);
    expect(data.status.value).toEqual({ kind: "error", message: "表情名称不能包含括号、斜杠或控制字符" });
    expect(apiRequest).not.toHaveBeenCalled();
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
