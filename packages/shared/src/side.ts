import { Schema } from "effect";

/**
 * 対戦の席。P1 はルームの作成者（オフラインでは人間）、P2 は参加者（オフラインでは CPU）。
 * UI は常に「自分 = P1（左）」で描くので、オンラインで P2 の側は表示前に席を入れ替える。
 */
export const Side = Schema.Literal("P1", "P2");
export type Side = typeof Side.Type;

export const SIDES = ["P1", "P2"] satisfies readonly [Side, Side];

export const opponentOf = (side: Side): Side => {
  switch (side) {
    case "P1":
      return "P2";
    case "P2":
      return "P1";
  }
};
