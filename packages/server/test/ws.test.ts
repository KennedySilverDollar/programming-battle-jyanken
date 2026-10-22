import { describe, expect, it } from "vitest";
import { originAllowed } from "../src/ws";

describe("Origin の許可リスト", () => {
  const allowed = ["https://jyanken.pages.dev", "https://*.jyanken.pages.dev"];

  it("空なら制限しない", () => {
    expect(originAllowed([], undefined)).toBe(true);
    expect(originAllowed([], "https://evil.example")).toBe(true);
  });

  it("完全一致と、*. のサブドメイン（プレビュー環境）だけを許す", () => {
    expect(originAllowed(allowed, "https://jyanken.pages.dev")).toBe(true);
    expect(originAllowed(allowed, "https://abc123.jyanken.pages.dev")).toBe(true);
    expect(originAllowed(allowed, "https://evil.example")).toBe(false);
    expect(originAllowed(allowed, "https://eviljyanken.pages.dev")).toBe(false);
    expect(originAllowed(allowed, "http://abc.jyanken.pages.dev")).toBe(false);
    expect(originAllowed(allowed, undefined)).toBe(false);
  });
});
