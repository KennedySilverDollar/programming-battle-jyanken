import { Array as Arr, Effect, Option, Ref } from "effect";
import { AchievementStore } from "./achievements";
import type { Balance } from "./balance";
import type { CharacterSpec } from "./characters";
import { NoCardForMove } from "./errors";
import { BattleEvent, type Damage, type RevealedPlay, RoundResult, type TurnNote, type TurnResult } from "./events";
import { addCard, handTotal } from "./hand";
import { judge, MOVES, type Move, type Outcome } from "./move";
import { RandomService } from "./random";
import { BattleEvents, CpuStrategy, type MoveChooser, PlayerInput } from "./services";
import { opponentOf, SIDES, type Side } from "./side";
import { activationProbability, applyActivation, isEligible } from "./skills";
import {
  assertInvariant,
  checkInvariants,
  discardRandom,
  enforceCapacity,
  type FighterState,
  type GameState,
  initialGameState,
  isBareHanded,
  isLazy,
  type MatchState,
  moveToDiscard,
  playableMoves,
  thunkTotal,
  withFighter,
} from "./state";
import { type HiddenTraitSpec, traitEligible, type TraitTiming } from "./traits";
import { type BattleView, battleView, choiceView, extraChoiceView } from "./view";

export interface MatchSetup {
  readonly balance: Balance;
  readonly characters: Readonly<Record<Side, CharacterSpec>>;
}

export type BattleEnv = RandomService | PlayerInput | CpuStrategy | BattleEvents | AchievementStore;

type StateRef = Ref.Ref<GameState>;

const publish = (
  event: (view: BattleView) => BattleEvent,
  state: GameState,
): Effect.Effect<void, never, BattleEvents> =>
  Effect.flatMap(BattleEvents, (events) => events.publish(event(battleView(state, "Player"))));

const turnNumber = (state: GameState): number => state.turnsPlayed + 1;

const ctxFor = (state: GameState, side: Side) => ({
  self: state.fighters[side],
  opponent: state.fighters[opponentOf(side)],
  turn: turnNumber(state),
});

const update = (ref: StateRef, side: Side, f: (fighter: FighterState) => FighterState): Effect.Effect<GameState> =>
  Ref.updateAndGet(ref, (s) => withFighter(s, f(s.fighters[side])));

// ---------------------------------------------------------------------------
// 隠れデメリット
// ---------------------------------------------------------------------------

/** 条件と確率を判定し、成立した隠れデメリットを返す（まだ公表しない）。 */
const rollTrait = (
  state: GameState,
  side: Side,
  timing: TraitTiming,
): Effect.Effect<Option.Option<HiddenTraitSpec>, never, RandomService> =>
  Effect.gen(function* () {
    const trait = state.fighters[side].character.hiddenTrait;
    if (trait === null || !traitEligible(trait, timing, ctxFor(state, side))) return Option.none();
    const random = yield* RandomService;
    return (yield* random.chance(trait.trigger.probability)) ? Option.some(trait) : Option.none();
  });

/** 実績を解除して公表する。ストレージの失敗はゲームを止めない（初回扱いにしない）。 */
const announceTrait = (
  ref: StateRef,
  side: Side,
  trait: HiddenTraitSpec,
): Effect.Effect<void, never, AchievementStore | BattleEvents> =>
  Effect.gen(function* () {
    const store = yield* AchievementStore;
    const firstUnlock = yield* store
      .unlock(trait.achievementId)
      .pipe(
        Effect.catchTag("AchievementStorageError", (e) =>
          Effect.as(Effect.logWarning(`実績を保存できませんでした: ${e.reason}`), false),
        ),
      );
    const state = yield* Ref.get(ref);
    yield* publish(
      (view) =>
        BattleEvent.TraitTriggered({
          side,
          traitId: trait.traitId,
          displayName: trait.displayName,
          achievementId: trait.achievementId,
          firstUnlock,
          view,
        }),
      state,
    );
  });

// ---------------------------------------------------------------------------
// 1. ターン初め：スキル判定 → 隠れデメリット（ターン初め）
// ---------------------------------------------------------------------------

/** STW のペナルティを「次ターン」から「このターン」へ移す。 */
const beginTurn = (ref: StateRef): Effect.Effect<void> =>
  Effect.forEach(SIDES, (side) =>
    update(ref, side, (f) => ({
      ...f,
      status: { ...f.status, stwPenaltyNow: f.status.stwPenaltyNext, stwPenaltyNext: 0 },
    })),
  ).pipe(Effect.asVoid);

/** Haskell の手札が 0 になった瞬間、サンクをすべて強制評価する（1 試合 1 回）。 */
const forceThunksIfEmpty = (ref: StateRef): Effect.Effect<void, never, BattleEvents> =>
  Effect.forEach(SIDES, (side) =>
    Effect.gen(function* () {
      const f = (yield* Ref.get(ref)).fighters[side];
      if (!isLazy(f) || handTotal(f.hand) > 0) return;
      const total = thunkTotal(f.lazy);
      const next = yield* update(ref, side, (x) => ({
        ...x,
        hp: Math.max(0, x.hp - total),
        lazy: { thunks: [], forced: true },
      }));
      yield* publish((view) => BattleEvent.ThunksForced({ side, total, view }), next);
    }),
  ).pipe(Effect.asVoid);

const resolveSkills = (ref: StateRef): Effect.Effect<void, never, RandomService | BattleEvents> =>
  Effect.forEach(SIDES, (side) =>
    Effect.gen(function* () {
      const random = yield* RandomService;
      const state = yield* Ref.get(ref);
      const ctx = ctxFor(state, side);
      if (!isEligible(ctx)) return;
      const { spec } = ctx.self.skill;
      const p = activationProbability(spec.kind);
      if (p < 1 && !(yield* random.chance(p))) return;

      const result = yield* applyActivation(spec.activate, ctx.self, ctx.opponent);
      const self: FighterState = {
        ...result.self,
        skill: { ...result.self.skill, used: true, activations: result.self.skill.activations + 1 },
      };
      const next = withFighter(withFighter(state, self), result.opponent);
      yield* Ref.set(ref, next);
      yield* publish(
        (view) =>
          BattleEvent.SkillActivated({
            side,
            skillId: spec.skillId,
            name: spec.displayName,
            description: spec.description,
            detail: result.detail,
            view,
          }),
        next,
      );

      // Java の GC：副作用の Stop The World
      if (spec.kind.kind === "RandomWithSideEffect" && spec.activate._tag === "RecycleDiscard") {
        const penalty = spec.activate.stwDamagePenalty;
        if (yield* random.chance(spec.kind.sideEffectProbability)) {
          const stw = yield* update(ref, side, (f) => ({ ...f, status: { ...f.status, stwPenaltyNext: penalty } }));
          yield* publish((view) => BattleEvent.StopTheWorld({ side, penalty, view }), stw);
        }
      }
      // PHP が相手の手札を 0 にしたら、遅延評価はここで強制される
      yield* forceThunksIfEmpty(ref);
    }),
  ).pipe(Effect.asVoid);

const resolveTurnStartTraits = (
  ref: StateRef,
): Effect.Effect<void, never, RandomService | BattleEvents | AchievementStore> =>
  Effect.forEach(SIDES, (side) =>
    Effect.gen(function* () {
      const trait = yield* rollTrait(yield* Ref.get(ref), side, "TurnStart");
      if (Option.isNone(trait)) return;
      const effect = trait.value.effect;
      switch (effect._tag) {
        case "ShrinkHandCapacity": {
          const f = (yield* Ref.get(ref)).fighters[side];
          const current = Option.getOrElse(f.status.handCapacity, () => Number.POSITIVE_INFINITY);
          const cap = Math.max(0, Math.min(current, handTotal(f.hand)) - effect.cards);
          const shrunk = yield* enforceCapacity({ ...f, status: { ...f.status, handCapacity: Option.some(cap) } });
          yield* Ref.update(ref, (s) => withFighter(s, shrunk));
          break;
        }
        case "SelfDamage":
          yield* update(ref, side, (f) => ({ ...f, hp: Math.max(0, f.hp - effect.amount) }));
          break;
        case "Fizzle":
        case "UndefinedMove":
        case "JuggleMove":
          return yield* Effect.dieMessage(`${effect._tag} はオープン時の隠れデメリット`);
      }
      yield* announceTrait(ref, side, trait.value);
      yield* forceThunksIfEmpty(ref);
    }),
  ).pipe(Effect.asVoid);

// ---------------------------------------------------------------------------
// 2. 手選択（伏せ）
// ---------------------------------------------------------------------------

interface Choice {
  readonly move: Move;
  readonly bare: boolean;
}

const validate = (f: FighterState, move: Move): Effect.Effect<Move, NoCardForMove> =>
  playableMoves(f).includes(move) ? Effect.succeed(move) : Effect.fail(new NoCardForMove({ side: f.side, move }));

/** 選ばせて検証する。手札にない手が来たら（UI 側のバグ等）選び直させる。 */
const askUntilValid = (
  chooser: Effect.Effect<Move>,
  fighter: () => Effect.Effect<FighterState>,
): Effect.Effect<Move> => {
  const ask: Effect.Effect<Move> = chooser.pipe(
    Effect.flatMap((move) => Effect.flatMap(fighter(), (f) => validate(f, move))),
    Effect.catchTag("NoCardForMove", () => Effect.suspend(() => ask)),
  );
  return ask;
};

const chooserFor = (side: Side): Effect.Effect<MoveChooser, never, PlayerInput | CpuStrategy> => {
  switch (side) {
    case "Player":
      return PlayerInput;
    case "Cpu":
      return CpuStrategy;
  }
};

const chooseMoves = (ref: StateRef): Effect.Effect<Readonly<Record<Side, Choice>>, never, PlayerInput | CpuStrategy> =>
  Effect.gen(function* () {
    const state = yield* Ref.get(ref);
    const current = (side: Side) => Effect.map(Ref.get(ref), (s) => s.fighters[side]);
    // CPU が先に伏せる（見えないので順序は結果に影響しない）
    const cpu = yield* chooserFor("Cpu");
    const cpuMove = yield* cpu.chooseMove(choiceView(state, "Cpu")).pipe(
      Effect.flatMap((m) => validate(state.fighters.Cpu, m)),
      Effect.orDieWith((e) => `CPU が出せない手を選んだ: ${e.move}`),
    );
    const player = yield* chooserFor("Player");
    const playerMove = yield* askUntilValid(player.chooseMove(choiceView(state, "Player")), () => current("Player"));
    return {
      Player: { move: playerMove, bare: isBareHanded(state.fighters.Player) },
      Cpu: { move: cpuMove, bare: isBareHanded(state.fighters.Cpu) },
    };
  });

/** カードを消費する（素手なら消費しない）。 */
const consume = (ref: StateRef, side: Side, choice: Choice): Effect.Effect<void> =>
  choice.bare
    ? Effect.void
    : Effect.flatMap(Ref.get(ref), (s) =>
        Effect.flatMap(moveToDiscard(s.fighters[side], choice.move), (f) => Ref.update(ref, (x) => withFighter(x, f))),
      );

// ---------------------------------------------------------------------------
// 3. オープン：隠れデメリット（オープン時）→ イベントループの追加の 1 手
// ---------------------------------------------------------------------------

interface SidePlay {
  readonly primary: RevealedPlay;
  readonly extra: Option.Option<Move>;
}

const openMoves = (
  ref: StateRef,
  choices: Readonly<Record<Side, Choice>>,
): Effect.Effect<Readonly<Record<Side, SidePlay>>, never, BattleEnv> =>
  Effect.gen(function* () {
    const random = yield* RandomService;
    // 隠れデメリットの条件（「手札 0 のターン」など）は、手を選んだ時点＝消費前の手札で判定する
    const beforeConsume = yield* Ref.get(ref);
    yield* consume(ref, "Player", choices.Player);
    yield* consume(ref, "Cpu", choices.Cpu);

    const afterConsume = yield* Ref.get(ref);
    const triggered: { side: Side; trait: HiddenTraitSpec }[] = [];
    const reveal = (side: Side): Effect.Effect<RevealedPlay, never, RandomService> =>
      Effect.gen(function* () {
        const { move, bare } = choices[side];
        const trait = yield* rollTrait(beforeConsume, side, "MoveOpen");
        if (Option.isNone(trait)) return { chosen: move, bare, effective: { _tag: "Move", move } };
        triggered.push({ side, trait: trait.value });
        const effect = trait.value.effect;
        switch (effect._tag) {
          case "Fizzle":
            return { chosen: move, bare, effective: { _tag: "Fizzle" } };
          case "UndefinedMove":
            return { chosen: move, bare, effective: { _tag: "Undefined" } };
          case "JuggleMove": {
            const others = MOVES.filter((m) => m !== move);
            const juggled = Arr.isNonEmptyReadonlyArray(others) ? yield* random.pick(others) : move;
            return { chosen: move, bare, effective: { _tag: "Move", move: juggled } };
          }
          case "ShrinkHandCapacity":
          case "SelfDamage":
            return yield* Effect.dieMessage(`${effect._tag} はターン初めの隠れデメリット`);
        }
      });
    const plays = { Player: yield* reveal("Player"), Cpu: yield* reveal("Cpu") };
    yield* publish((view) => BattleEvent.MovesRevealed({ plays, view }), afterConsume);
    for (const { side, trait } of triggered) yield* announceTrait(ref, side, trait);

    // イベントループ：相手のオープン済みの手を見て追加の 1 手（undefined になった手には続かない）
    const extra = (side: Side): Effect.Effect<Option.Option<Move>, never, BattleEnv> =>
      Effect.gen(function* () {
        const state = yield* Ref.get(ref);
        const f = state.fighters[side];
        if (!f.status.eventLoop || isBareHanded(f) || plays[side].effective._tag === "Undefined") return Option.none();
        const chooser = yield* chooserFor(side);
        const view = extraChoiceView(state, side, plays[opponentOf(side)].effective);
        const move = yield* askUntilValid(chooser.chooseExtraMove(view), () =>
          Effect.map(Ref.get(ref), (s) => s.fighters[side]),
        );
        yield* consume(ref, side, { move, bare: false });
        yield* publish((v) => BattleEvent.ExtraMovePlayed({ side, move, view: v }), yield* Ref.get(ref));
        return Option.some(move);
      });
    const extras = { Player: yield* extra("Player"), Cpu: yield* extra("Cpu") };
    return {
      Player: { primary: plays.Player, extra: extras.Player },
      Cpu: { primary: plays.Cpu, extra: extras.Cpu },
    };
  });

// ---------------------------------------------------------------------------
// 4. ダメージ
// ---------------------------------------------------------------------------

const movesOf = (play: SidePlay): readonly Move[] => [
  ...(play.primary.effective._tag === "Move" ? [play.primary.effective.move] : []),
  ...Option.toArray(play.extra),
];

const beatsAny = (mine: readonly Move[], theirs: readonly Move[]): readonly Move[] =>
  mine.filter((m) => theirs.some((t) => judge(m, t) === "Win"));

interface ExchangeWinner {
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
  const eff = { Player: plays.Player.primary.effective, Cpu: plays.Cpu.primary.effective };
  if (eff.Player._tag === "Undefined" || eff.Cpu._tag === "Undefined") return null;
  const fizzled = SIDES.filter((s) => eff[s]._tag === "Fizzle");
  if (fizzled.length === 2) return null;
  const [onlyFizzled] = fizzled;
  if (onlyFizzled !== undefined) {
    const winner = opponentOf(onlyFizzled);
    const move = strongest(movesOf(plays[winner]));
    return move === undefined ? null : { winner, move };
  }
  const winning = {
    Player: beatsAny(movesOf(plays.Player), movesOf(plays.Cpu)),
    Cpu: beatsAny(movesOf(plays.Cpu), movesOf(plays.Player)),
  };
  const hasExtra = { Player: Option.isSome(plays.Player.extra), Cpu: Option.isSome(plays.Cpu.extra) };
  const candidates = SIDES.filter((s) => winning[s].length > 0);
  const winner =
    candidates.length === 1
      ? candidates[0]
      : candidates.length === 2 && hasExtra.Player !== hasExtra.Cpu
        ? hasExtra.Player
          ? "Player"
          : "Cpu"
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

const resolveExchange = (
  ref: StateRef,
  balance: Balance,
  plays: Readonly<Record<Side, SidePlay>>,
): Effect.Effect<void, never, RandomService | BattleEvents> =>
  Effect.gen(function* () {
    const result = decideExchange(balance, plays);
    const outcomeFor = (side: Side): Outcome => (result === null ? "Draw" : result.winner === side ? "Win" : "Lose");
    let damage: Damage | null = null;
    let bashDiscard: { side: Side; moves: readonly Move[] } | null = null;
    let thunkDropped: { side: Side; amount: number } | null = null;

    if (result !== null) {
      const { winner, move } = result;
      const loser = opponentOf(winner);
      const state = yield* Ref.get(ref);
      const amount = damageFor(balance, move, state.fighters[winner], plays[winner].primary.bare);
      const target = state.fighters[loser];
      const deferred = isLazy(target);
      damage = { target: loser, amount, deferred };
      yield* update(ref, loser, (f) =>
        deferred
          ? amount > 0
            ? { ...f, lazy: { ...f.lazy, thunks: [...f.lazy.thunks, amount] } }
            : f
          : { ...f, hp: Math.max(0, f.hp - amount) },
      );
      // 打撃：相手の手札を捨て札へ
      if (move === "Bash" && balance.bashDiscards > 0) {
        const f = (yield* Ref.get(ref)).fighters[loser];
        const { fighter, moves } = yield* discardRandom(f, balance.bashDiscards);
        yield* Ref.update(ref, (s) => withFighter(s, fighter));
        if (moves.length > 0) bashDiscard = { side: loser, moves };
      }
      // 遅延評価側が勝ったら、最も古いサンクを 1 つ破棄
      const w = (yield* Ref.get(ref)).fighters[winner];
      const [oldest, ...rest] = w.lazy.thunks;
      if (isLazy(w) && oldest !== undefined) {
        yield* update(ref, winner, (f) => ({ ...f, lazy: { ...f.lazy, thunks: rest } }));
        thunkDropped = { side: winner, amount: oldest };
      }
    }
    const next = yield* Ref.get(ref);
    yield* publish(
      (view) =>
        BattleEvent.ExchangeResolved({
          outcome: outcomeFor("Player"),
          winningMove: result?.move ?? null,
          damage,
          bashDiscard,
          thunkDropped,
          view,
        }),
      next,
    );
    yield* forceThunksIfEmpty(ref);
  });

// ---------------------------------------------------------------------------
// 5. ターン終了：一時確保の解放・RAII の回収・ターン限りの効果の解除
// ---------------------------------------------------------------------------

/** used から一つずつ取り除き、残った一時確保のカードを返す。 */
const unusedTemps = (temps: readonly Move[], used: readonly Move[]): readonly Move[] =>
  used.reduce<readonly Move[]>((acc, m) => {
    const i = acc.indexOf(m);
    return i < 0 ? acc : [...acc.slice(0, i), ...acc.slice(i + 1)];
  }, temps);

const endTurn = (
  ref: StateRef,
  plays: Option.Option<Readonly<Record<Side, SidePlay>>>,
): Effect.Effect<void, never, RandomService | BattleEvents> =>
  Effect.gen(function* () {
    const notes: TurnNote[] = [];
    for (const side of SIDES) {
      let f = (yield* Ref.get(ref)).fighters[side];
      const play = Option.map(plays, (p) => p[side]);
      const usedCards = Option.match(play, {
        onNone: () => [],
        onSome: (p) => [...(p.primary.bare ? [] : [p.primary.chosen]), ...Option.toArray(p.extra)],
      });

      // C：使わなかった一時確保のカードを捨て札へ
      const release = unusedTemps(f.status.tempCards, usedCards).filter((m) => f.hand[m] > 0);
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
        status: { ...f.status, tempCards: [], raiiArmed: false, eventLoop: false, stwPenaltyNow: 0, locked },
      });
      yield* Ref.update(ref, (s) => withFighter(s, f));
    }
    if (notes.length > 0) yield* publish((view) => BattleEvent.TurnEnded({ notes, view }), yield* Ref.get(ref));
    yield* Ref.update(ref, (s) => ({ ...s, turnsPlayed: s.turnsPlayed + 1 }));
    yield* forceThunksIfEmpty(ref);
  });

// ---------------------------------------------------------------------------
// 6. 勝敗判定
// ---------------------------------------------------------------------------

const hpRatio = (f: FighterState): number => f.hp / f.character.maxHp;

/** 敗北は HP 0 のみ（手札 0 は「素手」で続行）。上限ターンに達したら HP 割合で判定。 */
export const judgeRound = (state: GameState, balance: Balance): TurnResult => {
  const { Player: p, Cpu: c } = state.fighters;
  const pDead = p.hp <= 0;
  const cDead = c.hp <= 0;
  if (pDead && cDead) return RoundResult.Draw({ reason: "DoubleKnockout" });
  if (pDead) return RoundResult.Victory({ winner: "Cpu", reason: "HpDepleted" });
  if (cDead) return RoundResult.Victory({ winner: "Player", reason: "HpDepleted" });
  if (state.turnsPlayed >= balance.maxTurnsPerRound) {
    const diff = hpRatio(p) - hpRatio(c);
    if (diff === 0) return RoundResult.Draw({ reason: "TurnLimit" });
    return RoundResult.Victory({ winner: diff > 0 ? "Player" : "Cpu", reason: "TurnLimit" });
  }
  return { _tag: "Continue" };
};

const anyoneDown = (state: GameState): boolean => SIDES.some((s) => state.fighters[s].hp <= 0);

// ---------------------------------------------------------------------------
// ターン・試合・マッチ
// ---------------------------------------------------------------------------

/** 1 ターン：スキル判定 → 手選択 → オープン → ダメージ → 勝敗判定。 */
export const playTurn = (ref: StateRef, balance: Balance): Effect.Effect<TurnResult, never, BattleEnv> =>
  Effect.gen(function* () {
    const start = yield* Ref.get(ref);
    yield* checkInvariants(start);
    yield* beginTurn(ref);
    yield* publish((view) => BattleEvent.TurnStarted({ view }), yield* Ref.get(ref));

    // 1. スキル判定（＋ターン初めの隠れデメリット）
    yield* resolveSkills(ref);
    yield* resolveTurnStartTraits(ref);
    if (anyoneDown(yield* Ref.get(ref))) {
      // dispose 忘れ・強制評価で倒れたら、手を選ばずにターンを終える
      yield* endTurn(ref, Option.none());
    } else {
      // 2. 手選択 → 3. オープン → 4. ダメージ
      const choices = yield* chooseMoves(ref);
      const plays = yield* openMoves(ref, choices);
      yield* resolveExchange(ref, balance, plays);
      yield* endTurn(ref, Option.some(plays));
    }

    // 5. 勝敗判定
    const end = yield* Ref.get(ref);
    yield* checkInvariants(end);
    return judgeRound(end, balance);
  });

export interface RoundOutcome {
  readonly result: RoundResult;
  /** 決着時の状態（結果画面の表示用）。 */
  readonly final: GameState;
}

/** 1 試合。開始時に HP・手札・スキル使用回数・隠れデメリットの累積をリセットし、決着までターンを回す。 */
export const playRound = (setup: MatchSetup, match: MatchState): Effect.Effect<RoundOutcome, never, BattleEnv> =>
  Effect.gen(function* () {
    const initial = initialGameState(setup.characters, match.round);
    yield* checkInvariants(initial);
    const ref = yield* Ref.make(initial);
    yield* publish((view) => BattleEvent.RoundStarted({ round: match.round, wins: match.wins, view }), initial);
    for (;;) {
      const result = yield* playTurn(ref, setup.balance);
      if (result._tag !== "Continue") return { result, final: yield* Ref.get(ref) };
    }
  });

/** 引き分けが続いた場合の安全弁（実質起こらない）。 */
const MAX_ROUNDS = 25;

export interface MatchResult {
  readonly winner: Side;
  readonly wins: Readonly<Record<Side, number>>;
}

/** ベストオブ N（roundsToWin 本先取）。引き分けの試合はどちらにも 1 本入らない。 */
export const playMatch = (setup: MatchSetup): Effect.Effect<MatchResult, never, BattleEnv> =>
  Effect.gen(function* () {
    const ref = yield* Ref.make<MatchState>({ round: 1, wins: { Player: 0, Cpu: 0 } });
    for (;;) {
      const match = yield* Ref.get(ref);
      yield* assertInvariant(match.round <= MAX_ROUNDS, "試合数が上限を超えた");
      const { result, final } = yield* playRound(setup, match);
      const wins =
        result._tag === "Victory" ? { ...match.wins, [result.winner]: match.wins[result.winner] + 1 } : match.wins;
      const next = yield* Ref.updateAndGet(ref, (m) => ({ round: m.round + 1, wins }));
      yield* publish((view) => BattleEvent.RoundEnded({ result, wins, view }), final);
      const champion = SIDES.find((s) => next.wins[s] >= setup.balance.roundsToWin);
      if (champion !== undefined) {
        yield* publish((view) => BattleEvent.MatchEnded({ winner: champion, wins, view }), final);
        return { winner: champion, wins };
      }
    }
  });
