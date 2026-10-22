import { Effect, ParseResult, Schema } from "effect";
import { AchievementList, type AchievementSpec, RAW_ACHIEVEMENTS } from "./achievements";
import { Balance, RAW_BALANCE } from "./balance";
import { type CharacterId, CharacterRoster, type CharacterSpec, rawCharacters } from "./characters";
import { InvalidGameData, UnknownCharacter } from "./errors";

export interface GameData {
  readonly balance: Balance;
  readonly roster: CharacterRoster;
  readonly achievements: readonly AchievementSpec[];
}

/** unknown を Schema でデコードし、失敗は InvalidGameData に変換する。 */
export const decodeOrFail =
  <A, I>(schema: Schema.Schema<A, I>, source: string) =>
  (input: unknown): Effect.Effect<A, InvalidGameData> =>
    Schema.decodeUnknown(schema)(input).pipe(
      Effect.mapError(
        (error) => new InvalidGameData({ source, message: ParseResult.TreeFormatter.formatErrorSync(error) }),
      ),
    );

export interface RawGameData {
  readonly balance: unknown;
  readonly characters: (balance: Balance) => unknown;
  readonly achievements: unknown;
}

const DEFAULT_RAW: RawGameData = {
  balance: RAW_BALANCE,
  characters: rawCharacters,
  achievements: RAW_ACHIEVEMENTS,
};

/** 起動時に一度だけ実行する。不正なデータはここで型付きエラーとして落ちる。 */
export const loadGameData = (raw: Partial<RawGameData> = {}): Effect.Effect<GameData, InvalidGameData> =>
  Effect.gen(function* () {
    const src = { ...DEFAULT_RAW, ...raw };
    const balance = yield* decodeOrFail(Balance, "balance.ts")(src.balance);
    const roster = yield* decodeOrFail(CharacterRoster, "characters.ts")(src.characters(balance));
    const achievements = yield* decodeOrFail(AchievementList, "achievements.ts")(src.achievements);

    // 隠れデメリットが参照する実績は必ず存在する
    const known = new Set(achievements.map((a) => a.achievementId));
    for (const c of roster) {
      if (c.hiddenTrait !== null && !known.has(c.hiddenTrait.achievementId)) {
        return yield* new InvalidGameData({
          source: "characters.ts",
          message: `${c.id} の隠れデメリットが未定義の実績 ${c.hiddenTrait.achievementId} を参照しています`,
        });
      }
    }
    return { balance, roster, achievements };
  });

export const findCharacter = (roster: CharacterRoster, id: string): Effect.Effect<CharacterSpec, UnknownCharacter> => {
  const found = roster.find((c) => c.id === id);
  return found === undefined
    ? Effect.fail(new UnknownCharacter({ id, known: roster.map((c): CharacterId => c.id) }))
    : Effect.succeed(found);
};
