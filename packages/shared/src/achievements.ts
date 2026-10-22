import { Context, Effect, Layer, Ref, Schema } from "effect";
import { AchievementStorageError } from "./errors";

/** 実績の静的データ。解除状態は AchievementStore が持つ。 */
export const AchievementSpec = Schema.Struct({
  achievementId: Schema.NonEmptyTrimmedString,
  title: Schema.NonEmptyTrimmedString,
  /** 解除前に実績画面で見られる 1 行のヒント。 */
  hint: Schema.NonEmptyTrimmedString,
  /** 解除後に読める、開発現場での実問題。 */
  detail: Schema.NonEmptyTrimmedString,
});
export type AchievementSpec = typeof AchievementSpec.Type;

export const AchievementList = Schema.Array(AchievementSpec).pipe(
  Schema.filter(
    (list) => new Set(list.map((a) => a.achievementId)).size === list.length || "achievementId が重複しています",
  ),
);

export interface Achievement extends AchievementSpec {
  readonly unlocked: boolean;
}

export const RAW_ACHIEVEMENTS = [
  {
    achievementId: "segfault",
    title: "セグメンテーション違反",
    hint: "C で、手に何も持たずに戦い続けると…？",
    detail:
      "CではNULL参照がそのままセグフォになる。型がNULLを許す設計が根本原因。現代は_Nonnullや静的解析で緩和するが、実行時クラッシュは避けられない。",
  },
  {
    achievementId: "memory_leak",
    title: "解放漏れ",
    hint: "C++ で長期戦に持ち込むと…？",
    detail:
      "RAIIを怠るとnewしたままdeleteを忘れ、長時間稼働でメモリが枯渇する。ValgrindやASanで検出するが、本番で発覚するとサービス停止に直結する。",
  },
  {
    achievementId: "undefined_is_not_a_function",
    title: "undefined is not a function",
    hint: "JavaScript の手札が心もとなくなると…？",
    detail:
      "型がないため、存在しないプロパティへのアクセスが実行時まで分からない。TypeScript導入の最大の動機。?.や??で緩和するが、根本解決は静的型付け。",
  },
  {
    achievementId: "loose_comparison",
    title: "緩やかな比較の罠",
    hint: "PHP で相手を追い詰めたとき、== は信用できる？",
    detail:
      '"1" == 1がtrue、"0" == falseがtrueなど、予期せぬ比較が成立する。PHP8で一部修正されたが、レガシーコードには残る。===の徹底が必須。',
  },
  {
    achievementId: "forgot_dispose",
    title: "dispose忘れ",
    hint: "Java の GC を何度も走らせると…？",
    detail:
      "SWTのColorやFontはGCの対象外で、明示的にdispose()しないとネイティブリソースが漏れる。GCがあるから安心という油断が、OSレベルのリソース枯渇を招く。",
  },
] satisfies typeof AchievementList.Encoded;

/** 実績の解除状態の永続化。本番はローカルストレージ、テストはメモリ。 */
export class AchievementStore extends Context.Tag("AchievementStore")<
  AchievementStore,
  {
    readonly unlockedIds: Effect.Effect<ReadonlySet<string>, AchievementStorageError>;
    /** 解除する。今回はじめて解除されたなら true。 */
    readonly unlock: (achievementId: string) => Effect.Effect<boolean, AchievementStorageError>;
  }
>() {}

export const memoryAchievementStore = (initial: readonly string[] = []): Layer.Layer<AchievementStore> =>
  Layer.effect(
    AchievementStore,
    Effect.map(Ref.make<ReadonlySet<string>>(new Set(initial)), (ref) => ({
      unlockedIds: Ref.get(ref),
      unlock: (id) => Ref.modify(ref, (set) => (set.has(id) ? [false, set] : [true, new Set([...set, id])])),
    })),
  );

/** 静的データと解除状態を合わせた一覧。 */
export const listAchievements = (
  specs: readonly AchievementSpec[],
): Effect.Effect<readonly Achievement[], AchievementStorageError, AchievementStore> =>
  Effect.gen(function* () {
    const store = yield* AchievementStore;
    const unlocked = yield* store.unlockedIds;
    return specs.map((s) => ({ ...s, unlocked: unlocked.has(s.achievementId) }));
  });
