import { Clock, Effect, Option, Schema } from "effect";
import { InvalidGameData, type StartupError } from "../core/errors";
import { decodeOrFail, findCharacter, type GameData, loadGameData } from "../core/gameData";
import type { Quality } from "./fx";
import type { Matchup } from "./selectState";

/**
 * URL クエリ（ブラウザ・開発用）。
 * - ?player=python&cpu=haskell … 選択画面を飛ばしてその対戦から始める（両方指定が必要）
 * - ?seed=123 … シード固定
 * - ?quality=high|low … 描画品質を固定（既定は auto：実測 fps で自動調整）
 */
export const LaunchParams = Schema.Struct({
  player: Schema.optional(Schema.String),
  cpu: Schema.optional(Schema.String),
  seed: Schema.optional(Schema.NumberFromString.pipe(Schema.int())),
  quality: Schema.optionalWith(Schema.Literal("auto", "high", "low"), { default: () => "auto" }),
});

export interface LaunchConfig {
  readonly data: GameData;
  readonly preset: Option.Option<Matchup>;
  readonly seed: number;
  readonly quality: Quality;
}

export const loadLaunchConfig = (search: string): Effect.Effect<LaunchConfig, StartupError> =>
  Effect.gen(function* () {
    const data = yield* loadGameData();
    const params = yield* decodeOrFail(LaunchParams, "URL クエリ")(Object.fromEntries(new URLSearchParams(search)));
    const { player, cpu } = params;
    if ((player === undefined) !== (cpu === undefined)) {
      return yield* new InvalidGameData({ source: "URL クエリ", message: "player と cpu は両方指定してください" });
    }
    const preset: Option.Option<Matchup> =
      player === undefined || cpu === undefined
        ? Option.none()
        : Option.some({
            Player: yield* findCharacter(data.roster, player),
            Cpu: yield* findCharacter(data.roster, cpu),
          });
    const seed = params.seed ?? (yield* Clock.currentTimeMillis) % 1_000_000;
    return { data, preset, seed, quality: params.quality };
  });
