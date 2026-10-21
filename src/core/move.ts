import { Schema } from "effect";

/** 三すくみの手。斬る(Slash) / 受ける(Guard) / 避ける(Step)。 */
export const Move = Schema.Literal("Slash", "Guard", "Step");
export type Move = typeof Move.Type;

/** 列挙順は UI のカーソル順でもある。 */
export const MOVES = ["Slash", "Guard", "Step"] satisfies readonly [Move, Move, Move];

/** 左側（自分）から見た勝敗。 */
export type Outcome = "Win" | "Lose" | "Draw";

/**
 * 判定テーブル。OUTCOME[self][opponent] が self から見た結果。
 * 斬る > 避ける、受ける > 斬る、避ける > 受ける。
 * Record で全 9 マスを完全定義するため、欠けたマスはコンパイルエラーになる。
 */
export const OUTCOME: Readonly<Record<Move, Readonly<Record<Move, Outcome>>>> = {
  Slash: { Slash: "Draw", Guard: "Lose", Step: "Win" },
  Guard: { Slash: "Win", Guard: "Draw", Step: "Lose" },
  Step: { Slash: "Lose", Guard: "Win", Step: "Draw" },
};

export const judge = (self: Move, opponent: Move): Outcome => OUTCOME[self][opponent];

export const MOVE_LABEL: Readonly<Record<Move, string>> = {
  Slash: "斬",
  Guard: "受",
  Step: "避",
};
