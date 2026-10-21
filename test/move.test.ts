import { describe, expect, it } from "vitest";
import { judge, MOVES, type Outcome } from "../src/core/move";

describe("判定テーブル", () => {
  it("三すくみ：斬る > 避ける、受ける > 斬る、避ける > 受ける", () => {
    expect(judge("Slash", "Step")).toBe("Win");
    expect(judge("Guard", "Slash")).toBe("Win");
    expect(judge("Step", "Guard")).toBe("Win");
  });

  it("同じ手はあいこ、勝敗は反対称", () => {
    const flip: Record<Outcome, Outcome> = { Win: "Lose", Lose: "Win", Draw: "Draw" };
    for (const a of MOVES) {
      expect(judge(a, a)).toBe("Draw");
      for (const b of MOVES) expect(judge(b, a)).toBe(flip[judge(a, b)]);
    }
  });
});
