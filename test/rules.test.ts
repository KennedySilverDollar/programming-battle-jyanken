import { Option } from "effect";
import { describe, expect, it } from "vitest";
import { damageFor, decideExchange } from "../src/core/battle";
import type { EffectiveMove } from "../src/core/events";
import type { Move } from "../src/core/move";
import { initialFighter } from "../src/core/state";
import { character, gameData } from "./helpers";

const { balance } = gameData;
const play = (effective: EffectiveMove, extra?: Move) => ({
  primary: { chosen: "Slash" as const satisfies Move, bare: false, effective },
  extra: extra === undefined ? Option.none() : Option.some(extra),
});
const mv = (move: Move): EffectiveMove => ({ _tag: "Move", move });

describe("ダメージ", () => {
  const python = initialFighter("Player", character("python"));
  const java = initialFighter("Player", character("java"));

  it("基本ダメージ：斬撃 20 / 刺突 15 / 打撃 10", () => {
    expect(damageFor(balance, "Slash", python, false)).toBe(20);
    expect(damageFor(balance, "Thrust", python, false)).toBe(15);
    expect(damageFor(balance, "Bash", python, false)).toBe(10);
  });

  it("素手は半減（切り上げ）、Java / Haskell は 1/3（切り上げ）", () => {
    expect(damageFor(balance, "Thrust", python, true)).toBe(8); // 15 / 2 = 7.5 → 8
    expect(damageFor(balance, "Slash", java, true)).toBe(7); // 20 / 3 = 6.67 → 7
    expect(damageFor(balance, "Bash", java, true)).toBe(4); // 10 / 3 = 3.33 → 4
    const haskell = initialFighter("Player", character("haskell"));
    expect(damageFor(balance, "Thrust", haskell, true)).toBe(5);
  });

  it("STW は素手補正の後に -10（0 未満にならない）", () => {
    const stw = { ...java, status: { ...java.status, stwPenaltyNow: 10 } };
    expect(damageFor(balance, "Slash", stw, false)).toBe(10);
    expect(damageFor(balance, "Bash", stw, false)).toBe(0);
    expect(damageFor(balance, "Slash", stw, true)).toBe(0);
  });
});

describe("勝敗の決定", () => {
  it("通常の三すくみ", () => {
    expect(decideExchange(balance, { Player: play(mv("Slash")), Cpu: play(mv("Thrust")) })).toEqual({
      winner: "Player",
      move: "Slash",
    });
    expect(decideExchange(balance, { Player: play(mv("Bash")), Cpu: play(mv("Bash")) })).toBeNull();
  });

  it("undefined はあいこ扱い", () => {
    expect(decideExchange(balance, { Player: play({ _tag: "Undefined" }), Cpu: play(mv("Slash")) })).toBeNull();
  });

  it("不発の側は相手の手が一方的に通る", () => {
    expect(decideExchange(balance, { Player: play({ _tag: "Fizzle" }), Cpu: play(mv("Bash")) })).toEqual({
      winner: "Cpu",
      move: "Bash",
    });
    expect(decideExchange(balance, { Player: play({ _tag: "Fizzle" }), Cpu: play({ _tag: "Fizzle" }) })).toBeNull();
  });

  it("イベントループ：2 手のどちらかが勝てば勝ち（相手に負ける手を含んでいても）", () => {
    // 斬撃は打撃に負けるが、刺突が打撃に勝つ
    expect(decideExchange(balance, { Player: play(mv("Slash"), "Thrust"), Cpu: play(mv("Bash")) })).toEqual({
      winner: "Player",
      move: "Thrust",
    });
    // どちらも勝てなければ負け
    expect(decideExchange(balance, { Player: play(mv("Slash"), "Slash"), Cpu: play(mv("Bash")) })).toEqual({
      winner: "Cpu",
      move: "Bash",
    });
  });
});
