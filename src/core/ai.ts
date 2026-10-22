import { Array as Arr, Effect, Layer } from "effect";
import { counterOf, type Move } from "./move";
import { RandomService } from "./random";
import { CpuStrategy } from "./services";

/** CPU：出せる手から一様ランダム。イベントループの追加の 1 手は、勝てる手があればそれを出す。 */
export const randomCpuLayer: Layer.Layer<CpuStrategy, never, RandomService> = Layer.effect(
  CpuStrategy,
  Effect.map(RandomService, (random) => {
    const pickFrom = (moves: readonly Move[]): Effect.Effect<Move> =>
      Arr.isNonEmptyReadonlyArray(moves) ? random.pick(moves) : Effect.dieMessage("出せる手が無い");
    return {
      chooseMove: (view) => pickFrom(view.playable),
      chooseExtraMove: (view) => {
        const play = view.opponentPlay;
        if (play._tag === "Move") {
          const counter = counterOf(play.move);
          if (view.playable.includes(counter)) return Effect.succeed(counter);
        }
        return pickFrom(view.playable);
      },
    };
  }),
);
