import { Effect, Option, Schema } from "effect";
import { Condition, type ConditionContext, conditionHolds } from "./conditions";
import { addCard, handTotal, pickRandomCard } from "./hand";
import { MOVES, type Move } from "./move";
import { RandomService } from "./random";
import { enforceCapacity, type FighterState, moveToDiscard } from "./state";

// ---------------------------------------------------------------------------
// データとしてのスキル定義（Schema）
// ---------------------------------------------------------------------------

export const SkillId = Schema.Literal(
  "java.gc",
  "haskell.lazy",
  "c.malloc",
  "cpp.raii",
  "js.event_loop",
  "python.dynamic_typing",
  "php.request_lifecycle",
);
export type SkillId = typeof SkillId.Type;

const Probability = Schema.Number.pipe(Schema.between(0, 1));

/**
 * 発動の仕方。
 * - Active: 条件を満たしたターン初めに発動（1 試合 1 回）
 * - Random: 条件を満たしたターン初めに probability で発動（1 試合 1 回）
 * - RandomWithSideEffect: 条件を満たしたターン初めに probability で発動し、さらに
 *   sideEffectProbability で副作用（Java の Stop The World）。何回でも発動する
 * - PassiveAlways: 常時効果。「発動」はしない
 */
export const SkillKind = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("Active") }),
  Schema.Struct({ kind: Schema.Literal("Random"), probability: Probability }),
  Schema.Struct({
    kind: Schema.Literal("RandomWithSideEffect"),
    probability: Probability,
    sideEffectProbability: Probability,
  }),
  Schema.Struct({ kind: Schema.Literal("PassiveAlways") }),
);
export type SkillKind = typeof SkillKind.Type;

/** 発動時の効果。 */
export const SkillActivation = Schema.Union(
  /** 捨て札からランダムに cards 枚を手札に戻す。副作用（STW）時は次ターンの与ダメージ -stwDamagePenalty。 */
  Schema.TaggedStruct("RecycleDiscard", {
    cards: Schema.Int.pipe(Schema.positive()),
    stwDamagePenalty: Schema.Int.pipe(Schema.nonNegative()),
  }),
  /** 被ダメージをサンクとして溜め、手札 0 で一括評価する（PassiveAlways 専用）。 */
  Schema.TaggedStruct("LazyEvaluation", {}),
  /** ランダムな手を cards 枚、このターンだけ手札に追加する（使わなければターン終了時に捨て札へ）。 */
  Schema.TaggedStruct("TemporaryCards", { cards: Schema.Int.pipe(Schema.positive()) }),
  /** このターン使ったカードをターン終了時に手札へ戻す（次ターンは使用不可）。 */
  Schema.TaggedStruct("ReturnUsedCard", {}),
  /** 相手の手がオープンされた後、追加で 1 手出す（手札 2 枚消費）。 */
  Schema.TaggedStruct("ExtraMove", {}),
  /** 相手の手札内訳をその試合中ずっと公開する。 */
  Schema.TaggedStruct("RevealOpponentHand", {}),
  /** 相手の手札をランダムに cards 枚、捨て札へ送る。 */
  Schema.TaggedStruct("DestroyOpponentCards", { cards: Schema.Int.pipe(Schema.positive()) }),
);
export type SkillActivation = typeof SkillActivation.Type;

const Text = Schema.NonEmptyTrimmedString;

export const SkillSpec = Schema.Struct({
  skillId: SkillId,
  displayName: Text,
  /** 元ネタ（言語仕様・実装上の概念）。 */
  concept: Text,
  description: Text,
  kind: SkillKind,
  condition: Condition,
  activate: SkillActivation,
}).pipe(
  Schema.filter((s) => {
    const passive = s.kind.kind === "PassiveAlways";
    const lazy = s.activate._tag === "LazyEvaluation";
    if (passive !== lazy) return `${s.skillId}: PassiveAlways と LazyEvaluation は必ず対で使う`;
    if (s.kind.kind === "RandomWithSideEffect" && s.activate._tag !== "RecycleDiscard") {
      return `${s.skillId}: RandomWithSideEffect の副作用は RecycleDiscard（STW）にしか定義されていない`;
    }
    return true;
  }),
);
export type SkillSpec = typeof SkillSpec.Type;

// ---------------------------------------------------------------------------
// 実行時のスキル
// ---------------------------------------------------------------------------

/** 1 試合ぶんのスキル状態。試合開始時にリセットされる。 */
export interface SkillState {
  readonly spec: SkillSpec;
  /** 1 回きりのスキルを使ったか。 */
  readonly used: boolean;
  /** この試合で発動した回数（GC の回数など）。 */
  readonly activations: number;
}

export const initialSkillState = (spec: SkillSpec): SkillState => ({ spec, used: false, activations: 0 });

/** 何回でも発動できる種類か（Java の GC）。 */
export const isRepeatable = (kind: SkillKind): boolean => {
  switch (kind.kind) {
    case "RandomWithSideEffect":
      return true;
    case "Active":
    case "Random":
    case "PassiveAlways":
      return false;
  }
};

/** 発動確率（Active は 1）。PassiveAlways は発動しないので 0。 */
export const activationProbability = (kind: SkillKind): number => {
  switch (kind.kind) {
    case "Active":
      return 1;
    case "Random":
    case "RandomWithSideEffect":
      return kind.probability;
    case "PassiveAlways":
      return 0;
  }
};

/** ターン初めに発動判定に進めるか（未使用 or 反復可、かつ条件成立）。 */
export const isEligible = (ctx: ConditionContext): boolean => {
  const { spec, used } = ctx.self.skill;
  if (spec.kind.kind === "PassiveAlways") return false;
  if (used && !isRepeatable(spec.kind)) return false;
  return conditionHolds(spec.condition, ctx);
};

/** 発動の結果（イベント表示用）。 */
export type ActivationDetail =
  | { readonly _tag: "Recycled"; readonly moves: readonly Move[] }
  | { readonly _tag: "Allocated" }
  | { readonly _tag: "RaiiArmed" }
  | { readonly _tag: "EventLoopArmed" }
  | { readonly _tag: "Revealed" }
  | { readonly _tag: "Destroyed"; readonly moves: readonly Move[] };

export interface ActivationResult {
  readonly self: FighterState;
  readonly opponent: FighterState;
  readonly detail: ActivationDetail;
}

/** 捨て札からランダムに 1 枚抜く。 */
const takeRandomDiscard = (
  f: FighterState,
): Effect.Effect<Option.Option<{ readonly fighter: FighterState; readonly move: Move }>, never, RandomService> =>
  Effect.gen(function* () {
    if (f.discard.length === 0) return Option.none();
    const random = yield* RandomService;
    const index = yield* random.integerInRange(0, f.discard.length - 1);
    const move = f.discard[index];
    if (move === undefined) return yield* Effect.dieMessage("捨て札のインデックスが範囲外");
    const discard = [...f.discard.slice(0, index), ...f.discard.slice(index + 1)];
    return Option.some({ fighter: { ...f, discard, hand: addCard(f.hand, move) }, move });
  });

const NO_MOVES: readonly Move[] = [];

const repeat = <A>(n: number, initial: A, step: (a: A) => Effect.Effect<A, never, RandomService>) =>
  Effect.iterate(
    { i: 0, a: initial },
    { while: ({ i }) => i < n, body: ({ i, a }) => Effect.map(step(a), (next) => ({ i: i + 1, a: next })) },
  ).pipe(Effect.map(({ a }) => a));

/** 効果を適用した新しい (self, opponent) を返す。used / activations の更新は戦闘エンジンが行う。 */
export const applyActivation = (
  activation: SkillActivation,
  self: FighterState,
  opponent: FighterState,
): Effect.Effect<ActivationResult, never, RandomService> =>
  Effect.gen(function* () {
    switch (activation._tag) {
      case "RecycleDiscard": {
        const { fighter, moves } = yield* repeat(
          activation.cards,
          { fighter: self, moves: NO_MOVES },
          ({ fighter, moves }) =>
            Effect.map(takeRandomDiscard(fighter), (taken) =>
              Option.match(taken, {
                onNone: () => ({ fighter, moves }),
                onSome: (t) => ({ fighter: t.fighter, moves: [...moves, t.move] }),
              }),
            ),
        );
        return { self: yield* enforceCapacity(fighter), opponent, detail: { _tag: "Recycled", moves } };
      }
      case "LazyEvaluation":
        return yield* Effect.dieMessage("LazyEvaluation は常時効果で、発動しない");
      case "TemporaryCards": {
        const random = yield* RandomService;
        const added = yield* repeat(activation.cards, NO_MOVES, (acc) =>
          Effect.map(random.pick(MOVES), (m) => [...acc, m]),
        );
        const hand = added.reduce(addCard, self.hand);
        const next: FighterState = {
          ...self,
          hand,
          created: self.created + added.length,
          status: { ...self.status, tempCards: [...self.status.tempCards, ...added] },
        };
        return { self: next, opponent, detail: { _tag: "Allocated" } };
      }
      case "ReturnUsedCard":
        return {
          self: { ...self, status: { ...self.status, raiiArmed: true } },
          opponent,
          detail: { _tag: "RaiiArmed" },
        };
      case "ExtraMove":
        return {
          self: { ...self, status: { ...self.status, eventLoop: true } },
          opponent,
          detail: { _tag: "EventLoopArmed" },
        };
      case "RevealOpponentHand":
        return {
          self: { ...self, status: { ...self.status, revealsOpponentHand: true } },
          opponent,
          detail: { _tag: "Revealed" },
        };
      case "DestroyOpponentCards": {
        const { fighter, moves } = yield* repeat(
          Math.min(activation.cards, handTotal(opponent.hand)),
          { fighter: opponent, moves: NO_MOVES },
          ({ fighter, moves }) =>
            Effect.gen(function* () {
              const card = yield* pickRandomCard(fighter.hand);
              if (Option.isNone(card)) return { fighter, moves };
              return { fighter: yield* moveToDiscard(fighter, card.value), moves: [...moves, card.value] };
            }),
        );
        return { self, opponent: fighter, detail: { _tag: "Destroyed", moves } };
      }
    }
  });
