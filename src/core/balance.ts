import { Schema } from "effect";
import { Hand } from "./hand";

const PositiveInt = Schema.Int.pipe(Schema.positive());
const Ratio = Schema.Number.pipe(Schema.between(0, 1));
const Multiplier = Schema.Number.pipe(Schema.greaterThanOrEqualTo(1));

/** 勝った手ごとの基本ダメージ。 */
export const DamageTable = Schema.Struct({
  Slash: PositiveInt,
  Guard: PositiveInt,
  Step: PositiveInt,
});

/** キャラクター 1 体分の数値。 */
export const CharacterStats = Schema.Struct({
  maxHp: PositiveInt,
  cards: Hand,
});
export type CharacterStats = typeof CharacterStats.Type;

/** スキルの閾値・倍率。 */
export const SkillTuning = Schema.Struct({
  importThis: Schema.Struct({ opponentHandAtMost: PositiveInt }),
  typeCoercion: Schema.Struct({ ownHandAtMost: PositiveInt, convertCards: PositiveInt }),
  undefinedBehavior: Schema.Struct({ hpRatioAtMost: Ratio, multiplier: Multiplier }),
});

export const Balance = Schema.Struct({
  damage: DamageTable,
  roundsToWin: PositiveInt,
  characters: Schema.Struct({
    python: CharacterStats,
    javascript: CharacterStats,
    cpp: CharacterStats,
    haskell: CharacterStats,
  }),
  skills: SkillTuning,
});
export type Balance = typeof Balance.Type;

/**
 * バランス調整用の生データ。型は `Balance.Encoded` に合わせるが、
 * 値域（正の整数・比率など）は起動時の Schema デコードで検証する。
 */
export const RAW_BALANCE = {
  damage: {
    Slash: 20, // 斬るで勝利
    Guard: 10, // 受けるで勝利（反撃）
    Step: 15, // 避けるで勝利
  },
  roundsToWin: 2,
  characters: {
    python: { maxHp: 100, cards: { Slash: 4, Guard: 4, Step: 4 } },
    javascript: { maxHp: 90, cards: { Slash: 6, Guard: 2, Step: 4 } },
    cpp: { maxHp: 80, cards: { Slash: 7, Guard: 2, Step: 3 } },
    haskell: { maxHp: 110, cards: { Slash: 3, Guard: 5, Step: 4 } },
  },
  skills: {
    importThis: { opponentHandAtMost: 6 },
    typeCoercion: { ownHandAtMost: 4, convertCards: 1 },
    undefinedBehavior: { hpRatioAtMost: 0.4, multiplier: 2 },
  },
} satisfies typeof Balance.Encoded;
