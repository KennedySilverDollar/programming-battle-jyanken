import { describe, expect, it } from "vitest";
import { counterOf, judge, MOVES, type Outcome } from "../src/core/move";

describe("判定テーブル", () => {
  it("三すくみ：斬撃 > 刺突 > 打撃 > 斬撃", () => {
    expect(judge("Slash", "Thrust")).toBe("Win");
    expect(judge("Thrust", "Bash")).toBe("Win");
    expect(judge("Bash", "Slash")).toBe("Win");
  });

  it("同じ手はあいこ、勝敗は反対称", () => {
    const flip: Record<Outcome, Outcome> = { Win: "Lose", Lose: "Win", Draw: "Draw" };
    for (const a of MOVES) {
      expect(judge(a, a)).toBe("Draw");
      for (const b of MOVES) expect(judge(b, a)).toBe(flip[judge(a, b)]);
    }
  });

  it("counterOf はその手に勝つ手", () => {
    for (const m of MOVES) expect(judge(counterOf(m), m)).toBe("Win");
  });
});
