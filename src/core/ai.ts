import { Array as Arr, Effect, Layer } from "effect";
import { availableMoves } from "./hand";
import { RandomService } from "./random";
import { CpuStrategy } from "./services";

/** 骨格用 CPU：残っている手から一様ランダムに選ぶ。 */
export const randomCpuLayer: Layer.Layer<CpuStrategy, never, RandomService> = Layer.effect(
  CpuStrategy,
  Effect.map(RandomService, (random) => ({
    chooseMove: (view) => {
      const moves = availableMoves(view.self.hand);
      return Arr.isNonEmptyReadonlyArray(moves)
        ? random.pick(moves)
        : Effect.dieMessage("手札 0 枚で手選択に入った（試合は終了しているはず）");
    },
  })),
);
