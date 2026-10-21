import { Option } from "effect";
import { describe, expect, it } from "vitest";
import type { BattleEvent } from "../src/core/events";
import type { Move } from "../src/core/move";
import type { Side } from "../src/core/side";
import { gameData, runRound } from "./helpers";

const repeat = (move: Move, n: number): Move[] => Array.from({ length: n }, () => move);

const turnOf = (events: readonly BattleEvent[], index: number): number => {
  const e = events[index];
  return e === undefined ? -1 : e.view.turn;
};

const revealsOf = (events: readonly BattleEvent[]) => events.flatMap((e) => (e._tag === "MovesRevealed" ? [e] : []));

const indexOfTag = (events: readonly BattleEvent[], tag: BattleEvent["_tag"]): number =>
  events.findIndex((e) => e._tag === tag);

describe("Haskell「純粋関数」", () => {
  // 両者が同じ手を出し続けるので毎ターンあいこ。Python の条件（相手手札 6 枚以下）は 7 ターン目に初めて成立。
  const draws = [...repeat("Slash", 3), ...repeat("Guard", 4), ...repeat("Step", 4)];
  const rec = runRound({ player: "python", cpu: "haskell", playerMoves: draws, cpuMoves: draws });

  it("条件成立ターンに無効化し、無効化された側は次ターンに再挑戦して発動する", () => {
    const negated = rec.events.filter((e) => e._tag === "SkillNegated");
    const activated = rec.events.filter((e) => e._tag === "SkillActivated");
    expect(negated).toHaveLength(1);
    expect(activated).toHaveLength(1);
    expect(turnOf(rec.events, indexOfTag(rec.events, "SkillNegated"))).toBe(7);
    expect(turnOf(rec.events, indexOfTag(rec.events, "SkillActivated"))).toBe(8);
    const n = negated[0];
    expect(n?._tag === "SkillNegated" && n.by === "Cpu" && n.target === "Player").toBe(true);
    // 無効化直後：Haskell は used、Python は未使用のまま
    expect(n?.view.opponent.skill.used).toBe(true);
    expect(n?.view.self.skill.used).toBe(false);
  });

  it("Python の発動前は相手の手札内訳が見えず、発動後は見える", () => {
    const revealed = rec.choices.map((c) => Option.isSome(c.opponent.revealedHand));
    expect(revealed.slice(0, 7).every((r) => !r)).toBe(true);
    expect(revealed.slice(7).every((r) => r)).toBe(true);
    // 手選択画面では相手の合計枚数だけは常に見える
    expect(rec.choices.map((c) => c.opponentHandTotal).slice(0, 3)).toEqual([12, 11, 10]);
  });

  it("両者同時に手札 0 → HP 割合で決着", () => {
    // 最終ターン: Python 斬 vs Haskell 受 → Haskell 反撃 10。Python 90/100 < Haskell 110/110
    expect(rec.result).toMatchObject({ _tag: "Victory", winner: "Cpu", reason: "HpRatioTiebreak" });
  });
});

describe("C++「Undefined Behavior」", () => {
  // 1〜3 ターン目: C++ 避 vs Python 斬 → 20×3 で C++ HP 20 (≤ 80×0.4)。4 ターン目初めに発動。
  const setup = repeat("Step", 3);

  it("勝てば与ダメージ 2 倍、効果はそのターン限り", () => {
    const rec = runRound({
      player: "cpp",
      cpu: "python",
      playerMoves: [...setup, "Slash", "Slash"],
      cpuMoves: [...repeat("Slash", 3), "Step", "Step"],
    });
    const reveals = revealsOf(rec.events);
    expect(reveals.slice(0, 5).map((e) => e.damage?.amount)).toEqual([20, 20, 20, 40, 20]);
    expect(reveals[3]?.damage).toEqual({ target: "Cpu", amount: 40 });
    expect(reveals[4]?.damage).toEqual({ target: "Cpu", amount: 20 });
    expect(turnOf(rec.events, indexOfTag(rec.events, "SkillActivated"))).toBe(4);
  });

  it("負ければ被ダメージ 2 倍", () => {
    const rec = runRound({
      player: "cpp",
      cpu: "python",
      playerMoves: [...setup, "Slash"],
      cpuMoves: [...repeat("Slash", 3), "Guard"],
    });
    // 受けるの反撃 10 × 2 = 20 で HP 20 → 0
    expect(rec.result).toMatchObject({ _tag: "Victory", winner: "Cpu", reason: "HpDepleted" });
  });

  it("あいこは効果なし", () => {
    const rec = runRound({
      player: "cpp",
      cpu: "python",
      playerMoves: [...setup, "Slash", "Slash"],
      cpuMoves: [...repeat("Slash", 3), "Slash", "Step"],
    });
    const reveals = revealsOf(rec.events);
    expect(reveals[3]?.damage).toBeNull();
    expect(reveals[4]?.damage).toEqual({ target: "Cpu", amount: 20 });
  });
});

describe("JavaScript「Type Coercion」", () => {
  it("自分の手札が 4 枚以下になったターンの初めに発動し、合計枚数は変わらない", () => {
    // 8 ターンあいこ → JS の手札 4 枚で 9 ターン目初めに発動
    const draws = [...repeat("Slash", 4), ...repeat("Guard", 2), ...repeat("Step", 2)];
    const rec = runRound({ player: "javascript", cpu: "python", playerMoves: draws, cpuMoves: draws, seed: 7 });
    const e = rec.events.find((ev) => ev._tag === "SkillActivated" && ev.side === "Player");
    expect(e?.view.turn).toBe(9);
    const before = rec.choices[7]?.self.hand;
    const after = rec.choices[8]?.self.hand;
    const total = (h: typeof before) => (h === undefined ? -1 : h.Slash + h.Guard + h.Step);
    expect(total(before)).toBe(5);
    expect(total(after)).toBe(4);
  });
});

describe("全組み合わせ × 多数シードの性質", () => {
  const ids = gameData.roster.map((c) => c.id);

  it("必ず決着し、不変条件違反もスキル再発動も起こらない", () => {
    for (const player of ids) {
      for (const cpu of ids) {
        for (let seed = 1; seed <= 40; seed++) {
          const rec = runRound({ player, cpu, seed });
          expect(["Victory", "Draw"]).toContain(rec.result._tag);

          const count = (side: Side) =>
            rec.events.filter(
              (e) => (e._tag === "SkillActivated" && e.side === side) || (e._tag === "SkillNegated" && e.by === side),
            ).length;
          expect(count("Player")).toBeLessThanOrEqual(1);
          expect(count("Cpu")).toBeLessThanOrEqual(1);

          // 相手の手札内訳は自分が Python のスキルを発動するまで見えない
          const firstReveal = rec.choices.findIndex((c) => Option.isSome(c.opponent.revealedHand));
          if (player !== "python") expect(firstReveal).toBe(-1);
          for (const e of rec.events) {
            if (Option.isSome(e.view.opponent.revealedHand)) expect(player).toBe("python");
          }
        }
      }
    }
  });

  it("同じシードなら同じ結果（再現性）", () => {
    const a = runRound({ player: "javascript", cpu: "cpp", seed: 42 });
    const b = runRound({ player: "javascript", cpu: "cpp", seed: 42 });
    expect(a.result).toEqual(b.result);
    expect(a.choices.map((c) => c.self.hand)).toEqual(b.choices.map((c) => c.self.hand));
  });
});
