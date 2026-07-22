import { describe, expect, it } from "vitest";
import { requestAgentId } from "../../apps/api/requestAgentId.js";

describe("requestAgentId", () => {
  it("requires an explicit valid Agent id", () => {
    expect(() => requestAgentId({})).toThrow(expect.objectContaining({ code: "AGENT_ID_REQUIRED" }));
    expect(() => requestAgentId({ agentId: "../plana" })).toThrow(expect.objectContaining({ code: "AGENT_ID_INVALID" }));
    expect(requestAgentId({ agentId: " arona_2 " })).toBe("arona_2");
  });

  it("accepts all only for aggregate endpoints", () => {
    expect(() => requestAgentId({ agentId: "all" })).toThrow(expect.objectContaining({ code: "AGENT_ID_INVALID" }));
    expect(requestAgentId({ agentId: "all" }, { allowAll: true })).toBe("all");
  });
});
