import { Effect, Option } from "effect";
import type { CharacterSpec } from "./characters";
import { handTotal, type Hand, pickRandomCard, removeCard } from "./hand";
import { MOVES, type Move } from "./move";
import type { RandomService } from "./random";
import { SIDES, type Side } from "./side";
import { initialSkillState, isRepeatable, type SkillState } from "./skills";

/** ターン単位・試合単位の状態異常。試合開始時にすべてリセットされる。 */
export interface FighterStatus {
  /** Python「動的型付け」発動済み：相手の手札内訳がこの試合中ずっと見える。 */
  readonly revealsOpponentHand: boolean;
  /** Java の Stop The World：このターンの与ダメージから引く値。 */
  readonly stwPenaltyNow: number;
  /** Java の Stop The World：次のターンに stwPenaltyNow へ移る値。 */
  readonly stwPenaltyNext: number;
  /** C「動的メモリ確保」：このターンに追加されたカード（スキルは手選択の後に判定されるので、使えるのは次のターン）。 */
  readonly tempCards: readonly Move[];
  /** 前のターンに追加された一時確保のカード。このターンに使わなければ、ターン終了時に捨て札へ。 */
  readonly heldTemps: readonly Move[];
  /** C++「RAII」：このターン使ったカードをターン終了時に回収する。 */
  readonly raiiArmed: boolean;
  /** C++「RAII」で回収したカード。このターンは 1 枚使用不可。 */
  readonly locked: Option.Option<Move>;
  /** JavaScript「イベントループ」：このターン追加で 1 手出せる。 */
  readonly eventLoop: boolean;
  /** 隠れデメリット「解放漏れ」による手札の上限（UI には出さない）。 */
  readonly handCapacity: Option.Option<number>;
}

/** Haskell「遅延評価」のサンク。 */
export interface LazyState {
  /** 溜まった被ダメージ（古い順）。 */
  readonly thunks: readonly number[];
  /** 強制評価済み（1 試合 1 回）。以後は遅延評価しない。 */
  readonly forced: boolean;
}

export interface FighterState {
  readonly side: Side;
  readonly character: CharacterSpec;
  readonly hp: number;
  readonly hand: Hand;
  /** 捨て札（使用済み・破壊されたカード）。古い順。互いに公開。 */
  readonly discard: readonly Move[];
  /** 試合中に新しく生成されたカード（C の一時確保）。枚数保存の検証に使う。 */
  readonly created: number;
  readonly skill: SkillState;
  readonly lazy: LazyState;
  readonly status: FighterStatus;
}

/** 1 試合分の状態。Ref<GameState> で管理し、直接書き換えない。 */
export interface GameState {
  /** 何試合目か（1 始まり）。 */
  readonly round: number;
  /** 終了したターン数。 */
  readonly turnsPlayed: number;
  readonly fighters: Readonly<Record<Side, FighterState>>;
}

/** マッチ（ベストオブ N）全体の状態。 */
export interface MatchState {
  readonly round: number;
  readonly wins: Readonly<Record<Side, number>>;
}

export const INITIAL_STATUS: FighterStatus = {
  revealsOpponentHand: false,
  stwPenaltyNow: 0,
  stwPenaltyNext: 0,
  tempCards: [],
  heldTemps: [],
  raiiArmed: false,
  locked: Option.none(),
  eventLoop: false,
  handCapacity: Option.none(),
};

export const initialFighter = (side: Side, character: CharacterSpec): FighterState => ({
  side,
  character,
  hp: character.maxHp,
  hand: character.cards,
  discard: [],
  created: 0,
  skill: initialSkillState(character.skill),
  lazy: { thunks: [], forced: false },
  status: INITIAL_STATUS,
});

/** 試合開始時の状態。HP・手札・スキル使用回数・隠れデメリットの累積はすべてここでリセットされる。 */
export const initialGameState = (characters: Readonly<Record<Side, CharacterSpec>>, round = 1): GameState => ({
  round,
  turnsPlayed: 0,
  fighters: {
    P1: initialFighter("P1", characters.P1),
    P2: initialFighter("P2", characters.P2),
  },
});

export const withFighter = (state: GameState, fighter: FighterState): GameState => ({
  ...state,
  fighters: { ...state.fighters, [fighter.side]: fighter },
});

// ---------------------------------------------------------------------------
// 手札まわり
// ---------------------------------------------------------------------------

/** 手札 0 の状態。手札を消費せずに好きな手を出せるが、与ダメージが減る。 */
export const isBareHanded = (f: FighterState): boolean => handTotal(f.hand) === 0;

/** このターン出せる手。素手ならすべて、そうでなければ手札にある手（RAII で回収した 1 枚は除く）。 */
export const playableMoves = (f: FighterState): readonly Move[] => {
  if (isBareHanded(f)) return MOVES;
  const usable = (m: Move): number =>
    f.hand[m] - Option.match(f.status.locked, { onNone: () => 0, onSome: (l) => (l === m ? 1 : 0) });
  const moves = MOVES.filter((m) => usable(m) > 0);
  // 回収したカードしか残っていなければ、ロックは無視する（出せる手が無くなるのを防ぐ）
  return moves.length > 0 ? moves : MOVES.filter((m) => f.hand[m] > 0);
};

/** 手札の 1 枚を捨て札へ送る。 */
export const moveToDiscard = (f: FighterState, move: Move): Effect.Effect<FighterState> =>
  removeCard(f.side, f.hand, move).pipe(
    Effect.map((hand) => ({ ...f, hand, discard: [...f.discard, move] })),
    Effect.orDieWith((e) => `手札にない手を捨て札へ送ろうとした: ${e.side} ${e.move}`),
  );

/** 手札からランダムに n 枚を捨て札へ送る。送ったカードを返す。 */
export const discardRandom = (
  f: FighterState,
  n: number,
): Effect.Effect<{ readonly fighter: FighterState; readonly moves: readonly Move[] }, never, RandomService> =>
  Effect.gen(function* () {
    let fighter = f;
    const moves: Move[] = [];
    for (let i = 0; i < n; i++) {
      const card = yield* pickRandomCard(fighter.hand);
      if (Option.isNone(card)) break;
      fighter = yield* moveToDiscard(fighter, card.value);
      moves.push(card.value);
    }
    return { fighter, moves };
  });

/** 手札の上限（解放漏れ）を超えた分をランダムに捨て札へ送る。 */
export const enforceCapacity = (f: FighterState): Effect.Effect<FighterState, never, RandomService> =>
  Option.match(f.status.handCapacity, {
    onNone: () => Effect.succeed(f),
    onSome: (cap) => Effect.map(discardRandom(f, Math.max(0, handTotal(f.hand) - cap)), ({ fighter }) => fighter),
  });

export const thunkTotal = (lazy: LazyState): number => lazy.thunks.reduce((a, b) => a + b, 0);

/** 遅延評価がまだ有効か（Haskell で、強制評価前）。 */
export const isLazy = (f: FighterState): boolean => f.skill.spec.activate._tag === "LazyEvaluation" && !f.lazy.forced;

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

const fighterInvariants = (f: FighterState): Effect.Effect<void> => {
  const who = `${f.side}(${f.character.name})`;
  const initialTotal = handTotal(f.character.cards);
  const { spec, used, activations } = f.skill;
  const lazySkill = spec.activate._tag === "LazyEvaluation";
  return Effect.all(
    [
      // HP 範囲
      assertInvariant(Number.isInteger(f.hp), `${who} HP が整数でない: ${String(f.hp)}`),
      assertInvariant(f.hp >= 0 && f.hp <= f.character.maxHp, `${who} HP が範囲外: ${String(f.hp)}`),
      // 手札枚数
      assertInvariant(
        MOVES.every((m) => isCount(f.hand[m])),
        `${who} 手札枚数が不正: ${JSON.stringify(f.hand)}`,
      ),
      Option.match(f.status.handCapacity, {
        onNone: () => Effect.void,
        onSome: (cap) => assertInvariant(isCount(cap) && handTotal(f.hand) <= cap, `${who} 手札が上限を超えている`),
      }),
      // 捨て札合計：手札＋捨て札＝初期枚数＋生成枚数（GC・RAII・破壊は移動なので保存される）
      assertInvariant(
        handTotal(f.hand) + f.discard.length === initialTotal + f.created,
        `${who} 手札+捨て札 (${String(handTotal(f.hand) + f.discard.length)}) が初期+生成 (${String(initialTotal + f.created)}) と一致しない`,
      ),
      // used フラグ
      assertInvariant(isCount(activations), `${who} 発動回数が不正`),
      assertInvariant(
        isRepeatable(spec.kind) || activations <= 1,
        `${who} 1 回きりのスキルが ${String(activations)} 回発動している`,
      ),
      assertInvariant(isRepeatable(spec.kind) || used === activations > 0, `${who} used と発動回数が食い違う`),
      assertInvariant(!f.status.revealsOpponentHand || used, `${who} 未使用スキルの効果が有効`),
      // サンク累積ダメージ
      assertInvariant(
        lazySkill || (f.lazy.thunks.length === 0 && !f.lazy.forced),
        `${who} 遅延評価でないのにサンクがある`,
      ),
      assertInvariant(
        f.lazy.thunks.every((t) => Number.isInteger(t) && t > 0),
        `${who} サンクの値が不正: ${JSON.stringify(f.lazy.thunks)}`,
      ),
      assertInvariant(!f.lazy.forced || f.lazy.thunks.length === 0, `${who} 強制評価後にサンクが残っている`),
      // ターン境界ではターン限りの効果は残らない
      assertInvariant(f.status.tempCards.length === 0, `${who} 一時確保のカードがターンをまたいだ`),
      assertInvariant(!f.status.raiiArmed && !f.status.eventLoop, `${who} ターン限りの効果がターンをまたいだ`),
      assertInvariant(f.status.stwPenaltyNow === 0, `${who} STW のペナルティがターン境界で残っている`),
    ],
    { discard: true },
  );
};

/** ターン境界ごとに検証する不変条件。 */
export const checkInvariants = (state: GameState): Effect.Effect<void> =>
  Effect.all(
    [
      assertInvariant(isCount(state.turnsPlayed), "turnsPlayed が不正"),
      assertInvariant(Number.isInteger(state.round) && state.round >= 1, "round が不正"),
      ...SIDES.map((side) =>
        Effect.zipRight(
          assertInvariant(state.fighters[side].side === side, `fighters.${side} の side が一致しない`),
          fighterInvariants(state.fighters[side]),
        ),
      ),
    ],
    { discard: true },
  );
