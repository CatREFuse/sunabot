// @vitest-environment node
import { createServer, type Server } from "node:http";
import { readFile, readdir, rm, stat, writeFile, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import PptxGenJS from "pptxgenjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CacheStore } from "../../services/media/attachments/cache.js";
import { findLibreOffice } from "../../services/media/attachments/libreoffice.js";
import { AttachmentService } from "../../services/media/attachments/service.js";
import type { AttachmentSourcePort } from "../../packages/contracts/media/media.js";
import { FakeAttachmentSourcePort } from "../../packages/testkit/fakeMessagingPort.js";
import type { IncomingAttachment } from "../../services/media/attachments/types.js";

let temporaryDirectory = "";
const fixtureServers: Server[] = [];

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "sunabot-attachment-service-"));
});

afterEach(async () => {
  await Promise.all(fixtureServers.splice(0).map(closeServer));
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = "";
  }
});

describe("AttachmentService integration", () => {
  it("downloads a UTF-8 text file and exposes its body to model context", async () => {
    const body = Buffer.from("Release checklist\n- verify backup\n- notify the operations team\n", "utf8");
    const filePath = await writeFixture("release-checklist.txt", body);
    const url = await serveFixture(filePath, "text/plain; charset=utf-8");
    const { service } = createAttachmentService("text-cache");

    const [attachment] = await service.processIncoming([
      incomingAttachment({ id: "text-1", name: "release-checklist.txt", url })
    ], unusedGateway(), "operations team", "private:2002/1001");
    const context = await service.buildModelContext([attachment!], "operations team");

    expect(attachment).toMatchObject({
      status: "ready",
      format: "txt",
      mimeType: "text/plain",
      truncated: false
    });
    expect(context.text).toContain("release-checklist.txt");
    expect(context.text).toContain("notify the operations team");
    expect(context.localImagePaths).toEqual([]);
    expect((await service.cache.getEntry(attachment!.cacheKey!))?.activeReferences).toEqual([
      "private:2002/1001/text-1"
    ]);
  }, 30_000);

  it("extracts PDF text and renders a selected page for visual context", async () => {
    const filePath = await writeFixture(
      "quarterly-report.pdf",
      createTextPdf(["Quarterly revenue 42 million"])
    );
    const url = await serveFixture(filePath, "application/pdf");
    const { service, cacheRoot } = createAttachmentService("pdf-cache");

    const [attachment] = await service.processIncoming([
      incomingAttachment({ id: "pdf-1", name: "quarterly-report.pdf", url })
    ], unusedGateway(), "revenue");
    const context = await service.buildModelContext([attachment!], "revenue");

    expect(attachment).toMatchObject({
      status: "ready",
      format: "pdf",
      pageCount: 1
    });
    expect(context.text).toContain("Quarterly revenue 42 million");
    expect(context.localImagePaths).toHaveLength(1);
    expect(isPathInside(cacheRoot, context.localImagePaths[0]!)).toBe(true);
    expect((await stat(context.localImagePaths[0]!)).isFile()).toBe(true);
    const visualBytes = await readFile(context.localImagePaths[0]!);
    const isJpeg = visualBytes.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]));
    const isPng = visualBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(isJpeg || isPng).toBe(true);
    expect(path.extname(context.localImagePaths[0]!)).toBe(isPng ? ".png" : ".jpg");
    expect((await service.cache.getEntry(attachment!.cacheKey!))?.artifactsSizeBytes).toBe(
      await directorySize(path.join(cacheRoot, attachment!.cacheKey!, "artifacts"))
    );
    await service.cache.updateParseState(attachment!.cacheKey!, {
      parseStatus: "ready",
      artifactsSizeBytes: 0
    });
    await service.buildModelContext([attachment!], "revenue");
    expect((await service.cache.getEntry(attachment!.cacheKey!))?.artifactsSizeBytes).toBe(
      await directorySize(path.join(cacheRoot, attachment!.cacheKey!, "artifacts"))
    );
  }, 120_000);

  it("single-flights the same local PDF fixture delivered by URL and NapCat Base64", async () => {
    const pdf = createTextPdf(["Shared content-addressed fixture"]);
    const filePath = await writeFixture("shared-report.pdf", pdf);
    const url = await serveFixture(filePath, "application/pdf", 25);
    const gateway = base64Port(pdf);
    const { service } = createAttachmentService("single-flight-cache");
    const workerRun = vi.spyOn(service.worker, "run");

    const [[urlResult], [base64Result]] = await Promise.all([
      service.processIncoming([
        incomingAttachment({ id: "url-copy", name: "shared-report.pdf", url })
      ], gateway),
      service.processIncoming([
        incomingAttachment({ id: "base64-copy", name: "shared-report.pdf", fileId: "local-copy" })
      ], gateway)
    ]);

    expect(["ready", "partial"]).toContain(urlResult!.status);
    expect(base64Result!.status).toBe(urlResult!.status);
    expect(base64Result!.sha256).toBe(urlResult!.sha256);
    expect(base64Result!.cacheKey).toBe(urlResult!.cacheKey);
    expect(urlResult!.errorCode).not.toBe("visual_conversion_failed");
    expect(base64Result!.errorCode).not.toBe("visual_conversion_failed");
    expect(workerRun.mock.calls.filter(([task]) =>
      task.command.kind === "module" &&
      (task.command.payload as { kind?: string } | undefined)?.kind === "pdf_extract"
    )).toHaveLength(1);
  }, 120_000);

  it("reuses a parsed PDF manifest after creating a new service instance", async () => {
    const pdf = createTextPdf(["Restart-safe parsed content"]);
    const filePath = await writeFixture("restart-safe.pdf", pdf);
    const url = await serveFixture(filePath, "application/pdf");
    const first = createAttachmentService("restart-cache").service;
    const [firstResult] = await first.processIncoming([
      incomingAttachment({ id: "before-restart", name: "restart-safe.pdf", url })
    ], unusedGateway());

    const second = createAttachmentService("restart-cache").service;
    const workerRun = vi.spyOn(second.worker, "run");
    const [secondResult] = await second.processIncoming([
      incomingAttachment({ id: "after-restart", name: "restart-safe.pdf", url })
    ], unusedGateway());
    const context = await second.buildModelContext([secondResult!], "Restart-safe");

    expect(secondResult).toMatchObject({
      status: firstResult!.status,
      sha256: firstResult!.sha256,
      chunkIndexPath: firstResult!.chunkIndexPath
    });
    expect(context.text).toContain("Restart-safe parsed content");
    expect(workerRun.mock.calls.filter(([task]) =>
      task.command.kind === "module" &&
      (task.command.payload as { kind?: string } | undefined)?.kind === "pdf_extract"
    )).toHaveLength(0);
  }, 120_000);

  it("does not reuse extension-dependent text detection under a different file name", async () => {
    const filePath = await writeFixture("extension-sensitive", Buffer.from("plain text payload"));
    const url = await serveFixture(filePath, "application/octet-stream");

    const unsupportedFirst = createAttachmentService("extension-cache-a").service;
    const [wrongExtension] = await unsupportedFirst.processIncoming([
      incomingAttachment({ id: "wrong-first", name: "payload.bin", url })
    ], unusedGateway());
    const [correctedExtension] = await unsupportedFirst.processIncoming([
      incomingAttachment({ id: "correct-second", name: "payload.txt", url })
    ], unusedGateway());
    expect(wrongExtension!.status).toBe("unsupported");
    expect(correctedExtension!.status).toBe("ready");

    const supportedFirst = createAttachmentService("extension-cache-b").service;
    const [correctFirst] = await supportedFirst.processIncoming([
      incomingAttachment({ id: "correct-first", name: "payload.txt", url })
    ], unusedGateway());
    const [wrongSecond] = await supportedFirst.processIncoming([
      incomingAttachment({ id: "wrong-second", name: "payload.bin", url })
    ], unusedGateway());
    expect(correctFirst!.status).toBe("ready");
    expect(wrongSecond!.status).toBe("unsupported");
  }, 30_000);

  it("falls back to adapter-provided file content when a resolved download URL is unsafe", async () => {
    const body = Buffer.from("Fallback content from NapCat Base64", "utf8");
    const gateway = new FakeAttachmentSourcePort(undefined, {
      kind: "base64",
      base64: body.toString("base64"),
      via: "file_content"
    });
    const fetchMock = vi.fn(async () => {
      throw new Error("Unsafe URL must be rejected before fetch.");
    });
    const fetchImpl = fetchMock as unknown as typeof fetch;
    const cacheRoot = path.join(temporaryDirectory, "unsafe-url-fallback-cache");
    const cacheStore = new CacheStore(cacheRoot, {
      fetchImpl,
      lookupImpl: async () => [{ address: "127.0.0.1", family: 4 }],
      minimumFreeBytes: 0
    });
    const service = new AttachmentService(temporaryDirectory, { cacheRoot, cacheStore });

    const [attachment] = await service.processIncoming([incomingAttachment({
      id: "fallback-1",
      name: "fallback.txt",
      fileId: "fallback-file-id",
      url: "https://downloads.example.test/fallback.txt"
    })], gateway);
    const context = await service.buildModelContext([attachment!], "Fallback content");

    expect(attachment).toMatchObject({ status: "ready", format: "txt" });
    expect(context.text).toContain("Fallback content from NapCat Base64");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(gateway.fallbackCalls).toEqual([{ fileId: "fallback-file-id", file: "fallback.txt" }]);
  }, 30_000);

  it("reports cache_unavailable after a persisted text chunk index disappears", async () => {
    const text = Buffer.from("The recovery code is ORBIT-2048.", "utf8");
    const gateway = base64Port(text);
    const { service, cacheRoot } = createAttachmentService("missing-chunks-cache");
    const [attachment] = await service.processIncoming([
      incomingAttachment({ id: "missing-1", name: "recovery.txt", fileId: "recovery-file" })
    ], gateway);
    expect(attachment!.chunkIndexPath).toBeTruthy();
    await rm(path.join(cacheRoot, attachment!.chunkIndexPath!));

    const context = await service.buildModelContext([attachment!], "recovery code");

    expect(context.attachments[0]).toMatchObject({
      status: "failed",
      errorCode: "cache_unavailable",
      errorMessage: "文件缓存已不可用，请重新发送。"
    });
    expect(context.text).toContain("文件缓存已不可用，请重新发送。");
    expect(context.localImagePaths).toEqual([]);
  }, 30_000);

  it("reads PowerPoint slide text and produces visual page context", async ({ skip }) => {
    if (!await findLibreOffice()) skip();
    const pptxPath = path.join(temporaryDirectory, "roadmap.pptx");
    const presentation = new PptxGenJS();
    presentation.layout = "LAYOUT_WIDE";
    presentation.addSlide().addText("Launch readiness", {
      x: 0.8,
      y: 0.8,
      w: 7,
      h: 0.8,
      fontSize: 28
    });
    presentation.addSlide().addText("Migration window is Saturday", {
      x: 0.8,
      y: 0.8,
      w: 9,
      h: 0.8,
      fontSize: 24
    });
    await presentation.writeFile({ fileName: pptxPath });
    const pptx = await readFile(pptxPath);
    const gateway = base64Port(pptx);
    const { service } = createAttachmentService("pptx-cache");

    const [attachment] = await service.processIncoming([
      incomingAttachment({ id: "pptx-1", name: "roadmap.pptx", fileId: "roadmap-file" })
    ], gateway, "Saturday migration");
    const context = await service.buildModelContext([attachment!], "Saturday migration");

    expect(attachment).toMatchObject({
      status: "ready",
      format: "pptx",
      pageCount: 2
    });
    expect(attachment!.errorCode).not.toBe("visual_conversion_failed");
    expect(context.text).toContain("Migration window is Saturday");
    expect(context.localImagePaths).toHaveLength(2);
    await Promise.all(context.localImagePaths.map(async (imagePath) => {
      expect((await stat(imagePath)).isFile()).toBe(true);
    }));
  }, 180_000);
});

function createAttachmentService(cacheName: string) {
  const cacheRoot = path.join(temporaryDirectory, cacheName);
  const cacheStore = new CacheStore(cacheRoot, {
    allowPrivateNetwork: true,
    minimumFreeBytes: 0
  });
  return {
    cacheRoot,
    service: new AttachmentService(temporaryDirectory, { cacheRoot, cacheStore })
  };
}

function incomingAttachment(
  input: Pick<IncomingAttachment, "id" | "name"> & Partial<IncomingAttachment>
): IncomingAttachment {
  return {
    source: "message",
    ...input
  };
}

function unusedGateway(): AttachmentSourcePort {
  return new FakeAttachmentSourcePort(new Error("Direct attachment URLs must not call the messaging adapter."));
}

function base64Port(bytes: Buffer) {
  return new FakeAttachmentSourcePort({
    kind: "base64",
    base64: bytes.toString("base64"),
    via: "file_content"
  });
}

async function writeFixture(name: string, bytes: Buffer) {
  const filePath = path.join(temporaryDirectory, name);
  await writeFile(filePath, bytes, { mode: 0o600 });
  return filePath;
}

async function serveFixture(filePath: string, contentType: string, delayMs = 0) {
  const server = createServer(async (_request, response) => {
    try {
      const bytes = await readFile(filePath);
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      response.writeHead(200, {
        "content-length": bytes.length,
        "content-type": contentType
      });
      response.end(bytes);
    } catch {
      response.writeHead(500);
      response.end();
    }
  });
  fixtureServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server has no TCP address.");
  return `http://127.0.0.1:${address.port}/${encodeURIComponent(path.basename(filePath))}`;
}

async function closeServer(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function isPathInside(root: string, candidate: string) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function directorySize(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    total += entry.isDirectory() ? await directorySize(entryPath) : (await stat(entryPath)).size;
  }
  return total;
}

function createTextPdf(pageTexts: string[]) {
  const objects: Array<string | undefined> = [undefined];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  const pageObjectNumbers: number[] = [];
  const fontObjectNumber = 3 + pageTexts.length * 2;
  for (let index = 0; index < pageTexts.length; index += 1) {
    const pageObjectNumber = 3 + index * 2;
    const contentObjectNumber = pageObjectNumber + 1;
    pageObjectNumbers.push(pageObjectNumber);
    const content = `BT /F1 18 Tf 30 120 Td (${escapePdfString(pageTexts[index]!)}) Tj ET`;
    objects[pageObjectNumber] = [
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200]",
      `/Resources << /Font << /F1 ${fontObjectNumber} 0 R >> >>`,
      `/Contents ${contentObjectNumber} 0 R >>`
    ].join(" ");
    objects[contentObjectNumber] = `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`;
  }
  objects[2] = `<< /Type /Pages /Kids [${pageObjectNumbers.map((number) => `${number} 0 R`).join(" ")}] /Count ${pageTexts.length} >>`;
  objects[fontObjectNumber] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let number = 1; number < objects.length; number += 1) {
    offsets[number] = Buffer.byteLength(pdf);
    pdf += `${number} 0 obj\n${objects[number]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let number = 1; number < objects.length; number += 1) {
    pdf += `${String(offsets[number]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

function escapePdfString(value: string) {
  return value.replace(/([\\()])/g, "\\$1");
}
