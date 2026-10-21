import { Schema } from "effect";
import type { Balance } from "./balance";
import { Hand, handTotal } from "./hand";
import { SkillSpec } from "./skills";

export const CharacterId = Schema.String.pipe(Schema.pattern(/^[a-z][a-z0-9-]*$/), Schema.brand("CharacterId"));
export type CharacterId = typeof CharacterId.Type;

/** 画像が用意されるまでの仮表示（色付き矩形＋言語名＋絵文字）。 */
export const Placeholder = Schema.Struct({
  color: Schema.Int.pipe(Schema.between(0, 0xffffff)),
  emoji: Schema.NonEmptyString,
});

/**
 * キャラクター定義。データ駆動で追加できるよう、ここに 1 要素足すだけで
 * 新キャラが選べるようになる（数値は balance.ts、スキル実装は skills.ts）。
 */
export const CharacterDef = Schema.Struct({
  id: CharacterId,
  name: Schema.NonEmptyTrimmedString,
  /** 画像テクスチャのキー。テクスチャが未ロードなら Placeholder で描画する。 */
  logoKey: Schema.NonEmptyTrimmedString,
  maxHp: Schema.Int.pipe(Schema.positive()),
  cards: Hand.pipe(Schema.filter((h) => handTotal(h) > 0 || "初期手札が 0 枚です")),
  skill: SkillSpec,
  placeholder: Placeholder,
});
export type CharacterDef = typeof CharacterDef.Type;

export const CharacterRoster = Schema.NonEmptyArray(CharacterDef).pipe(
  Schema.filter((defs) => new Set(defs.map((d) => d.id)).size === defs.length || "キャラクター ID が重複しています"),
);
export type CharacterRoster = typeof CharacterRoster.Type;

/** バランス値（デコード済み）からキャラクターの生データを組み立てる。 */
export const rawCharacters = (balance: Balance): typeof CharacterRoster.Encoded => {
  const { characters: stats, skills } = balance;
  return [
    {
      id: "python",
      name: "Python",
      logoKey: "logo-python",
      ...stats.python,
      skill: {
        _tag: "Active",
        name: "import this",
        description: "相手の手札内訳をこの試合中ずっと公開する。",
        trigger: { _tag: "OpponentHandAtMost", cards: skills.importThis.opponentHandAtMost },
        effect: { _tag: "RevealOpponentHand" },
      },
      placeholder: { color: 0x3776ab, emoji: "🐍" },
    },
    {
      id: "javascript",
      name: "JavaScript",
      logoKey: "logo-javascript",
      ...stats.javascript,
      skill: {
        _tag: "Active",
        name: "Type Coercion",
        description: `自分の手札 ${String(skills.typeCoercion.convertCards)} 枚をランダムな手に変換する。`,
        trigger: { _tag: "OwnHandAtMost", cards: skills.typeCoercion.ownHandAtMost },
        effect: { _tag: "ConvertOwnCards", cards: skills.typeCoercion.convertCards },
      },
      placeholder: { color: 0xf7df1e, emoji: "🟨" },
    },
    {
      id: "cpp",
      name: "C++",
      logoKey: "logo-cpp",
      ...stats.cpp,
      skill: {
        _tag: "Active",
        name: "Undefined Behavior",
        description: `このターン、勝てば与ダメージ ${String(skills.undefinedBehavior.multiplier)} 倍、負ければ被ダメージ ${String(skills.undefinedBehavior.multiplier)} 倍。`,
        trigger: { _tag: "OwnHpRatioAtMost", ratio: skills.undefinedBehavior.hpRatioAtMost },
        effect: { _tag: "RiskMultiplier", multiplier: skills.undefinedBehavior.multiplier },
      },
      placeholder: { color: 0x00599c, emoji: "🔷" },
    },
    {
      id: "haskell",
      name: "Haskell",
      logoKey: "logo-haskell",
      ...stats.haskell,
      skill: {
        _tag: "Negator",
        name: "純粋関数",
        description: "相手が発動条件を満たしたスキルを無効化する。",
      },
      placeholder: { color: 0x5e5086, emoji: "🟣" },
    },
  ];
};
