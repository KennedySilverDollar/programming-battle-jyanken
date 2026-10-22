import { Array as Arr, Effect, Option } from "effect";
import type { Balance } from "./balance";
import type { ConditionContext } from "./conditions";
import { NoCardForMove } from "./errors";
import {
  type Damage,
  type EffectiveMove,
  type RevealedPlay,
  RoundResult,
  type TurnNote,
  type TurnResult,
} from "./events";
import { addCard, handTotal } from "./hand";
import { judge, MOVES, type Move } from "./move";
import { RandomService } from "./random";
import { opponentOf, SIDES, type Side } from "./side";
import { type ActivationDetail, activationProbability, applyActivation, isEligible, type SkillId } from "./skills";
import {
  assertInvariant,
  discardRandom,
  enforceCapacity,
  type FighterState,
  type GameState,
  isBareHanded,
  isLazy,
  moveToDiscard,
  playableMoves,
  thunkTotal,
  withFighter,
} from "./state";
import { type HiddenTraitSpec, type TraitId, traitEligible } from "./traits";

/**
 * ターン解決エンジン（オフライン版とサーバーの共通部分）。
 *
 * 1 ターンは次の固定順序で解決する。乱数（RandomService）の呼び出し順もこの順序で固定され、
 * 同じ初期状態・同じ入力列・同じシードからは必ず同じ結果になる。
 *
 *   1. 両者の手を確定（カードを捨て札へ）。未選択の側はここでランダム代理選択（proxyMoves）
 *   2. スキル発動判定（Haskell → Java → その他。同じ順位なら P1 → P2）
 *   3. 隠れデメリット発動判定（キャラ ID の辞書順。同じキャラなら P1 → P2）
 *   ─ イベントループが発動していれば、ここで追加の 1 手を選ぶ（相手の手はまだ見えない）
 *   4. 三すくみ判定
 *   5. ダメージ計算（素手・STW。負値は 0、HP は 0〜maxHp）
 *   6. 状態更新（HP・手札・サンク・一時確保・RAII）
 *   7. 勝敗判定（HP 0 のみ）
 *
 * 1〜3 が beginResolution、4〜7 が finishResolution。
 * 状態は不変オブジェクトで受け渡し、呼び出し側が Ref に格納する。
 */

/** エンジンが出す出来事。state はその出来事の直後の状態（表示用のスナップショット）。 */
export type EngineEvent = (
  | {
      readonly _tag: "SkillActivated";
      readonly side: Side;
      readonly skillId: SkillId;
      readonly name: string;
      readonly description: string;
      readonly detail: ActivationDetail;
    }
  | { readonly _tag: "StopTheWorld"; readonly side: Side; readonly penalty: number }
  | {
      readonly _tag: "TraitTriggered";
      readonly side: Side;
      readonly traitId: TraitId;
      readonly displayName: string;
      readonly achievementId: string;
    }
  | { readonly _tag: "ThunksForced"; readonly side: Side; readonly total: number }
  | { readonly _tag: "MovesRevealed"; readonly plays: Readonly<Record<Side, RevealedPlay>> }
  | { readonly _tag: "ExtraMovePlayed"; readonly side: Side; readonly move: Move }
  | {
      readonly _tag: "ExchangeResolved";
      readonly winner: Side | null;
      readonly winningMove: Move | null;
      readonly damage: Damage | null;
      readonly bashDiscard: { readonly side: Side; readonly moves: readonly Move[] } | null;
      readonly thunkDropped: { readonly side: Side; readonly amount: number } | null;
    }
  | { readonly _tag: "TurnEnded"; readonly notes: readonly TurnNote[] }
) & { readonly state: GameState };

/** 手の確定（素手ならカードを消費しない）。 */
export interface Commit {
  readonly move: Move;
  readonly bare: boolean;
}

/** 3 までの解決を終え、4 以降を待っている途中経過。 */
export interface PendingTurn {
  /** ターン開始時（手を出す前）の状態。発動条件はすべてこの時点で判定する。 */
  readonly turnStart: GameState;
  readonly commits: Readonly<Record<Side, Commit>>;
  /** 隠れデメリット適用後の、実際に効く手。 */
  readonly effective: Readonly<Record<Side, EffectiveMove>>;
  /** オープン時（4 の直前）に出す隠れデメリットのイベント。 */
  readonly deferredEvents: readonly EngineEvent[];
}

export interface PhaseA {
  readonly state: GameState;
  readonly events: readonly EngineEvent[];
  readonly pending: PendingTurn;
  /** イベントループの追加の 1 手が必要な側。 */
  readonly needExtra: readonly Side[];
}

export interface PhaseB {
  readonly state: GameState;
  readonly events: readonly EngineEvent[];
  readonly result: TurnResult;
}

const turnNumber = (state: GameState): number => state.turnsPlayed + 1;

const ctxFor = (state: GameState, side: Side): ConditionContext => ({
  self: state.fighters[side],
  opponent: state.fighters[opponentOf(side)],
  turn: turnNumber(state),
});

const update = (state: GameState, side: Side, f: (fighter: FighterState) => FighterState): GameState =>
  withFighter(state, f(state.fighters[side]));

/** 途中経過で常に成り立つ不変条件（INV-1, INV-2, INV-3, INV-5）。 */
export const checkMidTurn = (state: GameState): Effect.Effect<void> =>
  Effect.forEach(
    SIDES,
    (side) => {
      const f = state.fighters[side];
      const who = `${side}(${f.character.name})`;
      const initial = handTotal(f.character.cards);
      return Effect.all(
        [
          assertInvariant(f.hp >= 0 && f.hp <= f.character.maxHp, `INV-1 ${who} HP が範囲外: ${String(f.hp)}`),
          assertInvariant(
            handTotal(f.hand) >= 0 && handTotal(f.hand) <= initial + f.created,
            `INV-2 ${who} 手札枚数が範囲外`,
          ),
          assertInvariant(
            handTotal(f.hand) + f.discard.length === initial + f.created,
            `INV-3 ${who} 捨て札＋手札が初期＋確保と一致しない`,
          ),
          assertInvariant(thunkTotal(f.lazy) >= 0, `INV-5 ${who} サンク累積が負`),
        ],
        { discard: true },
      );
    },
    { discard: true },
  );

// ---------------------------------------------------------------------------
// 1. 手の確定
// ---------------------------------------------------------------------------

export const validateMove = (f: FighterState, move: Move): Effect.Effect<Move, NoCardForMove> =>
  playableMoves(f).includes(move) ? Effect.succeed(move) : Effect.fail(new NoCardForMove({ side: f.side, move }));

/** 出せる手から一様ランダムに 1 つ（時間切れの代理選択）。 */
export const randomPlayable = (f: FighterState): Effect.Effect<Move, never, RandomService> => {
  const moves = playableMoves(f);
  return Arr.isNonEmptyReadonlyArray(moves)
    ? Effect.flatMap(RandomService, (r) => r.pick(moves))
    : Effect.dieMessage("出せる手が無い（素手なら全ての手が出せるはず）");
};

/** 選ばれなかった側をランダム代理選択で埋める（P1 → P2 の順に乱数を使う）。 */
export const proxyMoves = (
  state: GameState,
  chosen: Readonly<Record<Side, Option.Option<Move>>>,
): Effect.Effect<Readonly<Record<Side, Move>>, never, RandomService> =>
  Effect.gen(function* () {
    const fill = (side: Side): Effect.Effect<Move, never, RandomService> =>
      Option.match(chosen[side], { onNone: () => randomPlayable(state.fighters[side]), onSome: Effect.succeed });
    const p1 = yield* fill("P1");
    const p2 = yield* fill("P2");
    return { P1: p1, P2: p2 };
  });

const commitOf = (f: FighterState, move: Move): Commit => ({ move, bare: isBareHanded(f) });

const consume = (state: GameState, side: Side, commit: Commit): Effect.Effect<GameState> =>
  commit.bare
    ? Effect.succeed(state)
    : Effect.map(moveToDiscard(state.fighters[side], commit.move), (f) => withFighter(state, f));

// ---------------------------------------------------------------------------
// 強制評価
// ---------------------------------------------------------------------------

/** Haskell の手札が 0 になった瞬間、サンクをすべて強制評価する（1 試合 1 回）。 */
const forceThunksIfEmpty = (state: GameState): { state: GameState; events: EngineEvent[] } => {
  let s = state;
  const events: EngineEvent[] = [];
  for (const side of SIDES) {
    const f = s.fighters[side];
    if (!isLazy(f) || handTotal(f.hand) > 0) continue;
    const total = thunkTotal(f.lazy);
    s = update(s, side, (x) => ({ ...x, hp: Math.max(0, x.hp - total), lazy: { thunks: [], forced: true } }));
    events.push({ _tag: "ThunksForced", side, total, state: s });
  }
  return { state: s, events };
};

// ---------------------------------------------------------------------------
// 2. スキル発動判定
// ---------------------------------------------------------------------------

/** スキル判定の優先順位：Haskell → Java → その他。 */
const SKILL_PRIORITY = (f: FighterState): number =>
  f.character.id === "haskell" ? 0 : f.character.id === "java" ? 1 : 2;

/** スキル判定の順番：Haskell → Java → その他、同じなら P1 → P2。 */
export const skillOrder = (state: GameState): readonly Side[] =>
  [...SIDES].sort((a, b) => SKILL_PRIORITY(state.fighters[a]) - SKILL_PRIORITY(state.fighters[b]));

/** 隠れデメリット判定の順番：キャラ ID の辞書順、同じなら P1 → P2。 */
export const traitOrder = (state: GameState): readonly Side[] =>
  [...SIDES].sort((a, b) => {
    const x = state.fighters[a].character.id;
    const y = state.fighters[b].character.id;
    return x < y ? -1 : x > y ? 1 : 0;
  });

const resolveSkill = (
  turnStart: GameState,
  current: GameState,
  side: Side,
): Effect.Effect<{ state: GameState; events: EngineEvent[] }, never, RandomService> =>
  Effect.gen(function* () {
    const random = yield* RandomService;
    // 条件はターン開始時の手札・捨て札で判定（使用済みフラグは現在値）
    const start = turnStart.fighters[side];
    const self = current.fighters[side];
    const ctx: ConditionContext = {
      ...ctxFor(turnStart, side),
      self: { ...start, skill: self.skill },
    };
    if (!isEligible(ctx)) return { state: current, events: [] };
    const { spec } = self.skill;
    const p = activationProbability(spec.kind);
    if (p < 1 && !(yield* random.chance(p))) return { state: current, events: [] };

    const result = yield* applyActivation(spec.activate, self, current.fighters[opponentOf(side)]);
    const activated: FighterState = {
      ...result.self,
      skill: { ...result.self.skill, used: true, activations: result.self.skill.activations + 1 },
    };
    let s = withFighter(withFighter(current, activated), result.opponent);
    const events: EngineEvent[] = [
      {
        _tag: "SkillActivated",
        side,
        skillId: spec.skillId,
        name: spec.displayName,
        description: spec.description,
        detail: result.detail,
        state: s,
      },
    ];
    // Java の GC：発動したときだけ STW を判定
    if (spec.kind.kind === "RandomWithSideEffect" && spec.activate._tag === "RecycleDiscard") {
      const penalty = spec.activate.stwDamagePenalty;
      if (yield* random.chance(spec.kind.sideEffectProbability)) {
        s = update(s, side, (f) => ({ ...f, status: { ...f.status, stwPenaltyNext: penalty } }));
        events.push({ _tag: "StopTheWorld", side, penalty, state: s });
      }
    }
    const forced = forceThunksIfEmpty(s);
    return { state: forced.state, events: [...events, ...forced.events] };
  });

// ---------------------------------------------------------------------------
// 3. 隠れデメリット発動判定
// ---------------------------------------------------------------------------

const traitEvent = (side: Side, trait: HiddenTraitSpec, state: GameState): EngineEvent => ({
  _tag: "TraitTriggered",
  side,
  traitId: trait.traitId,
  displayName: trait.displayName,
  achievementId: trait.achievementId,
  state,
});

interface TraitStep {
  readonly state: GameState;
  readonly events: readonly EngineEvent[];
  readonly deferred: readonly EngineEvent[];
  readonly effective: EffectiveMove;
}

/** 条件を満たしたターンに 1 回だけ判定する。条件はターン開始時（手を出す前）の状態で見る。 */
const resolveTrait = (
  turnStart: GameState,
  current: GameState,
  side: Side,
  commit: Commit,
): Effect.Effect<TraitStep, never, RandomService> =>
  Effect.gen(function* () {
    const random = yield* RandomService;
    const base: EffectiveMove = { _tag: "Move", move: commit.move };
    const trait = turnStart.fighters[side].character.hiddenTrait;
    const ctx = {
      ...ctxFor(turnStart, side),
      self: { ...turnStart.fighters[side], skill: current.fighters[side].skill },
    };
    const timing =
      trait === null
        ? null
        : traitEligible(trait, "TurnStart", ctx)
          ? "TurnStart"
          : traitEligible(trait, "MoveOpen", ctx)
            ? "MoveOpen"
            : null;
    if (trait === null || timing === null) return { state: current, events: [], deferred: [], effective: base };
    if (!(yield* random.chance(trait.trigger.probability))) {
      return { state: current, events: [], deferred: [], effective: base };
    }
    const effect = trait.effect;
    switch (effect._tag) {
      case "ShrinkHandCapacity": {
        const f = current.fighters[side];
        const cap = Math.max(
          0,
          Math.min(
            Option.getOrElse(f.status.handCapacity, () => Number.POSITIVE_INFINITY),
            handTotal(f.hand),
          ) - effect.cards,
        );
        const shrunk = yield* enforceCapacity({ ...f, status: { ...f.status, handCapacity: Option.some(cap) } });
        const s = withFighter(current, shrunk);
        const forced = forceThunksIfEmpty(s);
        return {
          state: forced.state,
          events: [traitEvent(side, trait, s), ...forced.events],
          deferred: [],
          effective: base,
        };
      }
      case "SelfDamage": {
        const s = update(current, side, (f) => ({ ...f, hp: Math.max(0, f.hp - effect.amount) }));
        return { state: s, events: [traitEvent(side, trait, s)], deferred: [], effective: base };
      }
      case "Fizzle":
        return {
          state: current,
          events: [],
          deferred: [traitEvent(side, trait, current)],
          effective: { _tag: "Fizzle" },
        };
      case "UndefinedMove":
        return {
          state: current,
          events: [],
          deferred: [traitEvent(side, trait, current)],
          effective: { _tag: "Undefined" },
        };
      case "JuggleMove": {
        const others = MOVES.filter((m) => m !== commit.move);
        const juggled = Arr.isNonEmptyReadonlyArray(others) ? yield* random.pick(others) : commit.move;
        return {
          state: current,
          events: [],
          deferred: [traitEvent(side, trait, current)],
          effective: { _tag: "Move", move: juggled },
        };
      }
    }
  });

/**
 * 1〜3：手の確定 → スキル → 隠れデメリット。
 * moves は確定済み（代理選択も済んだ）両者の手。出せない手なら NoCardForMove。
 */
export const beginResolution = (
  state: GameState,
  moves: Readonly<Record<Side, Move>>,
): Effect.Effect<PhaseA, NoCardForMove, RandomService> =>
  Effect.gen(function* () {
    // 1. 確定。STW は「次ターン」から「このターン」へ移す
    const turnStart: GameState = {
      ...state,
      fighters: {
        P1: rotateStw(state.fighters.P1),
        P2: rotateStw(state.fighters.P2),
      },
    };
    yield* validateMove(turnStart.fighters.P1, moves.P1);
    yield* validateMove(turnStart.fighters.P2, moves.P2);
    const commits = { P1: commitOf(turnStart.fighters.P1, moves.P1), P2: commitOf(turnStart.fighters.P2, moves.P2) };
    let s = yield* consume(turnStart, "P1", commits.P1);
    s = yield* consume(s, "P2", commits.P2);
    yield* checkMidTurn(s);
    const events: EngineEvent[] = [];

    // 2. スキル
    for (const side of skillOrder(turnStart)) {
      const r = yield* resolveSkill(turnStart, s, side);
      s = r.state;
      events.push(...r.events);
      yield* checkMidTurn(s);
    }

    // 3. 隠れデメリット
    const effective: Record<Side, EffectiveMove> = {
      P1: { _tag: "Move", move: commits.P1.move },
      P2: { _tag: "Move", move: commits.P2.move },
    };
    const deferred: EngineEvent[] = [];
    for (const side of traitOrder(turnStart)) {
      const r = yield* resolveTrait(turnStart, s, side, commits[side]);
      s = r.state;
      events.push(...r.events);
      deferred.push(...r.deferred);
      effective[side] = r.effective;
      yield* checkMidTurn(s);
    }

    const needExtra = SIDES.filter((side) => {
      const f = s.fighters[side];
      return f.status.eventLoop && !isBareHanded(f) && effective[side]._tag !== "Undefined" && !anyoneDown(s);
    });
    return { state: s, events, pending: { turnStart, commits, effective, deferredEvents: deferred }, needExtra };
  });

const rotateStw = (f: FighterState): FighterState => ({
  ...f,
  status: { ...f.status, stwPenaltyNow: f.status.stwPenaltyNext, stwPenaltyNext: 0 },
});

// ---------------------------------------------------------------------------
// 4〜5. 判定とダメージ
// ---------------------------------------------------------------------------

export interface SidePlay {
  readonly primary: RevealedPlay;
  readonly extra: Option.Option<Move>;
}

const movesOf = (play: SidePlay): readonly Move[] => [
  ...(play.primary.effective._tag === "Move" ? [play.primary.effective.move] : []),
  ...Option.toArray(play.extra),
];

const beatsAny = (mine: readonly Move[], theirs: readonly Move[]): readonly Move[] =>
  mine.filter((m) => theirs.some((t) => judge(m, t) === "Win"));

export interface ExchangeWinner {
  readonly winner: Side;
  readonly move: Move;
}

/**
 * 勝敗の決定。
 * - どちらかが undefined → あいこ
 * - 片方だけ不発 → もう片方の手が一方的に通る（両方不発ならあいこ）
 * - それ以外：相手のどれかの手に勝つ手を持つ側の勝ち。両者とも勝つ手を持つなら、
 *   追加の 1 手（イベントループ）を出した側の勝ち（「1 つでも勝てば勝ち」）。それも同じならあいこ
 * - 勝った手が複数あるときはダメージが大きい方を使う
 */
export const decideExchange = (balance: Balance, plays: Readonly<Record<Side, SidePlay>>): ExchangeWinner | null => {
  const strongest = (moves: readonly Move[]): Move | undefined =>
    [...moves].sort((a, b) => balance.damage[b] - balance.damage[a])[0];
  const eff = { P1: plays.P1.primary.effective, P2: plays.P2.primary.effective };
  if (eff.P1._tag === "Undefined" || eff.P2._tag === "Undefined") return null;
  const fizzled = SIDES.filter((s) => eff[s]._tag === "Fizzle");
  if (fizzled.length === 2) return null;
  const [onlyFizzled] = fizzled;
  if (onlyFizzled !== undefined) {
    const winner = opponentOf(onlyFizzled);
    const move = strongest(movesOf(plays[winner]));
    return move === undefined ? null : { winner, move };
  }
  const winning = {
    P1: beatsAny(movesOf(plays.P1), movesOf(plays.P2)),
    P2: beatsAny(movesOf(plays.P2), movesOf(plays.P1)),
  };
  const hasExtra = { P1: Option.isSome(plays.P1.extra), P2: Option.isSome(plays.P2.extra) };
  const candidates = SIDES.filter((s) => winning[s].length > 0);
  const winner =
    candidates.length === 1
      ? candidates[0]
      : candidates.length === 2 && hasExtra.P1 !== hasExtra.P2
        ? hasExtra.P1
          ? "P1"
          : "P2"
        : undefined;
  if (winner === undefined) return null;
  const move = strongest(winning[winner]);
  return move === undefined ? null : { winner, move };
};

/** 与ダメージ：基本値 →（素手なら 1/除数、切り上げ）→ STW を引く（0 未満にはしない）。 */
export const damageFor = (balance: Balance, move: Move, attacker: FighterState, bare: boolean): number => {
  const base = balance.damage[move];
  const afterBare = bare ? Math.ceil(base / attacker.character.bareHandDivisor) : base;
  return Math.max(0, afterBare - attacker.status.stwPenaltyNow);
};

// ---------------------------------------------------------------------------
// 6. 状態更新（ターン終了処理）
// ---------------------------------------------------------------------------

/** used から一つずつ取り除き、残ったカードを返す。 */
const unusedOf = (temps: readonly Move[], used: readonly Move[]): readonly Move[] =>
  used.reduce<readonly Move[]>((acc, m) => {
    const i = acc.indexOf(m);
    return i < 0 ? acc : [...acc.slice(0, i), ...acc.slice(i + 1)];
  }, temps);

const endTurn = (
  state: GameState,
  plays: Option.Option<Readonly<Record<Side, SidePlay>>>,
): Effect.Effect<{ state: GameState; events: EngineEvent[] }, never, RandomService> =>
  Effect.gen(function* () {
    const notes: TurnNote[] = [];
    let s = state;
    for (const side of SIDES) {
      let f = s.fighters[side];
      const usedCards = Option.match(
        Option.map(plays, (p) => p[side]),
        {
          onNone: (): readonly Move[] => [],
          onSome: (p) => [...(p.primary.bare ? [] : [p.primary.chosen]), ...Option.toArray(p.extra)],
        },
      );

      // C：前のターンに確保して、このターンも使わなかったカードを捨て札へ
      const release = unusedOf(f.status.heldTemps, usedCards).filter((m) => f.hand[m] > 0);
      for (const m of release) f = yield* moveToDiscard(f, m);
      if (release.length > 0) notes.push({ _tag: "TempReleased", side, moves: release });

      // C++：このターンのロックを外し、RAII なら使ったカードを回収して次ターンだけロック
      let locked: Option.Option<Move> = Option.none();
      const returned = f.status.raiiArmed ? usedCards[0] : undefined;
      if (returned !== undefined) {
        const i = f.discard.lastIndexOf(returned);
        if (i >= 0) {
          f = { ...f, discard: [...f.discard.slice(0, i), ...f.discard.slice(i + 1)], hand: addCard(f.hand, returned) };
          locked = Option.some(returned);
          notes.push({ _tag: "RaiiReturned", side, move: returned });
        }
      }
      f = yield* enforceCapacity({
        ...f,
        status: {
          ...f.status,
          heldTemps: f.status.tempCards,
          tempCards: [],
          raiiArmed: false,
          eventLoop: false,
          stwPenaltyNow: 0,
          locked,
        },
      });
      s = withFighter(s, f);
    }
    const events: EngineEvent[] = notes.length > 0 ? [{ _tag: "TurnEnded", notes, state: s }] : [];
    s = { ...s, turnsPlayed: s.turnsPlayed + 1 };
    const forced = forceThunksIfEmpty(s);
    return { state: forced.state, events: [...events, ...forced.events] };
  });

// ---------------------------------------------------------------------------
// 7. 勝敗判定
// ---------------------------------------------------------------------------

const hpRatio = (f: FighterState): number => f.hp / f.character.maxHp;

const anyoneDown = (state: GameState): boolean => SIDES.some((s) => state.fighters[s].hp <= 0);

/** 敗北は HP 0 のみ（手札 0 は「素手」で続行）。上限ターンに達したら HP 割合で判定。 */
export const judgeRound = (state: GameState, balance: Balance): TurnResult => {
  const { P1: p, P2: c } = state.fighters;
  const pDead = p.hp <= 0;
  const cDead = c.hp <= 0;
  if (pDead && cDead) return RoundResult.Draw({ reason: "DoubleKnockout" });
  if (pDead) return RoundResult.Victory({ winner: "P2", reason: "HpDepleted" });
  if (cDead) return RoundResult.Victory({ winner: "P1", reason: "HpDepleted" });
  if (state.turnsPlayed >= balance.maxTurnsPerRound) {
    const diff = hpRatio(p) - hpRatio(c);
    if (diff === 0) return RoundResult.Draw({ reason: "TurnLimit" });
    return RoundResult.Victory({ winner: diff > 0 ? "P1" : "P2", reason: "TurnLimit" });
  }
  return { _tag: "Continue" };
};

/**
 * イベントループの追加の 1 手（両者の手の確定後・オープン前に選ぶ）を受け取り、4〜7 を解決する。
 * extras は needExtra の側だけ Some。出せない手なら NoCardForMove。
 */
export const finishResolution = (
  balance: Balance,
  phase: PhaseA,
  extras: Readonly<Record<Side, Option.Option<Move>>>,
): Effect.Effect<PhaseB, NoCardForMove, RandomService> =>
  Effect.gen(function* () {
    const { pending } = phase;
    let s = phase.state;
    const events: EngineEvent[] = [];

    // 追加の 1 手を確定
    for (const side of SIDES) {
      const extra = extras[side];
      if (Option.isNone(extra)) continue;
      yield* assertInvariant(phase.needExtra.includes(side), `${side} はイベントループが発動していない`);
      yield* validateMove(s.fighters[side], extra.value);
      s = yield* consume(s, side, { move: extra.value, bare: false });
    }
    yield* checkMidTurn(s);

    const plays: Record<Side, SidePlay> = {
      P1: {
        primary: { chosen: pending.commits.P1.move, bare: pending.commits.P1.bare, effective: pending.effective.P1 },
        extra: extras.P1,
      },
      P2: {
        primary: { chosen: pending.commits.P2.move, bare: pending.commits.P2.bare, effective: pending.effective.P2 },
        extra: extras.P2,
      },
    };

    if (anyoneDown(s)) {
      // dispose 忘れ・強制評価で倒れていたら、手は出さずにターンを終える
      const ended = yield* endTurn(s, Option.none());
      s = ended.state;
      events.push(...ended.events);
    } else {
      // オープン（両者の手・追加の 1 手・オープン時の隠れデメリット）
      events.push({ _tag: "MovesRevealed", plays: { P1: plays.P1.primary, P2: plays.P2.primary }, state: s });
      for (const side of SIDES) {
        const extra = plays[side].extra;
        if (Option.isSome(extra)) events.push({ _tag: "ExtraMovePlayed", side, move: extra.value, state: s });
      }
      events.push(...pending.deferredEvents.map((e) => ({ ...e, state: s })));

      // 4. 三すくみ判定 → 5. ダメージ
      const result = decideExchange(balance, plays);
      let damage: Damage | null = null;
      let bashDiscard: { side: Side; moves: readonly Move[] } | null = null;
      let thunkDropped: { side: Side; amount: number } | null = null;
      if (result !== null) {
        const { winner, move } = result;
        const loser = opponentOf(winner);
        const amount = damageFor(balance, move, s.fighters[winner], plays[winner].primary.bare);
        const deferred = isLazy(s.fighters[loser]);
        damage = { target: loser, amount, deferred };
        // 6. 状態更新（HP は 0〜maxHp にクランプ）
        s = update(s, loser, (f) =>
          deferred
            ? amount > 0
              ? { ...f, lazy: { ...f.lazy, thunks: [...f.lazy.thunks, amount] } }
              : f
            : { ...f, hp: Math.min(f.character.maxHp, Math.max(0, f.hp - amount)) },
        );
        if (move === "Bash" && balance.bashDiscards > 0) {
          const { fighter, moves } = yield* discardRandom(s.fighters[loser], balance.bashDiscards);
          s = withFighter(s, fighter);
          if (moves.length > 0) bashDiscard = { side: loser, moves };
        }
        const w = s.fighters[winner];
        const [oldest, ...rest] = w.lazy.thunks;
        if (isLazy(w) && oldest !== undefined) {
          s = update(s, winner, (f) => ({ ...f, lazy: { ...f.lazy, thunks: rest } }));
          thunkDropped = { side: winner, amount: oldest };
        }
      }
      events.push({
        _tag: "ExchangeResolved",
        winner: result?.winner ?? null,
        winningMove: result?.move ?? null,
        damage,
        bashDiscard,
        thunkDropped,
        state: s,
      });
      const forced = forceThunksIfEmpty(s);
      s = forced.state;
      events.push(...forced.events);
      yield* checkMidTurn(s);

      const ended = yield* endTurn(s, Option.some(plays));
      s = ended.state;
      events.push(...ended.events);
    }
    yield* checkMidTurn(s);
    return { state: s, events, result: judgeRound(s, balance) };
  });
