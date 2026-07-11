import { describe, expect, it } from "vitest";
import { isTrustedQqFakeIp, isTrustedQqMediaHostname } from "../../src/qqMedia.js";

describe("QQ media hosts", () => {
  it("recognizes official QQ image hosts and their subdomains", () => {
    expect(isTrustedQqMediaHostname("multimedia.nt.qq.com.cn")).toBe(true);
    expect(isTrustedQqMediaHostname("cdn.multimedia.nt.qq.com.cn")).toBe(true);
    expect(isTrustedQqMediaHostname("q1.qlogo.cn")).toBe(true);
    expect(isTrustedQqMediaHostname("example.com")).toBe(false);
  });

  it("only accepts Clash fake IP addresses for trusted QQ image hosts", () => {
    expect(isTrustedQqFakeIp("multimedia.nt.qq.com.cn", "198.18.0.226")).toBe(true);
    expect(isTrustedQqFakeIp("p.qlogo.cn", "198.19.255.1")).toBe(true);
    expect(isTrustedQqFakeIp("example.com", "198.18.0.226")).toBe(false);
    expect(isTrustedQqFakeIp("multimedia.nt.qq.com.cn", "127.0.0.1")).toBe(false);
  });
});
