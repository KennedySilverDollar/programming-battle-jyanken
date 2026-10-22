import { Effect, Option, Ref } from "effect";
import { AchievementStore } from "./achievements";
import type { Balance } from "./balance";
import type { CharacterSpec } from "./characters";
import { beginResolution, type EngineEvent, finishResolution, validateMove } from "./engine";
import { BattleEvent, type RoundResult, type TurnResult } from "./events";
import type { Move, Outcome } from "./move";
import type { RandomService } from "./random";
import { BattleEvents, CpuStrategy, type MoveChooser, PlayerInput } from "./services";
import { SIDES, type Side } from "./side";
import { assertInvariant, checkInvariants, type GameState, initialGameState, type MatchState } from "./state";
import { type BattleView, battleView, choiceView, extraChoiceView } from "./view";

/**
 * オフライン版（人間 = P1、CPU = P2）のマッチ進行。
 * ターンの解決そのものは engine.ts（サーバーと共通）に任せ、ここは入力の取得と演出への通知だけを行う。
 */

export interface MatchSetup {
  readonly balance: Balance;
  readonly characters: Readonly<Record<Side, CharacterSpec>>;
}

export type BattleEnv = RandomService | PlayerInput | CpuStrategy | BattleEvents | AchievementStore;

/** オフラインでは常に P1（人間）の視点で表示する。 */
const ME: Side = "P1";

const publish = (
  event: (view: BattleView) => BattleEvent,
  state: GameState,
): Effect.Effect<void, never, BattleEvents> =>
  Effect.flatMap(BattleEvents, (events) => events.publish(event(battleView(state, ME))));

export const outcomeFor = (winner: Side | null, side: Side): Outcome =>
  winner === null ? "Draw" : winner === side ? "Win" : "Lose";

/** 実績を解除する。ストレージの失敗はゲームを止めない（初回扱いにしない）。 */
const unlock = (achievementId: string): Effect.Effect<boolean, never, AchievementStore> =>
  Effect.flatMap(AchievementStore, (store) =>
    store
      .unlock(achievementId)
      .pipe(
        Effect.catchTag("AchievementStorageError", (e) =>
          Effect.as(Effect.logWarning(`実績を保存できませんでした: ${e.reason}`), false),
        ),
      ),
  );

/** エンジンの出来事を、P1 視点の表示用イベントとして通知する。 */
export const publishEngineEvent = (e: EngineEvent): Effect.Effect<void, never, BattleEvents | AchievementStore> =>
  Effect.gen(function* () {
    switch (e._tag) {
      case "SkillActivated":
        return yield* publish(
          (view) =>
            BattleEvent.SkillActivated({
              side: e.side,
              skillId: e.skillId,
              name: e.name,
              description: e.description,
              detail: e.detail,
              view,
            }),
          e.state,
        );
      case "StopTheWorld":
        return yield* publish((view) => BattleEvent.StopTheWorld({ side: e.side, penalty: e.penalty, view }), e.state);
      case "TraitTriggered": {
        const firstUnlock = yield* unlock(e.achievementId);
        return yield* publish(
          (view) =>
            BattleEvent.TraitTriggered({
              side: e.side,
              traitId: e.traitId,
              displayName: e.displayName,
              achievementId: e.achievementId,
              firstUnlock,
              view,
            }),
          e.state,
        );
      }
      case "ThunksForced":
        return yield* publish((view) => BattleEvent.ThunksForced({ side: e.side, total: e.total, view }), e.state);
      case "MovesRevealed":
        return yield* publish((view) => BattleEvent.MovesRevealed({ plays: e.plays, view }), e.state);
      case "ExtraMovePlayed":
        return yield* publish((view) => BattleEvent.ExtraMovePlayed({ side: e.side, move: e.move, view }), e.state);
      case "ExchangeResolved":
        return yield* publish(
          (view) =>
            BattleEvent.ExchangeResolved({
              outcome: outcomeFor(e.winner, ME),
              winningMove: e.winningMove,
              damage: e.damage,
              bashDiscard: e.bashDiscard,
              thunkDropped: e.thunkDropped,
              view,
            }),
          e.state,
        );
      case "TurnEnded":
        return yield* publish((view) => BattleEvent.TurnEnded({ notes: e.notes, view }), e.state);
    }
  });

const chooserFor = (side: Side): Effect.Effect<MoveChooser, never, PlayerInput | CpuStrategy> => {
  switch (side) {
    case "P1":
      return PlayerInput;
    case "P2":
      return CpuStrategy;
  }
};

/** 選ばせて検証する。出せない手が来たら（UI 側のバグ等）選び直させる。 */
const askUntilValid = (ask: Effect.Effect<Move>, state: Effect.Effect<GameState>, side: Side): Effect.Effect<Move> => {
  const loop: Effect.Effect<Move> = ask.pipe(
    Effect.flatMap((move) => Effect.flatMap(state, (s) => validateMove(s.fighters[side], move))),
    Effect.catchTag("NoCardForMove", () => Effect.suspend(() => loop)),
  );
  return loop;
};

/** 1 ターン：手選択 → スキル → 隠れデメリット →（イベントループ）→ オープン → ダメージ → 勝敗判定。 */
export const playTurn = (ref: Ref.Ref<GameState>, balance: Balance): Effect.Effect<TurnResult, never, BattleEnv> =>
  Effect.gen(function* () {
    const start = yield* Ref.get(ref);
    yield* checkInvariants(start);
    yield* publish((view) => BattleEvent.TurnStarted({ view }), start);

    // 1. 手選択（CPU が先に伏せる。見えないので順序は結果に影響しない）
    const current = Ref.get(ref);
    const cpu = yield* chooserFor("P2");
    const p2 = yield* askUntilValid(cpu.chooseMove(choiceView(start, "P2")), current, "P2");
    const human = yield* chooserFor("P1");
    const p1 = yield* askUntilValid(human.chooseMove(choiceView(start, "P1")), current, "P1");

    // 1〜3. 確定 → スキル → 隠れデメリット
    const phase = yield* beginResolution(start, { P1: p1, P2: p2 }).pipe(
      Effect.orDieWith((e) => `検証済みの手が出せない: ${e.side} ${e.move}`),
    );
    yield* Ref.set(ref, phase.state);
    for (const e of phase.events) yield* publishEngineEvent(e);

    // イベントループ：両者の手の確定後、オープン前に追加の 1 手を選ぶ
    const extras: Record<Side, Option.Option<Move>> = { P1: Option.none(), P2: Option.none() };
    for (const side of phase.needExtra) {
      const chooser = yield* chooserFor(side);
      extras[side] = Option.some(
        yield* askUntilValid(chooser.chooseExtraMove(extraChoiceView(phase.state, side)), current, side),
      );
    }

    // 4〜7. オープン → 判定 → ダメージ → 状態更新 → 勝敗判定
    const done = yield* finishResolution(balance, phase, extras).pipe(
      Effect.orDieWith((e) => `検証済みの追加の手が出せない: ${e.side} ${e.move}`),
    );
    yield* Ref.set(ref, done.state);
    for (const e of done.events) yield* publishEngineEvent(e);

    yield* checkInvariants(done.state);
    return done.result;
  });

export interface RoundOutcome {
  readonly result: RoundResult;
  /** 決着時の状態（結果画面の表示用）。 */
  readonly final: GameState;
}

/** 1 試合。開始時に HP・手札・スキル使用回数・隠れデメリットの累積をリセットし、決着までターンを回す。 */
export const playRound = (setup: MatchSetup, match: MatchState): Effect.Effect<RoundOutcome, never, BattleEnv> =>
  Effect.gen(function* () {
    const initial = initialGameState(setup.characters, match.round);
    yield* checkInvariants(initial);
    const ref = yield* Ref.make(initial);
    yield* publish((view) => BattleEvent.RoundStarted({ round: match.round, wins: match.wins, view }), initial);
    for (;;) {
      const result = yield* playTurn(ref, setup.balance);
      if (result._tag !== "Continue") return { result, final: yield* Ref.get(ref) };
    }
  });

/** 引き分けが続いた場合の安全弁（実質起こらない）。 */
export const MAX_ROUNDS = 25;

export interface MatchResult {
  readonly winner: Side;
  readonly wins: Readonly<Record<Side, number>>;
}

/** 試合結果を反映した勝ち数と、マッチの勝者（決まっていれば）。 */
export const applyRoundResult = (
  wins: Readonly<Record<Side, number>>,
  result: RoundResult,
  roundsToWin: number,
): { readonly wins: Readonly<Record<Side, number>>; readonly champion: Side | undefined } => {
  const next = result._tag === "Victory" ? { ...wins, [result.winner]: wins[result.winner] + 1 } : wins;
  return { wins: next, champion: SIDES.find((s) => next[s] >= roundsToWin) };
};

/** ベストオブ N（roundsToWin 本先取）。引き分けの試合はどちらにも 1 本入らない。 */
export const playMatch = (setup: MatchSetup): Effect.Effect<MatchResult, never, BattleEnv> =>
  Effect.gen(function* () {
    const ref = yield* Ref.make<MatchState>({ round: 1, wins: { P1: 0, P2: 0 } });
    for (;;) {
      const match = yield* Ref.get(ref);
      yield* assertInvariant(match.round <= MAX_ROUNDS, "試合数が上限を超えた");
      const { result, final } = yield* playRound(setup, match);
      const { wins, champion } = applyRoundResult(match.wins, result, setup.balance.roundsToWin);
      yield* Ref.set(ref, { round: match.round + 1, wins });
      yield* publish((view) => BattleEvent.RoundEnded({ result, wins, view }), final);
      if (champion !== undefined) {
        yield* publish((view) => BattleEvent.MatchEnded({ winner: champion, wins, view }), final);
        return { winner: champion, wins };
      }
    }
  });
