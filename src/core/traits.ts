import { Schema } from "effect";
import { Condition, type ConditionContext, conditionHolds } from "./conditions";

/**
 * 隠れデメリット（実績システム）。キャラ選択・図鑑・通常 UI には一切表示しない。
 * 初回発動時に実績が解除され、実績画面で詳細を読めるようになる。
 */
export const TraitId = Schema.Literal(
  "c.null_pointer",
  "cpp.memory_leak",
  "js.undefined",
  "php.type_juggling",
  "java.swt_leak",
);
export type TraitId = typeof TraitId.Type;

/**
 * 効果。いつ判定されるか（タイミング）は効果の種類で決まる：
 * - ターン初め：ShrinkHandCapacity / SelfDamage
 * - オープン時（手の確定後）：Fizzle / UndefinedMove / JuggleMove
 */
export const TraitEffect = Schema.Union(
  /** そのターンの手が不発（攻撃が出ず、相手の手が一方的に通る）。 */
  Schema.TaggedStruct("Fizzle", {}),
  /** 手札の最大枚数が cards 枚減る（累積）。超えた分は捨て札へ。 */
  Schema.TaggedStruct("ShrinkHandCapacity", { cards: Schema.Int.pipe(Schema.positive()) }),
  /** 選んだ手が undefined になり、あいこ扱い。 */
  Schema.TaggedStruct("UndefinedMove", {}),
  /** 自分の手がランダムに別の手へ変わる。 */
  Schema.TaggedStruct("JuggleMove", {}),
  /** 自分の HP が amount 減る。 */
  Schema.TaggedStruct("SelfDamage", { amount: Schema.Int.pipe(Schema.positive()) }),
);
export type TraitEffect = typeof TraitEffect.Type;

export type TraitTiming = "TurnStart" | "MoveOpen";

export const traitTiming = (effect: TraitEffect): TraitTiming => {
  switch (effect._tag) {
    case "ShrinkHandCapacity":
    case "SelfDamage":
      return "TurnStart";
    case "Fizzle":
    case "UndefinedMove":
    case "JuggleMove":
      return "MoveOpen";
  }
};

export const HiddenTraitSpec = Schema.Struct({
  traitId: TraitId,
  displayName: Schema.NonEmptyTrimmedString,
  trigger: Schema.Struct({
    condition: Condition,
    probability: Schema.Number.pipe(Schema.between(0, 1)),
  }),
  effect: TraitEffect,
  achievementId: Schema.NonEmptyTrimmedString,
});
export type HiddenTraitSpec = typeof HiddenTraitSpec.Type;

/** 確率判定に進めるか（条件だけを見る）。 */
export const traitEligible = (trait: HiddenTraitSpec, timing: TraitTiming, ctx: ConditionContext): boolean =>
  traitTiming(trait.effect) === timing && conditionHolds(trait.trigger.condition, ctx);
