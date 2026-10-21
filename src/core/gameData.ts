import { Effect, ParseResult, Schema } from "effect";
import { Balance, RAW_BALANCE } from "./balance";
import { type CharacterDef, type CharacterId, CharacterRoster, rawCharacters } from "./characters";
import { InvalidGameData, UnknownCharacter } from "./errors";

export interface GameData {
  readonly balance: Balance;
  readonly roster: CharacterRoster;
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

/** 起動時に一度だけ実行する。不正なデータはここで型付きエラーとして落ちる。 */
export const loadGameData = (
  rawBalance: unknown = RAW_BALANCE,
  makeRawCharacters: (balance: Balance) => unknown = rawCharacters,
): Effect.Effect<GameData, InvalidGameData> =>
  Effect.gen(function* () {
    const balance = yield* decodeOrFail(Balance, "balance.ts")(rawBalance);
    const roster = yield* decodeOrFail(CharacterRoster, "characters.ts")(makeRawCharacters(balance));
    return { balance, roster };
  });

export const findCharacter = (roster: CharacterRoster, id: string): Effect.Effect<CharacterDef, UnknownCharacter> => {
  const found = roster.find((c) => c.id === id);
  return found === undefined
    ? Effect.fail(new UnknownCharacter({ id, known: roster.map((c): CharacterId => c.id) }))
    : Effect.succeed(found);
};
