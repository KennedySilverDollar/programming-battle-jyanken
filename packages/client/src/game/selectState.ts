import { Array as Arr, Option } from "effect";
import type { CharacterSpec, CharacterRoster } from "@pbj/shared/characters";
import type { Side } from "@pbj/shared/side";

/** 対戦カード（自分と CPU のキャラ）。 */
export type Matchup = Readonly<Record<Side, CharacterSpec>>;

/**
 * キャラ選択の状態遷移。Phaser に依存しない純粋関数。
 *   PickPlayer --決定--> PickCpu --決定--> Done
 *        ^                  |
 *        +------戻る--------+
 */
export type SelectState =
  | { readonly _tag: "PickPlayer"; readonly cursor: number }
  | { readonly _tag: "PickCpu"; readonly cursor: number; readonly player: CharacterSpec }
  | { readonly _tag: "Done"; readonly matchup: Matchup };

export const initialSelect = (cursor = 0): SelectState => ({ _tag: "PickPlayer", cursor });

const wrap = (i: number, n: number): number => ((i % n) + n) % n;

export const moveCursor = (state: SelectState, delta: number, roster: CharacterRoster): SelectState => {
  switch (state._tag) {
    case "PickPlayer":
    case "PickCpu":
      return { ...state, cursor: wrap(state.cursor + delta, roster.length) };
    case "Done":
      return state;
  }
};

export const focusIndex = (state: SelectState, index: number, roster: CharacterRoster): SelectState =>
  moveCursor(state, index - (state._tag === "Done" ? 0 : state.cursor), roster);

/** カーソル位置のキャラで決定する。 */
export const confirm = (state: SelectState, roster: CharacterRoster): SelectState => {
  const chosen = Arr.get(roster, state._tag === "Done" ? 0 : state.cursor);
  switch (state._tag) {
    case "PickPlayer":
      // 相手選択は同じ位置から始める（ミラー対戦も可）
      return Option.match(chosen, {
        onNone: () => state,
        onSome: (player): SelectState => ({ _tag: "PickCpu", cursor: state.cursor, player }),
      });
    case "PickCpu":
      return Option.match(chosen, {
        onNone: () => state,
        onSome: (cpu): SelectState => ({ _tag: "Done", matchup: { Player: state.player, Cpu: cpu } }),
      });
    case "Done":
      return state;
  }
};

/** 1 段階戻る。自分の選択に戻るときは、選んでいたキャラにカーソルを戻す。 */
export const back = (state: SelectState, roster: CharacterRoster): SelectState => {
  switch (state._tag) {
    case "PickPlayer":
      return state;
    case "PickCpu":
      return initialSelect(
        Math.max(
          0,
          roster.findIndex((c) => c.id === state.player.id),
        ),
      );
    case "Done":
      return state;
  }
};

/** 現在カーソルが当たっているキャラ。 */
export const focused = (state: SelectState, roster: CharacterRoster): CharacterSpec | undefined =>
  state._tag === "Done" ? undefined : roster[state.cursor];
