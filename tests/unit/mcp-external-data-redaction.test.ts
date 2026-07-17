// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { McpExternalDataSanitizer } from "../../adapters/mcp/externalDataRedaction.js";

describe("MCP external data sanitizer", () => {
  it("redacts exact server secrets and host paths while preserving the virtual workbench", () => {
    const sanitizer = new McpExternalDataSanitizer(["server-secret"]);
    const result = sanitizer.sanitize({
      token: "Bearer server-secret",
      unix: "/Users/example/private.txt",
      windows: "C:\\Users\\example\\private.txt",
      unc: "\\\\server\\share\\private.txt",
      file: "file:///etc/passwd",
      linux: "/usr/local/bin/server /bin/sh /lib64/loader /sbin/init /run/secrets/token",
      macos: "/Applications/App.app /Library/Keychains /System/Library /Volumes/Data/secret",
      wsl: "/mnt/c/Users/example/secret.txt",
      arbitrary: "/srv/app/token /data/private /nix/store/hash-secret /snap/app /media/disk /boot/key /custom-root/秘密",
      encoded: "%2Fsrv%2Fapp%2Ftoken file:///%73rv/private /资料/密钥",
      virtual: "/workbench/report.txt /skills/test-skill/SKILL.md file:///workbench/report.txt file:///skills/test-skill/SKILL.md"
    }, "output");
    expect(result).toEqual({
      token: "[REDACTED]",
      unix: "[HOST_PATH]",
      windows: "[HOST_PATH]",
      unc: "[HOST_PATH]",
      file: "[HOST_PATH]",
      linux: "[HOST_PATH] [HOST_PATH] [HOST_PATH] [HOST_PATH] [HOST_PATH]",
      macos: "[HOST_PATH] [HOST_PATH] [HOST_PATH] [HOST_PATH]",
      wsl: "[HOST_PATH]",
      arbitrary: "[HOST_PATH] [HOST_PATH] [HOST_PATH] [HOST_PATH] [HOST_PATH] [HOST_PATH] [HOST_PATH]",
      encoded: "[HOST_PATH] [HOST_PATH] [HOST_PATH]",
      virtual: "/workbench/report.txt /skills/test-skill/SKILL.md file:///workbench/report.txt file:///skills/test-skill/SKILL.md"
    });
  });

  it("rejects catalog pages containing a secret or host path", () => {
    const sanitizer = new McpExternalDataSanitizer(["server-secret"]);
    expect(() => sanitizer.sanitize({ tools: [{ name: "server-secret" }] }, "catalog"))
      .toThrow("MCP_EXTERNAL_CATALOG_UNSAFE");
    expect(() => sanitizer.sanitize({ resources: [{ uri: "file:///etc/passwd" }] }, "catalog"))
      .toThrow("MCP_EXTERNAL_CATALOG_UNSAFE");
    for (const hostPath of [
      "/usr/local/bin/server", "/bin/sh", "/lib64/loader", "/sbin/init", "/run/secrets/token",
      "/Applications/App.app", "/Library/Keychains", "/System/Library", "/Volumes/Data/secret", "/mnt/c/secret"
      , "/srv/app/token", "/data/private", "/nix/store/hash-secret", "/custom-root/秘密",
      "%2Fsrv%2Fapp%2Ftoken", "file:///%73rv/private", "/资料/密钥"
    ]) {
      expect(() => sanitizer.sanitizeText(hostPath, "catalog")).toThrow("MCP_EXTERNAL_CATALOG_UNSAFE");
    }
  });

  it("redacts bounded common secret encodings and rejects them from catalog snapshots", () => {
    const secret = "server-secret-7f3c9";
    const bytes = Buffer.from(secret, "utf8");
    const variants = [
      secret,
      `Bearer ${secret}`,
      encodeURIComponent(secret),
      [...bytes].map((byte) => `%${byte.toString(16).padStart(2, "0").toUpperCase()}`).join(""),
      [...bytes].map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join(""),
      bytes.toString("base64"),
      bytes.toString("base64").replace(/=+$/u, ""),
      bytes.toString("base64url"),
      bytes.toString("hex"),
      bytes.toString("hex").toUpperCase()
    ];
    const sanitizer = new McpExternalDataSanitizer([secret]);
    for (const variant of variants) {
      expect(sanitizer.sanitizeText(`prefix ${variant} suffix`, "output")).not.toContain(variant);
      expect(() => sanitizer.sanitizeText(`prefix ${variant} suffix`, "catalog"))
        .toThrow("MCP_EXTERNAL_CATALOG_UNSAFE");
    }
  });

  it("bounds secret count and byte length before deriving redaction variants", () => {
    expect(() => new McpExternalDataSanitizer(Array.from({ length: 65 }, (_, index) => `secret-${index}`)))
      .toThrow("MCP_SECRET_VALUE_INVALID");
    expect(() => new McpExternalDataSanitizer(["s".repeat(16 * 1024 + 1)]))
      .toThrow("MCP_SECRET_VALUE_INVALID");
  });

  it("fails closed without invoking getters, toJSON hooks, cycles or hostile proxies", () => {
    const getter = vi.fn(() => "server-secret");
    const toJson = vi.fn(() => ({ secret: "server-secret" }));
    const value: Record<string, unknown> = { safe: true };
    Object.defineProperty(value, "secret", { enumerable: true, get: getter });
    Object.defineProperty(value, "toJSON", { value: toJson });
    const sanitizer = new McpExternalDataSanitizer(["server-secret"]);
    expect(() => sanitizer.sanitize(value, "output")).toThrow("MCP_EXTERNAL_DATA_INVALID");
    expect(getter).not.toHaveBeenCalled();
    expect(toJson).not.toHaveBeenCalled();

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => sanitizer.sanitize(cyclic, "output")).toThrow("MCP_EXTERNAL_DATA_INVALID");
    const hostile = new Proxy({}, { ownKeys: () => { throw new Error("server-secret"); } });
    expect(() => sanitizer.sanitize(hostile, "output")).toThrow("MCP_EXTERNAL_DATA_INVALID");
  });

  it("strips untrusted controls from output and rejects controls or malformed Unicode in catalogs", () => {
    const sanitizer = new McpExternalDataSanitizer([]);
    expect(sanitizer.sanitizeText("a\u0001b\r\n\tc\u0085d", "output")).toBe("ab\n\tcd");
    expect(() => sanitizer.sanitizeText("catalog\u001bescape", "catalog"))
      .toThrow("MCP_EXTERNAL_CATALOG_UNSAFE");
    expect(() => sanitizer.sanitizeText("bad\ud800value", "output"))
      .toThrow("MCP_EXTERNAL_DATA_INVALID");
  });

  it("fails closed when distinct external object keys sanitize to the same key", () => {
    const sanitizer = new McpExternalDataSanitizer(["server-secret"]);
    expect(() => sanitizer.sanitize({
      "server-secret": "first",
      "[REDACTED]": "second"
    }, "output")).toThrow("MCP_EXTERNAL_DATA_INVALID");
  });
});
