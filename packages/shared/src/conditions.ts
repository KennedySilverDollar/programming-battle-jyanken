import { Schema } from "effect";
import { CardCount, handTotal } from "./hand";
import type { FighterState } from "./state";

/**
 * スキル・隠れデメリットの発動条件の原子。条件は原子の配列で、すべて満たすと成立（AND）。
 * 空配列は常に成立。
 */
export const ConditionAtom = Schema.Union(
  /** 自分の手札合計が cards 枚以下。 */
  Schema.TaggedStruct("OwnHandAtMost", { cards: CardCount }),
  /** 自分の手札合計が cards 枚以上。 */
  Schema.TaggedStruct("OwnHandAtLeast", { cards: CardCount }),
  /** 相手の手札合計が cards 枚以下。 */
  Schema.TaggedStruct("OpponentHandAtMost", { cards: CardCount }),
  /** 自分の HP が最大 HP × ratio 以下。 */
  Schema.TaggedStruct("OwnHpRatioAtMost", { ratio: Schema.Number.pipe(Schema.between(0, 1)) }),
  /** turn ターン目以降。 */
  Schema.TaggedStruct("TurnAtLeast", { turn: Schema.Int.pipe(Schema.positive()) }),
  /** 自分の捨て札が cards 枚以上。 */
  Schema.TaggedStruct("OwnDiscardAtLeast", { cards: CardCount }),
  /** 自分のスキルがこの試合で count 回以上発動済み。 */
  Schema.TaggedStruct("SkillActivationsAtLeast", { count: CardCount }),
);
export type ConditionAtom = typeof ConditionAtom.Type;

export const Condition = Schema.Array(ConditionAtom);
export type Condition = typeof Condition.Type;

export interface ConditionContext {
  readonly self: FighterState;
  readonly opponent: FighterState;
  /** 現在のターン番号（1 始まり）。 */
  readonly turn: number;
}

const atomHolds = (atom: ConditionAtom, { self, opponent, turn }: ConditionContext): boolean => {
  switch (atom._tag) {
    case "OwnHandAtMost":
      return handTotal(self.hand) <= atom.cards;
    case "OwnHandAtLeast":
      return handTotal(self.hand) >= atom.cards;
    case "OpponentHandAtMost":
      return handTotal(opponent.hand) <= atom.cards;
    case "OwnHpRatioAtMost":
      return self.hp <= self.character.maxHp * atom.ratio;
    case "TurnAtLeast":
      return turn >= atom.turn;
    case "OwnDiscardAtLeast":
      return self.discard.length >= atom.cards;
    case "SkillActivationsAtLeast":
      return self.skill.activations >= atom.count;
  }
};

export const conditionHolds = (condition: Condition, ctx: ConditionContext): boolean =>
  condition.every((atom) => atomHolds(atom, ctx));
