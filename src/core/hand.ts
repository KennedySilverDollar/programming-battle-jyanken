import { Effect, Schema } from "effect";
import { NoCardForMove } from "./errors";
import { MOVES, type Move } from "./move";
import type { Side } from "./side";

export const CardCount = Schema.Int.pipe(Schema.nonNegative());

/** 手札・初期デッキの内訳。全ての手について枚数を必ず持つ。 */
export const Hand = Schema.Struct({
  Slash: CardCount,
  Guard: CardCount,
  Step: CardCount,
});
export type Hand = typeof Hand.Type;

export const EMPTY_HAND: Hand = { Slash: 0, Guard: 0, Step: 0 };

export const handTotal = (hand: Hand): number => hand.Slash + hand.Guard + hand.Step;

export const availableMoves = (hand: Hand): readonly Move[] => MOVES.filter((m) => hand[m] > 0);

export const addCard = (hand: Hand, move: Move): Hand => ({ ...hand, [move]: hand[move] + 1 });

/** 手札から 1 枚取り除く。残っていなければ型付きエラー。 */
export const removeCard = (side: Side, hand: Hand, move: Move): Effect.Effect<Hand, NoCardForMove> =>
  hand[move] > 0 ? Effect.succeed({ ...hand, [move]: hand[move] - 1 }) : Effect.fail(new NoCardForMove({ side, move }));

export const countMoves = (moves: readonly Move[]): Hand => moves.reduce<Hand>((acc, m) => addCard(acc, m), EMPTY_HAND);
