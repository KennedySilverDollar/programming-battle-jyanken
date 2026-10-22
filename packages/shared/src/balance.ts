import { Schema } from "effect";
import { CardSet } from "./hand";

const PositiveInt = Schema.Int.pipe(Schema.positive());
const NonNegativeInt = Schema.Int.pipe(Schema.nonNegative());
const Probability = Schema.Number.pipe(Schema.between(0, 1));
const Ratio = Schema.Number.pipe(Schema.between(0, 1));

/** 勝った手ごとの基本ダメージ。 */
export const DamageTable = Schema.Struct({
  Slash: PositiveInt,
  Thrust: PositiveInt,
  Bash: PositiveInt,
});

/** キャラクター 1 体分の数値。 */
export const CharacterStats = Schema.Struct({
  maxHp: PositiveInt,
  /** 初期手札 { slash, thrust, bash }。 */
  cards: CardSet,
  /** 素手（手札 0）のときの与ダメージの割り算（端数切り上げ）。通常 2、Java / Haskell は 3。 */
  bareHandDivisor: Schema.Int.pipe(Schema.greaterThanOrEqualTo(1)),
});
export type CharacterStats = typeof CharacterStats.Type;

/** スキルの閾値・確率・効果量。 */
export const SkillTuning = Schema.Struct({
  javaGc: Schema.Struct({
    probability: Probability,
    stwProbability: Probability,
    stwDamagePenalty: NonNegativeInt,
    returnCards: PositiveInt,
  }),
  cMalloc: Schema.Struct({ ownHandAtMost: NonNegativeInt, cards: PositiveInt }),
  cppRaii: Schema.Struct({ hpRatioAtMost: Ratio }),
  jsEventLoop: Schema.Struct({
    ownHandAtLeast: Schema.Int.pipe(Schema.greaterThanOrEqualTo(2)),
    turnAtLeast: PositiveInt,
  }),
  pythonTyping: Schema.Struct({ opponentHandAtMost: NonNegativeInt }),
  phpLifecycle: Schema.Struct({ opponentHandAtMost: NonNegativeInt, destroyCards: PositiveInt }),
});

/** 隠れデメリットの閾値・確率・効果量。 */
export const TraitTuning = Schema.Struct({
  cNullPointer: Schema.Struct({ probability: Probability }),
  cppMemoryLeak: Schema.Struct({ turnAtLeast: PositiveInt, probability: Probability, cards: PositiveInt }),
  jsUndefined: Schema.Struct({ ownHandAtMost: NonNegativeInt, probability: Probability }),
  phpTypeJuggling: Schema.Struct({ opponentHandAtMost: NonNegativeInt, probability: Probability }),
  javaSwtLeak: Schema.Struct({ gcAtLeast: PositiveInt, probability: Probability, selfDamage: PositiveInt }),
});

export const Balance = Schema.Struct({
  damage: DamageTable,
  /** 打撃で勝ったとき、相手の手札から捨て札へ送る枚数。 */
  bashDiscards: NonNegativeInt,
  /** 何本先取でマッチ勝利か（ベストオブ 3 なら 2）。 */
  roundsToWin: PositiveInt,
  /**
   * 1 試合の上限ターン数。HP 以外では負けないため、両者素手のあいこが続くと終わらない。
   * 上限に達したら HP 割合の高い方の勝ち（同率は引き分け＝その試合はやり直し）。
   */
  maxTurnsPerRound: PositiveInt,
  characters: Schema.Struct({
    java: CharacterStats,
    haskell: CharacterStats,
    c: CharacterStats,
    cpp: CharacterStats,
    javascript: CharacterStats,
    python: CharacterStats,
    php: CharacterStats,
  }),
  skills: SkillTuning,
  traits: TraitTuning,
});
export type Balance = typeof Balance.Type;

/**
 * バランス調整用の生データ。型は `Balance.Encoded` に合わせるが、
 * 値域（正の整数・確率など）は起動時の Schema デコードで検証する。
 */
export const RAW_BALANCE = {
  damage: {
    Slash: 20, // 斬撃で勝利
    Thrust: 15, // 刺突で勝利
    Bash: 10, // 打撃で勝利（＋相手の手札を捨て札へ）
  },
  bashDiscards: 1,
  roundsToWin: 2,
  maxTurnsPerRound: 60,
  characters: {
    java: { maxHp: 120, cards: { slash: 3, thrust: 4, bash: 4 }, bareHandDivisor: 3 },
    haskell: { maxHp: 110, cards: { slash: 3, thrust: 5, bash: 4 }, bareHandDivisor: 3 },
    c: { maxHp: 90, cards: { slash: 6, thrust: 3, bash: 3 }, bareHandDivisor: 2 },
    cpp: { maxHp: 85, cards: { slash: 7, thrust: 3, bash: 2 }, bareHandDivisor: 2 },
    javascript: { maxHp: 85, cards: { slash: 6, thrust: 2, bash: 4 }, bareHandDivisor: 2 },
    python: { maxHp: 80, cards: { slash: 4, thrust: 4, bash: 4 }, bareHandDivisor: 2 },
    php: { maxHp: 75, cards: { slash: 5, thrust: 3, bash: 4 }, bareHandDivisor: 2 },
  },
  skills: {
    javaGc: { probability: 0.2, stwProbability: 0.3, stwDamagePenalty: 10, returnCards: 1 },
    cMalloc: { ownHandAtMost: 5, cards: 1 },
    cppRaii: { hpRatioAtMost: 0.5 },
    jsEventLoop: { ownHandAtLeast: 4, turnAtLeast: 3 },
    pythonTyping: { opponentHandAtMost: 6 },
    phpLifecycle: { opponentHandAtMost: 6, destroyCards: 2 },
  },
  traits: {
    cNullPointer: { probability: 0.1 },
    cppMemoryLeak: { turnAtLeast: 5, probability: 0.05, cards: 1 },
    jsUndefined: { ownHandAtMost: 3, probability: 0.1 },
    phpTypeJuggling: { opponentHandAtMost: 3, probability: 0.1 },
    javaSwtLeak: { gcAtLeast: 3, probability: 0.2, selfDamage: 5 },
  },
} satisfies typeof Balance.Encoded;
