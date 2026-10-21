import { Array as Arr, Effect, Layer, Option, Ref } from "effect";
import { randomCpuLayer } from "../src/core/ai";
import { playRound } from "../src/core/battle";
import type { CharacterDef } from "../src/core/characters";
import type { BattleEvent, RoundResult } from "../src/core/events";
import { findCharacter, type GameData, loadGameData } from "../src/core/gameData";
import { availableMoves } from "../src/core/hand";
import type { Move } from "../src/core/move";
import { RandomService, seededRandomLayer } from "../src/core/random";
import { BattleEvents, CpuStrategy, PlayerInput } from "../src/core/services";
import type { Side } from "../src/core/side";
import type { ChoiceView } from "../src/core/view";

export const gameData: GameData = Effect.runSync(loadGameData());

export const character = (id: string): CharacterDef => Effect.runSync(findCharacter(gameData.roster, id));

type Chooser = (view: ChoiceView) => Effect.Effect<Move>;

/** 指定順に手を出す。尽きたら残っている手の先頭。 */
export const scripted = (moves: readonly Move[]): Effect.Effect<Chooser> =>
  Effect.map(
    Ref.make(moves),
    (queue) => (view) =>
      Ref.modify(queue, (q) => [Arr.head(q), Arr.drop(q, 1)]).pipe(
        Effect.flatMap(
          Option.match({
            onSome: Effect.succeed,
            onNone: () =>
              Option.match(Arr.head(availableMoves(view.self.hand)), {
                onSome: Effect.succeed,
                onNone: () => Effect.dieMessage("no cards"),
              }),
          }),
        ),
      ),
  );

export interface Recorded {
  readonly result: RoundResult;
  readonly events: readonly BattleEvent[];
  readonly choices: readonly ChoiceView[];
}

export interface RunOptions {
  readonly player: string;
  readonly cpu: string;
  readonly seed?: number;
  readonly playerMoves?: readonly Move[];
  readonly cpuMoves?: readonly Move[];
}

/** 1 試合を実行し、イベントと Player の手選択画面を記録する。 */
export const runRound = (opts: RunOptions): Recorded =>
  Effect.runSync(
    Effect.gen(function* () {
      const events = yield* Ref.make<readonly BattleEvent[]>([]);
      const choices = yield* Ref.make<readonly ChoiceView[]>([]);
      const random = yield* RandomService;
      const randomChooser: Chooser = (view) => {
        const moves = availableMoves(view.self.hand);
        return Arr.isNonEmptyReadonlyArray(moves) ? random.pick(moves) : Effect.dieMessage("no cards");
      };
      const playerChooser = opts.playerMoves === undefined ? randomChooser : yield* scripted(opts.playerMoves);

      const cpuLayer =
        opts.cpuMoves === undefined
          ? randomCpuLayer
          : Layer.effect(
              CpuStrategy,
              Effect.map(scripted(opts.cpuMoves), (chooseMove) => ({ chooseMove })),
            );

      const layer = Layer.mergeAll(
        Layer.succeed(PlayerInput, {
          chooseMove: (view) => Effect.zipRight(Ref.update(choices, Arr.append(view)), playerChooser(view)),
        }),
        Layer.succeed(BattleEvents, { publish: (e) => Ref.update(events, Arr.append(e)) }),
        cpuLayer,
      );

      const characters: Record<Side, CharacterDef> = { Player: character(opts.player), Cpu: character(opts.cpu) };
      const result = yield* playRound({ balance: gameData.balance, characters }).pipe(Effect.provide(layer));
      return { result, events: yield* Ref.get(events), choices: yield* Ref.get(choices) };
    }).pipe(Effect.provide(seededRandomLayer(opts.seed ?? 1))),
  );
