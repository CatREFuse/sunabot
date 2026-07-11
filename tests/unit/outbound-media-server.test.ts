// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OutboundMediaDelivery } from "../../src/outboundMedia.js";
import { buildApp } from "../../src/server.js";
import { createAdminTestConfig } from "./admin-fixtures.js";

describe("outbound media HTTP delivery", () => {
  let temporaryDirectory = "";
  let imageDirectory = "";
  let imagePath = "";
  let delivery: OutboundMediaDelivery;

  beforeEach(async () => {
    temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-outbound-route-"));
    imageDirectory = path.join(temporaryDirectory, "images");
    imagePath = path.join(imageDirectory, "large-generated-image.png");
    await fs.mkdir(imageDirectory, { recursive: true });
    await fs.writeFile(imagePath, Buffer.alloc(2 * 1024 * 1024, 19));
    delivery = new OutboundMediaDelivery({
      rootDir: imageDirectory,
      secret: Buffer.alloc(32, 9),
      ttlSeconds: 300,
      nowSeconds: () => 1_788_000_000
    });
  });

  afterEach(async () => {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("streams signed GET and HEAD requests without an admin token", async () => {
    const built = await buildApp({
      config: createAdminTestConfig(temporaryDirectory),
      initializeRuntime: false,
      outboundMedia: delivery
    });
    const signedPath = await delivery.createSignedPath(imagePath);

    const getResponse = await built.app.inject({
      method: "GET",
      url: signedPath,
      headers: { host: "host.docker.internal:8787" },
      remoteAddress: "192.168.5.3"
    });
    const headResponse = await built.app.inject({
      method: "HEAD",
      url: signedPath,
      headers: { host: "host.docker.internal:8787" },
      remoteAddress: "192.168.5.3"
    });

    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.headers["content-type"]).toBe("image/png");
    expect(getResponse.headers["content-length"]).toBe(String(2 * 1024 * 1024));
    expect(getResponse.rawPayload).toHaveLength(2 * 1024 * 1024);
    expect(headResponse.statusCode).toBe(200);
    expect(headResponse.headers["content-type"]).toBe("image/png");
    expect(headResponse.headers["content-length"]).toBe(String(2 * 1024 * 1024));
    expect(headResponse.rawPayload).toHaveLength(0);
    await built.app.close();
  });

  it("returns the same 404 for invalid signed media requests and keeps generated images protected", async () => {
    const built = await buildApp({
      config: createAdminTestConfig(temporaryDirectory),
      initializeRuntime: false,
      outboundMedia: delivery
    });
    const signedPath = await delivery.createSignedPath(imagePath);
    const tamperedPath = signedPath.replace("signature=", "signature=0");
    const headers = { host: "host.docker.internal:8787" };

    const invalid = await built.app.inject({
      method: "GET",
      url: tamperedPath,
      headers,
      remoteAddress: "192.168.5.3"
    });
    const missing = await built.app.inject({
      method: "GET",
      url: "/outbound-media/generated-images/missing.png?expires=1&signature=0",
      headers,
      remoteAddress: "192.168.5.3"
    });
    const protectedImage = await built.app.inject({
      method: "GET",
      url: "/generated-images/large-generated-image.png",
      headers,
      remoteAddress: "192.168.5.3"
    });

    expect(invalid.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(invalid.json()).toEqual(missing.json());
    expect(protectedImage.statusCode).toBe(401);
    expect(protectedImage.json().error.code).toBe("ADMIN_UNAUTHORIZED");
    await built.app.close();
  });
});
