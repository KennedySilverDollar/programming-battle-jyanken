import { Clock, Effect, Schema } from "effect";
import type { CharacterDef } from "../core/characters";
import type { StartupError } from "../core/errors";
import { decodeOrFail, findCharacter, type GameData, loadGameData } from "../core/gameData";
import type { Side } from "../core/side";

/** URL クエリ ?player=python&cpu=cpp&seed=123 */
export const LaunchParams = Schema.Struct({
  player: Schema.optionalWith(Schema.String, { default: () => "python" }),
  cpu: Schema.optionalWith(Schema.String, { default: () => "cpp" }),
  seed: Schema.optional(Schema.NumberFromString.pipe(Schema.int())),
});

export interface LaunchConfig {
  readonly data: GameData;
  readonly characters: Readonly<Record<Side, CharacterDef>>;
  readonly seed: number;
}

export const loadLaunchConfig = (search: string): Effect.Effect<LaunchConfig, StartupError> =>
  Effect.gen(function* () {
    const data = yield* loadGameData();
    const params = yield* decodeOrFail(LaunchParams, "URL クエリ")(Object.fromEntries(new URLSearchParams(search)));
    const player = yield* findCharacter(data.roster, params.player);
    const cpu = yield* findCharacter(data.roster, params.cpu);
    const seed = params.seed ?? (yield* Clock.currentTimeMillis) % 1_000_000;
    return { data, characters: { Player: player, Cpu: cpu }, seed };
  });
