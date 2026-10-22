import { Schema } from "effect";

/** 三すくみの手。斬撃(Slash) / 刺突(Thrust) / 打撃(Bash)。 */
export const Move = Schema.Literal("Slash", "Thrust", "Bash");
export type Move = typeof Move.Type;

/** 列挙順は UI のカーソル順でもある。 */
export const MOVES = ["Slash", "Thrust", "Bash"] satisfies readonly [Move, Move, Move];

/** 左側（自分）から見た勝敗。 */
export type Outcome = "Win" | "Lose" | "Draw";

/**
 * 判定テーブル。OUTCOME[self][opponent] が self から見た結果。
 * 斬撃 > 刺突 > 打撃 > 斬撃。
 * Record で全 9 マスを完全定義するため、欠けたマスはコンパイルエラーになる。
 */
export const OUTCOME: Readonly<Record<Move, Readonly<Record<Move, Outcome>>>> = {
  Slash: { Slash: "Draw", Thrust: "Win", Bash: "Lose" },
  Thrust: { Slash: "Lose", Thrust: "Draw", Bash: "Win" },
  Bash: { Slash: "Win", Thrust: "Lose", Bash: "Draw" },
};

export const judge = (self: Move, opponent: Move): Outcome => OUTCOME[self][opponent];

/** 手札カードなどに使う 1 文字表記。 */
export const MOVE_LABEL: Readonly<Record<Move, string>> = { Slash: "斬", Thrust: "突", Bash: "打" };

/** 正式名。 */
export const MOVE_NAME: Readonly<Record<Move, string>> = { Slash: "斬撃", Thrust: "刺突", Bash: "打撃" };

/** move に勝つ手。 */
export const counterOf = (move: Move): Move => {
  switch (move) {
    case "Slash":
      return "Bash";
    case "Thrust":
      return "Slash";
    case "Bash":
      return "Thrust";
  }
};
