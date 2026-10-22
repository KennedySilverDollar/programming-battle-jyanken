import { Schema } from "effect";
import type { Balance } from "./balance";
import { CardSet, handTotal } from "./hand";
import { SkillSpec } from "./skills";
import { HiddenTraitSpec } from "./traits";

export const CharacterId = Schema.String.pipe(Schema.pattern(/^[a-z][a-z0-9-]*$/), Schema.brand("CharacterId"));
export type CharacterId = typeof CharacterId.Type;

/** 画像が用意されるまでの仮表示（色付き矩形＋言語名＋絵文字）。 */
export const Placeholder = Schema.Struct({
  color: Schema.Int.pipe(Schema.between(0, 0xffffff)),
  emoji: Schema.NonEmptyString,
});

/**
 * キャラクター定義。データ駆動で追加できるよう、ここに 1 要素足すだけで
 * 新キャラが選べるようになる（数値は balance.ts、スキルの実装は skills.ts）。
 */
export const CharacterSpec = Schema.Struct({
  id: CharacterId,
  name: Schema.NonEmptyTrimmedString,
  /** 画像テクスチャのキー。テクスチャが未ロードなら Placeholder で描画する。 */
  logoKey: Schema.NonEmptyTrimmedString,
  maxHp: Schema.Int.pipe(Schema.positive()),
  /** 初期手札 { slash, thrust, bash }（デコード後は Hand）。 */
  cards: CardSet.pipe(Schema.filter((h) => handTotal(h) > 0 || "初期手札が 0 枚です")),
  /** 素手のときの与ダメージの割り算（端数切り上げ）。 */
  bareHandDivisor: Schema.Int.pipe(Schema.greaterThanOrEqualTo(1)),
  skill: SkillSpec,
  /** 隠れデメリット。無いキャラは null。通常 UI には表示しない。 */
  hiddenTrait: Schema.NullOr(HiddenTraitSpec),
  placeholder: Placeholder,
});
export type CharacterSpec = typeof CharacterSpec.Type;

export const CharacterRoster = Schema.NonEmptyArray(CharacterSpec).pipe(
  Schema.filter((defs) => new Set(defs.map((d) => d.id)).size === defs.length || "キャラクター ID が重複しています"),
  Schema.filter((defs) => new Set(defs.map((d) => d.skill.skillId)).size === defs.length || "skillId が重複しています"),
);
export type CharacterRoster = typeof CharacterRoster.Type;

/** バランス値（デコード済み）からキャラクターの生データを組み立てる。 */
export const rawCharacters = (balance: Balance): typeof CharacterRoster.Encoded => {
  const { characters: stats, skills, traits } = balance;
  // バランス値は Hand（デコード済み）なので、データ表記 { slash, thrust, bash } に戻す
  const encode = (s: Balance["characters"]["java"]) => ({
    maxHp: s.maxHp,
    cards: { slash: s.cards.Slash, thrust: s.cards.Thrust, bash: s.cards.Bash },
    bareHandDivisor: s.bareHandDivisor,
  });
  const pct = (p: number): string => `${String(Math.round(p * 100))}%`;
  return [
    {
      id: "java",
      name: "Java",
      logoKey: "logo-java",
      ...encode(stats.java),
      skill: {
        skillId: "java.gc",
        displayName: "ガベージコレクション",
        concept: "不要になったオブジェクトを自動で回収する",
        description: `ターン開始時に ${pct(skills.javaGc.probability)} で発動。捨て札からランダムな ${String(skills.javaGc.returnCards)} 枚を手札に戻す。${pct(skills.javaGc.stwProbability)} で Stop The World が起き、次ターンの与ダメージ -${String(skills.javaGc.stwDamagePenalty)}。`,
        kind: {
          kind: "RandomWithSideEffect",
          probability: skills.javaGc.probability,
          sideEffectProbability: skills.javaGc.stwProbability,
        },
        condition: [{ _tag: "OwnDiscardAtLeast", cards: 1 }],
        activate: {
          _tag: "RecycleDiscard",
          cards: skills.javaGc.returnCards,
          stwDamagePenalty: skills.javaGc.stwDamagePenalty,
        },
      },
      hiddenTrait: {
        traitId: "java.swt_leak",
        displayName: "dispose忘れ",
        trigger: {
          condition: [{ _tag: "SkillActivationsAtLeast", count: traits.javaSwtLeak.gcAtLeast }],
          probability: traits.javaSwtLeak.probability,
        },
        effect: { _tag: "SelfDamage", amount: traits.javaSwtLeak.selfDamage },
        achievementId: "forgot_dispose",
      },
      placeholder: { color: 0xb07219, emoji: "☕" },
    },
    {
      id: "haskell",
      name: "Haskell",
      logoKey: "logo-haskell",
      ...encode(stats.haskell),
      skill: {
        skillId: "haskell.lazy",
        displayName: "遅延評価",
        concept: "値が必要になるまで計算を先送りする",
        description:
          "被ダメージを「サンク」として溜め、HP を減らさない。ターンに勝つと最も古いサンクを 1 つ破棄。手札が 0 になった瞬間、残りのサンクをすべて強制評価する（1 試合 1 回）。",
        kind: { kind: "PassiveAlways" },
        condition: [],
        activate: { _tag: "LazyEvaluation" },
      },
      hiddenTrait: null,
      placeholder: { color: 0x5e5086, emoji: "🟣" },
    },
    {
      id: "c",
      name: "C",
      logoKey: "logo-c",
      ...encode(stats.c),
      skill: {
        skillId: "c.malloc",
        displayName: "動的メモリ確保",
        concept: "malloc で必要な分だけメモリを確保する",
        description: `手札が ${String(skills.cMalloc.ownHandAtMost)} 枚以下になったターン初めに発動。ランダムなカード ${String(skills.cMalloc.cards)} 枚を一時的に手札へ追加する（使わなければターン終了時に捨て札へ）。`,
        kind: { kind: "Active" },
        condition: [{ _tag: "OwnHandAtMost", cards: skills.cMalloc.ownHandAtMost }],
        activate: { _tag: "TemporaryCards", cards: skills.cMalloc.cards },
      },
      hiddenTrait: {
        traitId: "c.null_pointer",
        displayName: "セグメンテーション違反",
        trigger: { condition: [{ _tag: "OwnHandAtMost", cards: 0 }], probability: traits.cNullPointer.probability },
        effect: { _tag: "Fizzle" },
        achievementId: "segfault",
      },
      placeholder: { color: 0x2f6fbf, emoji: "🔵" },
    },
    {
      id: "cpp",
      name: "C++",
      logoKey: "logo-cpp",
      ...encode(stats.cpp),
      skill: {
        skillId: "cpp.raii",
        displayName: "RAII",
        concept: "スコープを抜けるときにリソースを確実に解放・回収する",
        description: `HP が最大の ${pct(skills.cppRaii.hpRatioAtMost)} 以下になったターン初めに発動。このターン使ったカードをターン終了時に手札へ戻す（次のターンは使用不可）。`,
        kind: { kind: "Active" },
        condition: [{ _tag: "OwnHpRatioAtMost", ratio: skills.cppRaii.hpRatioAtMost }],
        activate: { _tag: "ReturnUsedCard" },
      },
      hiddenTrait: {
        traitId: "cpp.memory_leak",
        displayName: "解放漏れ",
        trigger: {
          condition: [{ _tag: "TurnAtLeast", turn: traits.cppMemoryLeak.turnAtLeast }],
          probability: traits.cppMemoryLeak.probability,
        },
        effect: { _tag: "ShrinkHandCapacity", cards: traits.cppMemoryLeak.cards },
        achievementId: "memory_leak",
      },
      placeholder: { color: 0x00599c, emoji: "🔷" },
    },
    {
      id: "javascript",
      name: "JavaScript",
      logoKey: "logo-javascript",
      ...encode(stats.javascript),
      skill: {
        skillId: "js.event_loop",
        displayName: "イベントループ",
        concept: "待ち時間に次の処理を割り込ませる非同期実行",
        description: `${String(skills.jsEventLoop.turnAtLeast)} ターン目以降、手札が ${String(skills.jsEventLoop.ownHandAtLeast)} 枚以上なら発動。相手の手を見てから追加で 1 手出し、どちらかが勝てば勝ち（手札 2 枚消費）。`,
        kind: { kind: "Active" },
        condition: [
          { _tag: "OwnHandAtLeast", cards: skills.jsEventLoop.ownHandAtLeast },
          { _tag: "TurnAtLeast", turn: skills.jsEventLoop.turnAtLeast },
        ],
        activate: { _tag: "ExtraMove" },
      },
      hiddenTrait: {
        traitId: "js.undefined",
        displayName: "undefined is not a function",
        trigger: {
          condition: [{ _tag: "OwnHandAtMost", cards: traits.jsUndefined.ownHandAtMost }],
          probability: traits.jsUndefined.probability,
        },
        effect: { _tag: "UndefinedMove" },
        achievementId: "undefined_is_not_a_function",
      },
      placeholder: { color: 0xf7df1e, emoji: "🟨" },
    },
    {
      id: "python",
      name: "Python",
      logoKey: "logo-python",
      ...encode(stats.python),
      skill: {
        skillId: "python.dynamic_typing",
        displayName: "動的型付け",
        concept: "実行時に中身を覗いて型を決める",
        description: `相手の手札が ${String(skills.pythonTyping.opponentHandAtMost)} 枚以下になったターン初めに発動。相手の手札内訳をこの試合中ずっと公開する。`,
        kind: { kind: "Active" },
        condition: [{ _tag: "OpponentHandAtMost", cards: skills.pythonTyping.opponentHandAtMost }],
        activate: { _tag: "RevealOpponentHand" },
      },
      hiddenTrait: null,
      placeholder: { color: 0x3776ab, emoji: "🐍" },
    },
    {
      id: "php",
      name: "PHP",
      logoKey: "logo-php",
      ...encode(stats.php),
      skill: {
        skillId: "php.request_lifecycle",
        displayName: "リクエストライフサイクル",
        concept: "リクエストごとに状態をすべて捨てて作り直す",
        description: `相手の手札が ${String(skills.phpLifecycle.opponentHandAtMost)} 枚以下になったターン初めに発動。相手の手札をランダムに ${String(skills.phpLifecycle.destroyCards)} 枚破壊し、捨て札へ送る。`,
        kind: { kind: "Active" },
        condition: [{ _tag: "OpponentHandAtMost", cards: skills.phpLifecycle.opponentHandAtMost }],
        activate: { _tag: "DestroyOpponentCards", cards: skills.phpLifecycle.destroyCards },
      },
      hiddenTrait: {
        traitId: "php.type_juggling",
        displayName: "緩やかな比較の罠",
        trigger: {
          condition: [{ _tag: "OpponentHandAtMost", cards: traits.phpTypeJuggling.opponentHandAtMost }],
          probability: traits.phpTypeJuggling.probability,
        },
        effect: { _tag: "JuggleMove" },
        achievementId: "loose_comparison",
      },
      placeholder: { color: 0x777bb4, emoji: "🐘" },
    },
  ];
};
