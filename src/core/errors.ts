import { Data } from "effect";
import type { Move } from "./move";
import type { Side } from "./side";

/** 起動時のデータ検証失敗（キャラ定義・バランス値・起動パラメータ）。 */
export class InvalidGameData extends Data.TaggedError("InvalidGameData")<{
  readonly source: string;
  readonly message: string;
}> {}

/** 指定 ID のキャラクターが存在しない。 */
export class UnknownCharacter extends Data.TaggedError("UnknownCharacter")<{
  readonly id: string;
  readonly known: readonly string[];
}> {}

/** 手札に指定の手が残っていない。 */
export class NoCardForMove extends Data.TaggedError("NoCardForMove")<{
  readonly side: Side;
  readonly move: Move;
}> {}

/** 発動しようとしたスキルの条件が満たされていない、または使用済み。 */
export class SkillConditionNotMet extends Data.TaggedError("SkillConditionNotMet")<{
  readonly side: Side;
  readonly skill: string;
}> {}

export type StartupError = InvalidGameData | UnknownCharacter;
