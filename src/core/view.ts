import { Option } from "effect";
import type { CharacterDef } from "./characters";
import { handTotal, type Hand } from "./hand";
import type { Move } from "./move";
import { opponentOf, type Side } from "./side";
import type { FighterState, GameState } from "./state";

/**
 * 視点ごとに切り出した情報。UI と CPU はこの型しか受け取らないため、
 * 相手の手札内訳が漏れる経路は型レベルで存在しない。
 */
export interface SkillView {
  readonly name: string;
  readonly description: string;
  readonly used: boolean;
}

interface FighterViewBase {
  readonly side: Side;
  readonly character: CharacterDef;
  readonly hp: number;
  readonly discard: readonly Move[];
  readonly skill: SkillView;
}

/** 自分自身：手札内訳まで見える。 */
export interface OwnView extends FighterViewBase {
  readonly hand: Hand;
}

/** 相手：公開情報のみ。手札内訳は Python のスキル発動後だけ Some。 */
export interface OpponentView extends FighterViewBase {
  readonly revealedHand: Option.Option<Hand>;
}

/** 手選択画面以外で使う視点。相手の手札合計枚数は含まない。 */
export interface BattleView {
  readonly turn: number;
  readonly self: OwnView;
  readonly opponent: OpponentView;
}

/** 手選択画面専用の視点。相手の手札合計枚数を含む。 */
export interface ChoiceView extends BattleView {
  readonly opponentHandTotal: number;
}

const skillView = (f: FighterState): SkillView => ({
  name: f.skill.name,
  description: f.skill.description,
  used: f.skill.used,
});

const base = (f: FighterState): FighterViewBase => ({
  side: f.side,
  character: f.character,
  hp: f.hp,
  discard: f.discard,
  skill: skillView(f),
});

export const battleView = (state: GameState, side: Side): BattleView => {
  const self = state.fighters[side];
  const opponent = state.fighters[opponentOf(side)];
  return {
    turn: state.turnsPlayed + 1,
    self: { ...base(self), hand: self.hand },
    opponent: {
      ...base(opponent),
      revealedHand: self.status.revealsOpponentHand ? Option.some(opponent.hand) : Option.none(),
    },
  };
};

export const choiceView = (state: GameState, side: Side): ChoiceView => ({
  ...battleView(state, side),
  opponentHandTotal: handTotal(state.fighters[opponentOf(side)].hand),
});
