import { Effect, Layer, Ref } from "effect";
import { AchievementStore, memoryAchievementStore } from "../src/achievements";
import { randomCpuLayer } from "../src/ai";
import { type MatchResult, playMatch } from "../src/battle";
import type { CharacterSpec } from "../src/characters";
import type { BattleEvent } from "../src/events";
import { findCharacter, type GameData, loadGameData } from "../src/gameData";
import type { Move } from "../src/move";
import { RandomService, seededRandomLayer } from "../src/random";
import { BattleEvents, CpuStrategy, type MoveChooser, PlayerInput } from "../src/services";
import type { Side } from "../src/side";
import type { ChoiceView, ExtraChoiceView } from "../src/view";

export const gameData: GameData = Effect.runSync(loadGameData());

export const character = (id: string): CharacterSpec => Effect.runSync(findCharacter(gameData.roster, id));

/** 1 手の選び方：固定の手、または視点を見て決める関数。出せない手なら出せる手の先頭で代用する。 */
export type Script = readonly (Move | ((view: ChoiceView) => Move))[];

/**
 * 台本どおりに手を出す。台本が尽きたら、Player は出せる手の先頭、CPU は末尾を出す
 * （同じ手を出し続けて永遠にあいこにならないように）。
 */
const scriptedChooser = (moves: Script, extras: Script, fallback: "first" | "last"): Effect.Effect<MoveChooser> =>
  Effect.gen(function* () {
    const main = yield* Ref.make(0);
    const extra = yield* Ref.make(0);
    const next = (queue: Script, ref: Ref.Ref<number>, view: ChoiceView): Effect.Effect<Move> =>
      Effect.gen(function* () {
        const i = yield* Ref.getAndUpdate(ref, (n) => n + 1);
        const entry = queue[i];
        const wanted = entry === undefined ? undefined : typeof entry === "function" ? entry(view) : entry;
        if (wanted !== undefined && view.playable.includes(wanted)) return wanted;
        const alt = fallback === "first" ? view.playable[0] : view.playable[view.playable.length - 1];
        return alt ?? (yield* Effect.dieMessage("出せる手が無い"));
      });
    return {
      chooseMove: (view: ChoiceView) => next(moves, main, view),
      chooseExtraMove: (view: ExtraChoiceView) => next(extras, extra, view),
    };
  });

export interface RunOptions {
  readonly player: string;
  readonly cpu: string;
  readonly random?: Layer.Layer<RandomService>;
  readonly playerMoves?: Script;
  readonly playerExtras?: Script;
  /** 指定しなければ CPU はランダム。 */
  readonly cpuMoves?: Script;
  readonly cpuExtras?: Script;
  readonly unlocked?: readonly string[];
}

export interface Recorded {
  readonly result: MatchResult;
  readonly events: readonly BattleEvent[];
  readonly choices: readonly ChoiceView[];
  readonly unlocked: ReadonlySet<string>;
}

/** マッチ（ベストオブ 3）を実行し、イベントと Player の手選択画面を記録する。 */
export const runMatch = (opts: RunOptions): Recorded =>
  Effect.runSync(
    Effect.gen(function* () {
      const events = yield* Ref.make<readonly BattleEvent[]>([]);
      const choices = yield* Ref.make<readonly ChoiceView[]>([]);
      const scripted = yield* scriptedChooser(opts.playerMoves ?? [], opts.playerExtras ?? [], "first");
      const randomPlayer = yield* Effect.provide(CpuStrategy, randomCpuLayer);
      const player: MoveChooser = opts.playerMoves === undefined ? randomPlayer : scripted;

      const cpuLayer =
        opts.cpuMoves === undefined
          ? randomCpuLayer
          : Layer.effect(CpuStrategy, scriptedChooser(opts.cpuMoves, opts.cpuExtras ?? [], "last"));

      const layer = Layer.mergeAll(
        Layer.succeed(PlayerInput, {
          chooseMove: (view) =>
            Effect.zipRight(
              Ref.update(choices, (c) => [...c, view]),
              player.chooseMove(view),
            ),
          chooseExtraMove: player.chooseExtraMove,
        }),
        Layer.succeed(BattleEvents, { publish: (e) => Ref.update(events, (es) => [...es, e]) }),
        cpuLayer,
      );

      const characters: Record<Side, CharacterSpec> = { P1: character(opts.player), P2: character(opts.cpu) };
      const result = yield* playMatch({ balance: gameData.balance, characters }).pipe(Effect.provide(layer));
      const store = yield* AchievementStore;
      return {
        result,
        events: yield* Ref.get(events),
        choices: yield* Ref.get(choices),
        unlocked: yield* Effect.orDie(store.unlockedIds),
      };
    }).pipe(Effect.provide(Layer.merge(opts.random ?? seededRandomLayer(1), memoryAchievementStore(opts.unlocked)))),
  );

export const ofTag = <T extends BattleEvent["_tag"]>(
  events: readonly BattleEvent[],
  tag: T,
): Extract<BattleEvent, { _tag: T }>[] => events.flatMap((e) => (isTag(e, tag) ? [e] : []));

const isTag = <T extends BattleEvent["_tag"]>(e: BattleEvent, tag: T): e is Extract<BattleEvent, { _tag: T }> =>
  e._tag === tag;

/** 最初の試合（round 1）のイベントだけ。 */
export const firstRound = (events: readonly BattleEvent[]): readonly BattleEvent[] => {
  const end = events.findIndex((e) => e._tag === "RoundEnded");
  return end < 0 ? events : events.slice(0, end + 1);
};

export const repeat = (move: Move, n: number): Move[] => Array.from({ length: n }, () => move);
