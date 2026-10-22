import { Data } from "effect";
import type { Move, Outcome } from "./move";
import type { Side } from "./side";
import type { ActivationDetail, SkillId } from "./skills";
import type { TraitId } from "./traits";
import type { BattleView } from "./view";

export type RoundResult = Data.TaggedEnum<{
  /** HP 0 で決着、または上限ターンで HP 割合が高い方。 */
  Victory: { readonly winner: Side; readonly reason: "HpDepleted" | "TurnLimit" };
  /** 同じターンに両者 HP 0、または上限ターンで HP 割合が同じ。その試合はやり直し（どちらにも 1 本入らない）。 */
  Draw: { readonly reason: "DoubleKnockout" | "TurnLimit" };
}>;
export const RoundResult = Data.taggedEnum<RoundResult>();

export type TurnResult = RoundResult | { readonly _tag: "Continue" };

/** 実際に効いた手。隠れデメリットで undefined / 不発になることがある。 */
export type EffectiveMove =
  { readonly _tag: "Move"; readonly move: Move } | { readonly _tag: "Undefined" } | { readonly _tag: "Fizzle" };

/** オープンされた 1 手。chosen は選んだ手、bare は素手（カード消費なし）。 */
export interface RevealedPlay {
  readonly chosen: Move;
  readonly bare: boolean;
  readonly effective: EffectiveMove;
}

export interface Damage {
  readonly target: Side;
  readonly amount: number;
  /** 遅延評価でサンクに積まれた（HP はまだ減っていない）。 */
  readonly deferred: boolean;
}

export type TurnNote =
  | { readonly _tag: "TempReleased"; readonly side: Side; readonly moves: readonly Move[] }
  | { readonly _tag: "RaiiReturned"; readonly side: Side; readonly move: Move };

/** 戦闘エンジンからホスト（UI）への通知。view は常に Player 視点。 */
export type BattleEvent = Data.TaggedEnum<{
  RoundStarted: { readonly round: number; readonly wins: Readonly<Record<Side, number>>; readonly view: BattleView };
  TurnStarted: { readonly view: BattleView };
  SkillActivated: {
    readonly side: Side;
    readonly skillId: SkillId;
    readonly name: string;
    readonly description: string;
    readonly detail: ActivationDetail;
    readonly view: BattleView;
  };
  /** Java の GC で Stop The World が発生した（「GCが走った！！」）。 */
  StopTheWorld: { readonly side: Side; readonly penalty: number; readonly view: BattleView };
  /** 隠れデメリットが発動した。firstUnlock は今回はじめて実績が解除されたか。 */
  TraitTriggered: {
    readonly side: Side;
    readonly traitId: TraitId;
    readonly displayName: string;
    readonly achievementId: string;
    readonly firstUnlock: boolean;
    readonly view: BattleView;
  };
  /** Haskell の手札が 0 になり、サンクを強制評価した。 */
  ThunksForced: { readonly side: Side; readonly total: number; readonly view: BattleView };
  MovesRevealed: { readonly plays: Readonly<Record<Side, RevealedPlay>>; readonly view: BattleView };
  /** JavaScript のイベントループによる追加の 1 手。 */
  ExtraMovePlayed: { readonly side: Side; readonly move: Move; readonly view: BattleView };
  ExchangeResolved: {
    /** Player から見た勝敗。 */
    readonly outcome: Outcome;
    readonly winningMove: Move | null;
    readonly damage: Damage | null;
    /** 打撃で勝ったとき、相手の手札から捨て札へ送られたカード。 */
    readonly bashDiscard: { readonly side: Side; readonly moves: readonly Move[] } | null;
    /** 遅延評価側が勝って破棄したサンク。 */
    readonly thunkDropped: { readonly side: Side; readonly amount: number } | null;
    readonly view: BattleView;
  };
  TurnEnded: { readonly notes: readonly TurnNote[]; readonly view: BattleView };
  RoundEnded: {
    readonly result: RoundResult;
    readonly wins: Readonly<Record<Side, number>>;
    readonly view: BattleView;
  };
  MatchEnded: { readonly winner: Side; readonly wins: Readonly<Record<Side, number>>; readonly view: BattleView };
}>;
export const BattleEvent = Data.taggedEnum<BattleEvent>();
