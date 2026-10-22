import { Context, type Effect } from "effect";
import type { BattleEvent } from "./events";
import type { Move } from "./move";
import type { ChoiceView, ExtraChoiceView } from "./view";

/** 手を選ぶ側（人間・CPU 共通のインターフェース）。 */
export interface MoveChooser {
  readonly chooseMove: (view: ChoiceView) => Effect.Effect<Move>;
  /** JavaScript のイベントループ：相手の手を見てから追加の 1 手を選ぶ。 */
  readonly chooseExtraMove: (view: ExtraChoiceView) => Effect.Effect<Move>;
}

/** 人間プレイヤーの手選択。ホストが入力を受け付け、決定時に完了する。 */
export class PlayerInput extends Context.Tag("PlayerInput")<PlayerInput, MoveChooser>() {}

/** CPU の手選択。 */
export class CpuStrategy extends Context.Tag("CpuStrategy")<CpuStrategy, MoveChooser>() {}

/** イベント通知。返る Effect はホストが演出を終えた時点で完了する（演出待ちを兼ねる）。 */
export class BattleEvents extends Context.Tag("BattleEvents")<
  BattleEvents,
  { readonly publish: (event: BattleEvent) => Effect.Effect<void> }
>() {}
