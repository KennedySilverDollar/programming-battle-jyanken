import { describe, expect, it } from "vitest";
import { counterOf, judge, MOVE_HAND, MOVES, type Outcome } from "../src/move";

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

  it("グー/チョキ/パーの表記は判定テーブルと同じ関係（グー > チョキ > パー > グー）", () => {
    const rps: Record<string, string> = { グー: "チョキ", チョキ: "パー", パー: "グー" };
    for (const a of MOVES) {
      for (const b of MOVES) {
        const beats = rps[MOVE_HAND[a].name] === MOVE_HAND[b].name;
        expect(judge(a, b) === "Win").toBe(beats);
      }
    }
  });
});
