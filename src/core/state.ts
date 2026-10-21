import { Effect } from "effect";
import type { CharacterDef } from "./characters";
import { countMoves, handTotal, type Hand } from "./hand";
import { MOVES, type Move } from "./move";
import { buildSkill, type Skill } from "./skills";
import { SIDES, type Side } from "./side";

export interface FighterStatus {
  /** Python「import this」発動済み：相手の手札内訳がこの試合中ずっと見える。 */
  readonly revealsOpponentHand: boolean;
  /** C++「Undefined Behavior」：このターンの与・被ダメージ倍率。ターン境界では常に 1。 */
  readonly riskMultiplier: number;
}

export interface FighterState {
  readonly side: Side;
  readonly character: CharacterDef;
  readonly hp: number;
  readonly hand: Hand;
  /** 捨て札（使用済みカード）。古い順。互いに公開。 */
  readonly discard: readonly Move[];
  readonly skill: Skill;
  readonly status: FighterStatus;
}

/** スキル効果の入出力。self から見た (自分, 相手)。 */
export interface Duel {
  readonly self: FighterState;
  readonly opponent: FighterState;
}

/** 1 試合分の状態。Ref<GameState> で管理し、直接書き換えない。 */
export interface GameState {
  /** 終了したターン数。 */
  readonly turnsPlayed: number;
  readonly fighters: Readonly<Record<Side, FighterState>>;
}

export const initialFighter = (side: Side, character: CharacterDef): FighterState => ({
  side,
  character,
  hp: character.maxHp,
  hand: character.cards,
  discard: [],
  skill: buildSkill(character.skill),
  status: { revealsOpponentHand: false, riskMultiplier: 1 },
});

/** 試合開始時の状態。HP・手札・スキル使用回数はすべてここでリセットされる。 */
export const initialGameState = (characters: Readonly<Record<Side, CharacterDef>>): GameState => ({
  turnsPlayed: 0,
  fighters: {
    Player: initialFighter("Player", characters.Player),
    Cpu: initialFighter("Cpu", characters.Cpu),
  },
});

export const withFighter = (state: GameState, fighter: FighterState): GameState => ({
  ...state,
  fighters: { ...state.fighters, [fighter.side]: fighter },
});

// ---------------------------------------------------------------------------
// 不変条件
// ---------------------------------------------------------------------------

/**
 * Effect 3 には Effect.assert が無いため同等品を定義する。
 * 偽なら回復不能な欠陥（defect）として Effect.die で落とす。
 */
export const assertInvariant = (condition: boolean, message: string): Effect.Effect<void> =>
  condition ? Effect.void : Effect.dieMessage(`Invariant violated: ${message}`);

const isCount = (n: number): boolean => Number.isInteger(n) && n >= 0;

const fighterInvariants = (f: FighterState, turnsPlayed: number): Effect.Effect<void> => {
  const who = `${f.side}(${f.character.name})`;
  const initialTotal = handTotal(f.character.cards);
  const discarded = countMoves(f.discard);
  const convertsCards = f.character.skill._tag === "Active" && f.character.skill.effect._tag === "ConvertOwnCards";
  return Effect.all(
    [
      assertInvariant(Number.isInteger(f.hp), `${who} HP が整数でない: ${String(f.hp)}`),
      assertInvariant(f.hp >= 0 && f.hp <= f.character.maxHp, `${who} HP が範囲外: ${String(f.hp)}`),
      assertInvariant(
        MOVES.every((m) => isCount(f.hand[m])),
        `${who} 手札枚数が不正: ${JSON.stringify(f.hand)}`,
      ),
      assertInvariant(
        handTotal(f.hand) + f.discard.length === initialTotal,
        `${who} 手札+捨て札が初期枚数 ${String(initialTotal)} と一致しない`,
      ),
      assertInvariant(f.discard.length === turnsPlayed, `${who} 捨て札枚数がターン数と一致しない`),
      // 手を変換するスキルを持たないなら、手ごとの枚数も保存される
      assertInvariant(
        convertsCards || MOVES.every((m) => f.hand[m] + discarded[m] === f.character.cards[m]),
        `${who} 手ごとの枚数が保存されていない`,
      ),
      assertInvariant(f.status.riskMultiplier === 1, `${who} ターン境界でダメージ倍率が残っている`),
      assertInvariant(!f.status.revealsOpponentHand || f.skill.used, `${who} 未使用スキルの効果が有効`),
      assertInvariant(f.skill.name === f.character.skill.name, `${who} スキルがキャラ定義と一致しない`),
    ],
    { discard: true },
  );
};

/** ターン境界ごとに検証する不変条件。 */
export const checkInvariants = (state: GameState): Effect.Effect<void> =>
  Effect.all(
    [
      assertInvariant(isCount(state.turnsPlayed), "turnsPlayed が不正"),
      ...SIDES.map((side) =>
        Effect.zipRight(
          assertInvariant(state.fighters[side].side === side, `fighters.${side} の side が一致しない`),
          fighterInvariants(state.fighters[side], state.turnsPlayed),
        ),
      ),
    ],
    { discard: true },
  );
