import { Data } from "effect";
import type { Move } from "./move";
import type { Side } from "./side";

/** 起動時のデータ検証失敗（キャラ定義・バランス値・実績・起動パラメータ）。 */
export class InvalidGameData extends Data.TaggedError("InvalidGameData")<{
  readonly source: string;
  readonly message: string;
}> {}

/** 指定 ID のキャラクターが存在しない。 */
export class UnknownCharacter extends Data.TaggedError("UnknownCharacter")<{
  readonly id: string;
  readonly known: readonly string[];
}> {}

/** 手札に指定の手が残っていない（または使用不可）。 */
export class NoCardForMove extends Data.TaggedError("NoCardForMove")<{
  readonly side: Side;
  readonly move: Move;
}> {}

/** 実績の保存・読み込みに失敗した（ストレージ無効・容量超過など）。ゲームは続行する。 */
export class AchievementStorageError extends Data.TaggedError("AchievementStorageError")<{
  readonly reason: string;
}> {}

export type StartupError = InvalidGameData | UnknownCharacter;
