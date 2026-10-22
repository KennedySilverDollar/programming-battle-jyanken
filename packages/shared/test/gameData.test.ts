import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import { RAW_ACHIEVEMENTS } from "../src/achievements";
import { RAW_BALANCE } from "../src/balance";
import { rawCharacters } from "../src/characters";
import { findCharacter, loadGameData } from "../src/gameData";
import { gameData } from "./helpers";

const tagOf = <A, E extends { readonly _tag: string }>(r: Either.Either<A, E>): string =>
  Either.match(r, { onLeft: (e) => e._tag, onRight: () => "Right" });

const load = (raw: Parameters<typeof loadGameData>[0]) => Effect.runSync(Effect.either(loadGameData(raw)));

describe("起動時のデータ検証", () => {
  it("同梱データは 7 キャラとしてデコードでき、cards { slash, thrust, bash } は Hand になる", () => {
    expect(gameData.roster.map((c) => c.id)).toEqual(["java", "haskell", "c", "cpp", "javascript", "python", "php"]);
    expect(gameData.roster.map((c) => c.maxHp)).toEqual([120, 110, 90, 85, 85, 80, 75]);
    expect(gameData.roster[0].cards).toEqual({ Slash: 3, Thrust: 4, Bash: 4 });
    expect(gameData.roster.map((c) => c.bareHandDivisor)).toEqual([3, 3, 2, 2, 2, 2, 2]);
    expect(gameData.roster.filter((c) => c.hiddenTrait === null).map((c) => c.id)).toEqual(["haskell", "python"]);
    expect(gameData.achievements).toHaveLength(5);
  });

  it("不正なバランス値（負のダメージ・範囲外の確率）は InvalidGameData", () => {
    expect(tagOf(load({ balance: { ...RAW_BALANCE, damage: { ...RAW_BALANCE.damage, Slash: -5 } } }))).toBe(
      "InvalidGameData",
    );
    const badProb = {
      ...RAW_BALANCE,
      skills: { ...RAW_BALANCE.skills, javaGc: { ...RAW_BALANCE.skills.javaGc, probability: 1.5 } },
    };
    expect(tagOf(load({ balance: badProb }))).toBe("InvalidGameData");
  });

  it("ID が重複したキャラ定義は InvalidGameData", () => {
    const dup = (b: Parameters<typeof rawCharacters>[0]) => {
      const [first, ...rest] = rawCharacters(b);
      return [first, first, ...rest];
    };
    expect(tagOf(load({ characters: dup }))).toBe("InvalidGameData");
  });

  it("スキルの種類と効果の組み合わせが不正なら InvalidGameData（PassiveAlways は遅延評価専用）", () => {
    const broken = (b: Parameters<typeof rawCharacters>[0]) =>
      rawCharacters(b).map((c) =>
        c.id === "python" ? { ...c, skill: { ...c.skill, kind: { kind: "PassiveAlways" } } } : c,
      );
    expect(tagOf(load({ characters: broken }))).toBe("InvalidGameData");
  });

  it("隠れデメリットが存在しない実績を参照していたら InvalidGameData", () => {
    const missing = RAW_ACHIEVEMENTS.filter((a) => a.achievementId !== "segfault");
    expect(tagOf(load({ achievements: missing }))).toBe("InvalidGameData");
  });

  it("未知のキャラ ID は UnknownCharacter", () => {
    expect(tagOf(Effect.runSync(Effect.either(findCharacter(gameData.roster, "rust"))))).toBe("UnknownCharacter");
  });
});
