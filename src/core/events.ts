import { Data } from "effect";
import type { Move, Outcome } from "./move";
import type { Side } from "./side";
import type { BattleView } from "./view";

export type RoundResult = Data.TaggedEnum<{
  /** reason: HP 切れ / 手札切れ / 両者同時に手札切れで HP 割合判定 */
  Victory: { readonly winner: Side; readonly reason: "HpDepleted" | "HandEmpty" | "HpRatioTiebreak" };
  Draw: { readonly reason: "HpRatioTie" };
}>;
export const RoundResult = Data.taggedEnum<RoundResult>();

export type TurnResult = RoundResult | { readonly _tag: "Continue" };

export interface Damage {
  readonly target: Side;
  readonly amount: number;
}

/** 戦闘エンジンからホスト（UI）への通知。view は常に Player 視点。 */
export type BattleEvent = Data.TaggedEnum<{
  RoundStarted: { readonly view: BattleView };
  TurnStarted: { readonly view: BattleView };
  SkillActivated: {
    readonly side: Side;
    readonly name: string;
    readonly description: string;
    readonly view: BattleView;
  };
  SkillNegated: {
    readonly by: Side;
    readonly byName: string;
    readonly target: Side;
    readonly targetName: string;
    readonly view: BattleView;
  };
  MovesRevealed: {
    readonly moves: Readonly<Record<Side, Move>>;
    /** Player から見た勝敗。 */
    readonly outcome: Outcome;
    readonly damage: Damage | null;
    readonly view: BattleView;
  };
  RoundEnded: { readonly result: RoundResult; readonly view: BattleView };
}>;
export const BattleEvent = Data.taggedEnum<BattleEvent>();
