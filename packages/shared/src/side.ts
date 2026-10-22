import { Schema } from "effect";

/** 対戦の席。Player は人間、Cpu は思考ルーチン。 */
export const Side = Schema.Literal("Player", "Cpu");
export type Side = typeof Side.Type;

export const SIDES = ["Player", "Cpu"] satisfies readonly [Side, Side];

export const opponentOf = (side: Side): Side => {
  switch (side) {
    case "Player":
      return "Cpu";
    case "Cpu":
      return "Player";
  }
};
