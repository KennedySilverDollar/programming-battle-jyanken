import { Option } from "effect";
import type { CharacterSpec } from "./characters";
import type { EffectiveMove } from "./events";
import { handTotal, type Hand } from "./hand";
import type { Move } from "./move";
import { opponentOf, type Side } from "./side";
import { isRepeatable } from "./skills";
import { type FighterState, type GameState, isBareHanded, playableMoves, thunkTotal } from "./state";

/**
 * 視点ごとに切り出した情報。UI と CPU はこの型しか受け取らないため、
 * 相手の手札内訳や隠れデメリットの内部状態が漏れる経路は型レベルで存在しない。
 */
export interface SkillView {
  readonly name: string;
  readonly concept: string;
  readonly description: string;
  readonly used: boolean;
  readonly activations: number;
  /** 何度でも発動するスキル（Java の GC）。 */
  readonly repeatable: boolean;
}

/** サンク（遅延評価）。双方に常に公開する。 */
export interface ThunkView {
  readonly count: number;
  readonly total: number;
  readonly forced: boolean;
}

interface FighterViewBase {
  readonly side: Side;
  readonly character: CharacterSpec;
  readonly hp: number;
  readonly discard: readonly Move[];
  readonly skill: SkillView;
  /** 遅延評価のキャラのみ Some。 */
  readonly thunks: Option.Option<ThunkView>;
  /** 次のターン（または今ターン）の Stop The World による与ダメージ減少。 */
  readonly stwPenalty: number;
}

/** 自分自身：手札内訳まで見える。 */
export interface OwnView extends FighterViewBase {
  readonly hand: Hand;
  readonly bare: boolean;
  /** RAII で回収し、このターン使えない手。 */
  readonly locked: Option.Option<Move>;
}

/** 相手：公開情報のみ。手札内訳は Python のスキル発動後だけ Some。 */
export interface OpponentView extends FighterViewBase {
  readonly revealedHand: Option.Option<Hand>;
}

/** 手選択画面以外で使う視点。相手の手札合計枚数は含まない。 */
export interface BattleView {
  readonly round: number;
  readonly turn: number;
  readonly self: OwnView;
  readonly opponent: OpponentView;
}

/** 手選択画面専用の視点。相手の手札合計枚数と、出せる手を含む。 */
export interface ChoiceView extends BattleView {
  readonly opponentHandTotal: number;
  readonly playable: readonly Move[];
}

/** イベントループの追加の 1 手を選ぶ画面。相手のオープン済みの手が見える。 */
export interface ExtraChoiceView extends ChoiceView {
  readonly opponentPlay: EffectiveMove;
}

const skillView = (f: FighterState): SkillView => ({
  name: f.skill.spec.displayName,
  concept: f.skill.spec.concept,
  description: f.skill.spec.description,
  used: f.skill.used,
  activations: f.skill.activations,
  repeatable: isRepeatable(f.skill.spec.kind),
});

const thunkView = (f: FighterState): Option.Option<ThunkView> =>
  f.skill.spec.activate._tag === "LazyEvaluation"
    ? Option.some({ count: f.lazy.thunks.length, total: thunkTotal(f.lazy), forced: f.lazy.forced })
    : Option.none();

const base = (f: FighterState): FighterViewBase => ({
  side: f.side,
  character: f.character,
  hp: f.hp,
  discard: f.discard,
  skill: skillView(f),
  thunks: thunkView(f),
  stwPenalty: Math.max(f.status.stwPenaltyNow, f.status.stwPenaltyNext),
});

export const battleView = (state: GameState, side: Side): BattleView => {
  const self = state.fighters[side];
  const opponent = state.fighters[opponentOf(side)];
  return {
    round: state.round,
    turn: state.turnsPlayed + 1,
    self: { ...base(self), hand: self.hand, bare: isBareHanded(self), locked: self.status.locked },
    opponent: {
      ...base(opponent),
      revealedHand: self.status.revealsOpponentHand ? Option.some(opponent.hand) : Option.none(),
    },
  };
};

export const choiceView = (state: GameState, side: Side): ChoiceView => ({
  ...battleView(state, side),
  opponentHandTotal: handTotal(state.fighters[opponentOf(side)].hand),
  playable: playableMoves(state.fighters[side]),
});

export const extraChoiceView = (state: GameState, side: Side, opponentPlay: EffectiveMove): ExtraChoiceView => ({
  ...choiceView(state, side),
  opponentPlay,
});
