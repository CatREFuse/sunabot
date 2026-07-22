// @vitest-environment node
import type http from "node:http";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDockerEngineClient
} from "../../adapters/docker/dockerEngineClient.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("Docker Engine Unix socket client", () => {
  it("settles at the hard deadline when the socket accepts but never responds", async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const request = {
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        listeners.set(event, listener);
        return request;
      }),
      end: vi.fn(),
      destroy: vi.fn()
    } as unknown as http.ClientRequest;
    const client = await createDockerEngineClient({
      socketPath: "/fixture/docker.sock",
      request: vi.fn(() => request) as unknown as typeof http.request
    });

    const startedAt = Date.now();
    await expect(client.request({
      method: "GET",
      path: "/_ping",
      timeoutMs: 25
    })).rejects.toMatchObject({ kind: "timeout" });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(request.destroy).toHaveBeenCalledOnce();
  });

  it("shares one deadline between API version negotiation and the target request", async () => {
    vi.useFakeTimers();
    const paths: string[] = [];
    const requestImpl = vi.fn((options: http.RequestOptions, callback: (response: http.IncomingMessage) => void) => {
      const request = new EventEmitter() as http.ClientRequest;
      request.destroy = vi.fn() as unknown as http.ClientRequest["destroy"];
      request.end = vi.fn(() => {
        paths.push(String(options.path));
        if (options.path === "/version") {
          setTimeout(() => {
            const response = incoming(200);
            callback(response);
            response.emit("data", Buffer.from(JSON.stringify({ ApiVersion: "1.47" })));
            response.emit("end");
          }, 40);
        }
      }) as unknown as http.ClientRequest["end"];
      return request;
    }) as unknown as typeof http.request;
    const client = await createDockerEngineClient({
      socketPath: "/fixture/docker.sock",
      request: requestImpl
    });

    const result = client.request({ method: "GET", path: "/containers/json", timeoutMs: 50 });
    const rejection = expect(result).rejects.toMatchObject({ kind: "timeout" });
    await vi.advanceTimersByTimeAsync(49);
    expect(paths).toEqual(["/version", "/v1.47/containers/json"]);
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
  });

  it("prefers the launcher-pinned socket over Docker host and context settings", async () => {
    let observedSocket = "";
    const requestImpl = vi.fn((options: http.RequestOptions, callback: (response: http.IncomingMessage) => void) => {
      observedSocket = String(options.socketPath);
      const request = new EventEmitter() as http.ClientRequest;
      request.destroy = vi.fn() as unknown as http.ClientRequest["destroy"];
      request.end = vi.fn(() => {
        const response = incoming(200);
        callback(response);
        response.emit("data", Buffer.from("OK"));
        response.emit("end");
      }) as unknown as http.ClientRequest["end"];
      return request;
    }) as unknown as typeof http.request;
    const client = await createDockerEngineClient({
      environment: {
        SUNABOT_DOCKER_SOCKET: "/pinned/docker.sock",
        DOCKER_HOST: "unix:///other/docker.sock",
        DOCKER_CONTEXT: "other"
      },
      request: requestImpl
    });

    await expect(client.request({ method: "GET", path: "/_ping", timeoutMs: 50 }))
      .resolves.toMatchObject({ statusCode: 200 });
    expect(observedSocket).toBe("/pinned/docker.sock");
  });

  it("uses an explicit Docker context before Docker host when no launcher socket is pinned", async () => {
    const temporaryHome = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-docker-context-"));
    const context = "production";
    const contextHash = createHash("sha256").update(context).digest("hex");
    const metadataDirectory = path.join(temporaryHome, ".docker", "contexts", "meta", contextHash);
    await fs.mkdir(metadataDirectory, { recursive: true });
    await fs.writeFile(path.join(metadataDirectory, "meta.json"), JSON.stringify({
      Endpoints: { docker: { Host: "unix:///context/docker.sock" } }
    }));
    let observedSocket = "";
    const requestImpl = vi.fn((options: http.RequestOptions, callback: (response: http.IncomingMessage) => void) => {
      observedSocket = String(options.socketPath);
      const request = new EventEmitter() as http.ClientRequest;
      request.destroy = vi.fn() as unknown as http.ClientRequest["destroy"];
      request.end = vi.fn(() => {
        const response = incoming(200);
        callback(response);
        response.emit("data", Buffer.from("OK"));
        response.emit("end");
      }) as unknown as http.ClientRequest["end"];
      return request;
    }) as unknown as typeof http.request;
    try {
      const client = await createDockerEngineClient({
        environment: {
          HOME: temporaryHome,
          DOCKER_CONTEXT: context,
          DOCKER_HOST: "unix:///wrong/docker.sock"
        },
        request: requestImpl
      });
      await client.request({ method: "GET", path: "/_ping", timeoutMs: 50 });
      expect(observedSocket).toBe("/context/docker.sock");
    } finally {
      await fs.rm(temporaryHome, { recursive: true, force: true });
    }
  });
});

function incoming(statusCode: number) {
  const response = new EventEmitter() as http.IncomingMessage;
  response.statusCode = statusCode;
  response.headers = {};
  response.destroy = vi.fn() as unknown as http.IncomingMessage["destroy"];
  return response;
}
