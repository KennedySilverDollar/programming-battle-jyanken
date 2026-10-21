import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import { RAW_BALANCE } from "../src/core/balance";
import { rawCharacters } from "../src/core/characters";
import { findCharacter, loadGameData } from "../src/core/gameData";
import { gameData } from "./helpers";

const tagOf = <A, E extends { readonly _tag: string }>(r: Either.Either<A, E>): string =>
  Either.match(r, { onLeft: (e) => e._tag, onRight: () => "Right" });

describe("起動時のデータ検証", () => {
  it("同梱データは 4 キャラとしてデコードできる", () => {
    expect(gameData.roster.map((c) => c.id)).toEqual(["python", "javascript", "cpp", "haskell"]);
    expect(gameData.roster.map((c) => c.maxHp)).toEqual([100, 90, 80, 110]);
  });

  it("不正なバランス値は InvalidGameData で失敗する", () => {
    const bad = { ...RAW_BALANCE, damage: { ...RAW_BALANCE.damage, Slash: -5 } };
    const result = Effect.runSync(Effect.either(loadGameData(bad)));
    expect(tagOf(result)).toBe("InvalidGameData");
  });

  it("ID が重複したキャラ定義は InvalidGameData で失敗する", () => {
    const dup = (b: Parameters<typeof rawCharacters>[0]) => {
      const [first, ...rest] = rawCharacters(b);
      return [first, first, ...rest];
    };
    const result = Effect.runSync(Effect.either(loadGameData(RAW_BALANCE, dup)));
    expect(tagOf(result)).toBe("InvalidGameData");
  });

  it("不正なスキル定義（未知の効果タグ）は失敗する", () => {
    const broken = (b: Parameters<typeof rawCharacters>[0]) =>
      rawCharacters(b).map((c) => ({ ...c, skill: { ...c.skill, _tag: "Passive" } }));
    const result = Effect.runSync(Effect.either(loadGameData(RAW_BALANCE, broken)));
    expect(Either.isLeft(result)).toBe(true);
  });

  it("未知のキャラ ID は UnknownCharacter", () => {
    const result = Effect.runSync(Effect.either(findCharacter(gameData.roster, "rust")));
    expect(tagOf(result)).toBe("UnknownCharacter");
  });
});
