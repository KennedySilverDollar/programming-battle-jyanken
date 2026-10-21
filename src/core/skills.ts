import { Array as Arr, Effect, Schema } from "effect";
import { addCard, availableMoves, CardCount, handTotal, removeCard } from "./hand";
import { MOVES, type Move } from "./move";
import { RandomService } from "./random";
import type { Duel, FighterState } from "./state";

// ---------------------------------------------------------------------------
// データとしてのスキル定義（Schema）
// ---------------------------------------------------------------------------

/** 発動条件。すべて「ターンの初め」に評価される。 */
export const SkillTrigger = Schema.Union(
  /** 相手の手札合計が cards 枚以下。 */
  Schema.TaggedStruct("OpponentHandAtMost", { cards: CardCount }),
  /** 自分の手札合計が cards 枚以下。 */
  Schema.TaggedStruct("OwnHandAtMost", { cards: CardCount }),
  /** 自分の HP が最大 HP × ratio 以下。 */
  Schema.TaggedStruct("OwnHpRatioAtMost", { ratio: Schema.Number.pipe(Schema.between(0, 1)) }),
);
export type SkillTrigger = typeof SkillTrigger.Type;

/** 発動効果。 */
export const SkillEffect = Schema.Union(
  /** 相手の手札内訳をその試合中ずっと公開する。 */
  Schema.TaggedStruct("RevealOpponentHand", {}),
  /** 自分の手札 cards 枚をランダムな手に変換する。 */
  Schema.TaggedStruct("ConvertOwnCards", { cards: Schema.Int.pipe(Schema.positive()) }),
  /** このターン、与ダメージ・被ダメージを multiplier 倍にする（あいこは効果なし）。 */
  Schema.TaggedStruct("RiskMultiplier", { multiplier: Schema.Number.pipe(Schema.greaterThanOrEqualTo(1)) }),
);
export type SkillEffect = typeof SkillEffect.Type;

const SkillText = {
  name: Schema.NonEmptyTrimmedString,
  description: Schema.NonEmptyTrimmedString,
};

/**
 * スキル定義。
 * - Active: 自分の条件で発動し、効果を適用する。
 * - Negator: 「相手が発動条件を満たした」ことが条件で、相手のスキルを無効化する。
 *   条件と効果の組を型で固定し、ありえない組み合わせ（例: 無効化スキルに HP 条件）を排除する。
 */
export const SkillSpec = Schema.Union(
  Schema.TaggedStruct("Active", { ...SkillText, trigger: SkillTrigger, effect: SkillEffect }),
  Schema.TaggedStruct("Negator", SkillText),
);
export type SkillSpec = typeof SkillSpec.Type;

// ---------------------------------------------------------------------------
// 実行時のスキル（Skill インターフェース）
// ---------------------------------------------------------------------------

interface SkillBase {
  readonly name: string;
  readonly description: string;
  /** その試合で発動済みか。Haskell に無効化された場合は false のまま。 */
  readonly used: boolean;
  /** ターン初めの自動判定。used とは独立に、純粋に条件だけを返す。 */
  readonly condition: (self: FighterState, opponent: FighterState) => boolean;
}

export interface ActiveSkill extends SkillBase {
  readonly _tag: "Active";
  readonly effect: SkillEffect;
  /** 効果を適用した新しい (self, opponent) を返す。used の更新は戦闘エンジンが行う。 */
  readonly activate: (self: FighterState, opponent: FighterState) => Effect.Effect<Duel, never, RandomService>;
}

export interface NegatorSkill extends SkillBase {
  readonly _tag: "Negator";
}

export type Skill = ActiveSkill | NegatorSkill;

/** used が false で、かつ condition を満たすか。 */
export const isReady = (self: FighterState, opponent: FighterState): boolean =>
  !self.skill.used && self.skill.condition(self, opponent);

const triggerCondition =
  (trigger: SkillTrigger) =>
  (self: FighterState, opponent: FighterState): boolean => {
    switch (trigger._tag) {
      case "OpponentHandAtMost":
        return handTotal(opponent.hand) <= trigger.cards;
      case "OwnHandAtMost":
        return handTotal(self.hand) <= trigger.cards;
      case "OwnHpRatioAtMost":
        return self.hp <= self.character.maxHp * trigger.ratio;
    }
  };

/** 手札から重み付き（枚数比例）で 1 枚選び、ランダムな手に変換する。 */
const convertOneCard = (self: FighterState): Effect.Effect<FighterState, never, RandomService> =>
  Effect.gen(function* () {
    const random = yield* RandomService;
    const cards: readonly Move[] = availableMoves(self.hand).flatMap((m) =>
      Array.from({ length: self.hand[m] }, () => m),
    );
    if (!Arr.isNonEmptyReadonlyArray(cards)) return self;
    const from = yield* random.pick(cards);
    const to = yield* random.pick(MOVES);
    const removed = yield* removeCard(self.side, self.hand, from).pipe(
      Effect.orDieWith((e) => `手札にある手を選んだはずが失敗した: ${e.move}`),
    );
    return { ...self, hand: addCard(removed, to) };
  });

const applyEffect = (
  effect: SkillEffect,
  self: FighterState,
  opponent: FighterState,
): Effect.Effect<Duel, never, RandomService> => {
  switch (effect._tag) {
    case "RevealOpponentHand":
      return Effect.succeed({ self: { ...self, status: { ...self.status, revealsOpponentHand: true } }, opponent });
    case "ConvertOwnCards":
      return Effect.iterate(
        { i: 0, state: self },
        {
          while: ({ i }) => i < effect.cards,
          body: ({ i, state }) => Effect.map(convertOneCard(state), (next) => ({ i: i + 1, state: next })),
        },
      ).pipe(Effect.map(({ state }) => ({ self: state, opponent })));
    case "RiskMultiplier":
      return Effect.succeed({
        self: { ...self, status: { ...self.status, riskMultiplier: effect.multiplier } },
        opponent,
      });
  }
};

/** Negator の条件：相手が Active スキルで、未使用かつ条件を満たしている。 */
const negatorCondition = (self: FighterState, opponent: FighterState): boolean =>
  opponent.skill._tag === "Active" && isReady(opponent, self);

/** データ定義から実行時スキルを組み立てる（used = false で開始）。 */
export const buildSkill = (spec: SkillSpec): Skill => {
  switch (spec._tag) {
    case "Active":
      return {
        _tag: "Active",
        name: spec.name,
        description: spec.description,
        used: false,
        effect: spec.effect,
        condition: triggerCondition(spec.trigger),
        activate: (self, opponent) => applyEffect(spec.effect, self, opponent),
      };
    case "Negator":
      return {
        _tag: "Negator",
        name: spec.name,
        description: spec.description,
        used: false,
        condition: negatorCondition,
      };
  }
};

export const markUsed = (skill: Skill): Skill => ({ ...skill, used: true });
