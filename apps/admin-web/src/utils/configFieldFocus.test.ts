import { describe, expect, it, vi } from "vitest";
import { focusConfigField } from "./configFieldFocus";

describe("focusConfigField", () => {
  it("focuses an exact config path or its mapped field label", () => {
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    const root = document.createElement("section");
    root.innerHTML = `
      <label><span class="field-label">管理员 QQ</span><input id="admin"></label>
      <label><span class="field-label">过滤名单</span><input id="quote-filter"></label>
      <label data-config-field="server.port"><input id="port"></label>
    `;
    document.body.append(root);

    expect(focusConfigField(root, "bot.adminQq")).toBe(true);
    expect(document.activeElement?.id).toBe("admin");
    expect(focusConfigField(root, "server.port")).toBe(true);
    expect(document.activeElement?.id).toBe("port");
    expect(focusConfigField(root, "bot.quoteGroupReplyExcludedUserIds.1")).toBe(true);
    expect(document.activeElement?.id).toBe("quote-filter");
    expect(scrollIntoView).toHaveBeenCalledTimes(3);
  });
});
