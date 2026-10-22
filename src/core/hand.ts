import { Array as Arr, Effect, Option, Schema } from "effect";
import { NoCardForMove } from "./errors";
import { MOVES, type Move } from "./move";
import { RandomService } from "./random";
import type { Side } from "./side";

export const CardCount = Schema.Int.pipe(Schema.nonNegative());

/** 手札・初期デッキの内訳。全ての手について枚数を必ず持つ。 */
export const Hand = Schema.Struct({
  Slash: CardCount,
  Thrust: CardCount,
  Bash: CardCount,
});
export type Hand = typeof Hand.Type;

/** データ上の表記 { slash, thrust, bash } を Hand に変換する Schema。 */
export const CardSet = Schema.transform(Schema.Struct({ slash: CardCount, thrust: CardCount, bash: CardCount }), Hand, {
  strict: true,
  decode: (c) => ({ Slash: c.slash, Thrust: c.thrust, Bash: c.bash }),
  encode: (h) => ({ slash: h.Slash, thrust: h.Thrust, bash: h.Bash }),
});

export const EMPTY_HAND: Hand = { Slash: 0, Thrust: 0, Bash: 0 };

export const handTotal = (hand: Hand): number => hand.Slash + hand.Thrust + hand.Bash;

export const availableMoves = (hand: Hand): readonly Move[] => MOVES.filter((m) => hand[m] > 0);

export const addCard = (hand: Hand, move: Move): Hand => ({ ...hand, [move]: hand[move] + 1 });

/** 手札から 1 枚取り除く。残っていなければ型付きエラー。 */
export const removeCard = (side: Side, hand: Hand, move: Move): Effect.Effect<Hand, NoCardForMove> =>
  hand[move] > 0 ? Effect.succeed({ ...hand, [move]: hand[move] - 1 }) : Effect.fail(new NoCardForMove({ side, move }));

export const countMoves = (moves: readonly Move[]): Hand => moves.reduce<Hand>((acc, m) => addCard(acc, m), EMPTY_HAND);

/** 手札を 1 枚ずつ並べた配列（ランダムに 1 枚選ぶ用）。 */
export const handCards = (hand: Hand): readonly Move[] =>
  availableMoves(hand).flatMap((m) => Array.from({ length: hand[m] }, () => m));

/** 手札から枚数比例でランダムに 1 枚選ぶ。空なら None。 */
export const pickRandomCard = (hand: Hand): Effect.Effect<Option.Option<Move>, never, RandomService> => {
  const cards = handCards(hand);
  return Arr.isNonEmptyReadonlyArray(cards)
    ? Effect.flatMap(RandomService, (r) => Effect.map(r.pick(cards), Option.some))
    : Effect.succeed(Option.none());
};
