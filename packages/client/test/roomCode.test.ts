import { describe, expect, it } from "vitest";
import { normalizeRoomCode } from "../src/online/roomCode";

describe("ルームコードの入力の正規化", () => {
  it("小文字・全角（IME が ON のまま）を半角大文字に直す", () => {
    expect(normalizeRoomCode("abc234").code).toBe("ABC234");
    expect(normalizeRoomCode("ＡＢＣ２３４").code).toBe("ABC234");
    expect(normalizeRoomCode("ａｂｃ２３４").code).toBe("ABC234");
  });

  it("空白・ハイフン・余分な文字は捨て、6 文字までにする", () => {
    expect(normalizeRoomCode(" ab-c 2 34 ").code).toBe("ABC234");
    expect(normalizeRoomCode("ABC234XYZ").code).toBe("ABC234");
    expect(normalizeRoomCode("ルームコード：ABC234").code).toBe("ABC234");
  });

  it("紛らわしい文字（0 O 1 I）は使わず、入っていたことを知らせる", () => {
    expect(normalizeRoomCode("AB0C1D")).toEqual({ code: "ABCD", hadConfusable: true });
    expect(normalizeRoomCode("ABCDEF").hadConfusable).toBe(false);
  });
});
