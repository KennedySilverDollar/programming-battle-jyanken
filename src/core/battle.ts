import { Effect, Ref } from "effect";
import type { Balance } from "./balance";
import type { CharacterDef } from "./characters";
import { SkillConditionNotMet } from "./errors";
import { BattleEvent, type Damage, RoundResult, type TurnResult } from "./events";
import { handTotal, removeCard } from "./hand";
import { judge, type Move } from "./move";
import type { RandomService } from "./random";
import { BattleEvents, CpuStrategy, PlayerInput } from "./services";
import { isReady, markUsed } from "./skills";
import { opponentOf, SIDES, type Side } from "./side";
import {
  assertInvariant,
  checkInvariants,
  type FighterState,
  type GameState,
  initialGameState,
  withFighter,
} from "./state";
import { type BattleView, battleView, choiceView } from "./view";

export interface RoundSetup {
  readonly balance: Balance;
  readonly characters: Readonly<Record<Side, CharacterDef>>;
}

type StateRef = Ref.Ref<GameState>;

const publish = (
  event: (view: BattleView) => BattleEvent,
  state: GameState,
): Effect.Effect<void, never, BattleEvents> =>
  Effect.flatMap(BattleEvents, (events) => events.publish(event(battleView(state, "Player"))));

// ---------------------------------------------------------------------------
// 1〜3. スキル判定
// ---------------------------------------------------------------------------

/** 条件を再確認したうえで Active スキルを発動し、used = true にする。 */
const activateSkill = (
  ref: StateRef,
  side: Side,
): Effect.Effect<void, SkillConditionNotMet, RandomService | BattleEvents> =>
  Effect.gen(function* () {
    const state = yield* Ref.get(ref);
    const self = state.fighters[side];
    const opponent = state.fighters[opponentOf(side)];
    const skill = self.skill;
    if (skill._tag !== "Active" || !isReady(self, opponent)) {
      return yield* new SkillConditionNotMet({ side, skill: skill.name });
    }
    const duel = yield* skill.activate(self, opponent);
    const next = withFighter(withFighter(state, { ...duel.self, skill: markUsed(duel.self.skill) }), duel.opponent);
    yield* Ref.set(ref, next);
    yield* publish(
      (view) => BattleEvent.SkillActivated({ side, name: skill.name, description: skill.description, view }),
      next,
    );
  });

/**
 * ターン初めのスキル処理。
 *   1. 両者の発動条件をチェック（ターン開始時点のスナップショットで評価）
 *   2. Negator（Haskell「純粋関数」）が条件を満たしていれば相手のスキルを無効化
 *      - 無効化された側は used = false のまま。次ターン以降に再挑戦できる。
 *   3. 残ったスキルを発動
 */
const resolveSkills = (ref: StateRef): Effect.Effect<void, never, RandomService | BattleEvents> =>
  Effect.gen(function* () {
    const snapshot = yield* Ref.get(ref);
    const ready = (side: Side): boolean => isReady(snapshot.fighters[side], snapshot.fighters[opponentOf(side)]);

    // 1. 条件チェック
    const triggered = SIDES.filter(ready);

    // 2. 無効化
    const negators = triggered.filter((side) => snapshot.fighters[side].skill._tag === "Negator");
    const negatedTargets = negators.map(opponentOf);
    for (const by of negators) {
      const target = opponentOf(by);
      yield* assertInvariant(triggered.includes(target), "Negator が発動したのに相手のスキルが条件未達");
      const state = yield* Ref.get(ref);
      const negator = state.fighters[by];
      const next = withFighter(state, { ...negator, skill: markUsed(negator.skill) });
      yield* Ref.set(ref, next);
      yield* publish(
        (view) =>
          BattleEvent.SkillNegated({
            by,
            byName: negator.skill.name,
            target,
            targetName: next.fighters[target].skill.name,
            view,
          }),
        next,
      );
    }

    // 3. 残りを発動。先の発動で条件が崩れた場合は used を立てずに見送る。
    const remaining = triggered.filter((side) => !negators.includes(side) && !negatedTargets.includes(side));
    for (const side of remaining) {
      yield* activateSkill(ref, side).pipe(Effect.catchTag("SkillConditionNotMet", () => Effect.void));
    }
  });

// ---------------------------------------------------------------------------
// 4. 手選択（伏せ）
// ---------------------------------------------------------------------------

const chooseMoves = (ref: StateRef): Effect.Effect<Readonly<Record<Side, Move>>, never, PlayerInput | CpuStrategy> =>
  Effect.gen(function* () {
    const state = yield* Ref.get(ref);
    const cpu = yield* CpuStrategy;
    const input = yield* PlayerInput;

    const cpuMove = yield* cpu.chooseMove(choiceView(state, "Cpu"));
    yield* removeCard("Cpu", state.fighters.Cpu.hand, cpuMove).pipe(
      Effect.orDieWith((e) => `CPU が手札にない手を選んだ: ${e.move}`),
    );

    // 手札にない手が来たら（UI 側のバグ等）選び直させる
    const askPlayer: Effect.Effect<Move> = input.chooseMove(choiceView(state, "Player")).pipe(
      Effect.tap((move) => removeCard("Player", state.fighters.Player.hand, move)),
      Effect.catchTag("NoCardForMove", () => Effect.suspend(() => askPlayer)),
    );
    const playerMove = yield* askPlayer;

    return { Player: playerMove, Cpu: cpuMove };
  });

// ---------------------------------------------------------------------------
// 5. オープン → 6. ダメージ
// ---------------------------------------------------------------------------

const discardCard = (fighter: FighterState, move: Move): Effect.Effect<FighterState> =>
  removeCard(fighter.side, fighter.hand, move).pipe(
    Effect.map((hand) => ({ ...fighter, hand, discard: [...fighter.discard, move] })),
    Effect.orDieWith((e) => `選択済みの手が手札から消えている: ${e.side} ${e.move}`),
  );

/** 勝者 winner が winningMove で勝ったときのダメージ。UB 倍率は与・被の両方に掛かる。 */
export const damageFor = (balance: Balance, winningMove: Move, winner: FighterState, loser: FighterState): number =>
  Math.round(balance.damage[winningMove] * winner.status.riskMultiplier * loser.status.riskMultiplier);

const winnerOf = (outcomeForPlayer: ReturnType<typeof judge>): Side | null => {
  switch (outcomeForPlayer) {
    case "Win":
      return "Player";
    case "Lose":
      return "Cpu";
    case "Draw":
      return null;
  }
};

const openAndResolve = (
  ref: StateRef,
  balance: Balance,
  moves: Readonly<Record<Side, Move>>,
): Effect.Effect<void, never, BattleEvents> =>
  Effect.gen(function* () {
    const state = yield* Ref.get(ref);
    // あいこでも両者 1 枚ずつ消費する
    const player = yield* discardCard(state.fighters.Player, moves.Player);
    const cpu = yield* discardCard(state.fighters.Cpu, moves.Cpu);
    const outcome = judge(moves.Player, moves.Cpu);
    const winner = winnerOf(outcome);

    const fighters: Record<Side, FighterState> = { Player: player, Cpu: cpu };
    const damage: Damage | null =
      winner === null
        ? null
        : {
            target: opponentOf(winner),
            amount: damageFor(balance, moves[winner], fighters[winner], fighters[opponentOf(winner)]),
          };

    const hit = (f: FighterState): FighterState => ({
      ...f,
      hp: damage !== null && damage.target === f.side ? Math.max(0, f.hp - damage.amount) : f.hp,
      // UB はこのターン限り
      status: { ...f.status, riskMultiplier: 1 },
    });

    const next: GameState = {
      turnsPlayed: state.turnsPlayed + 1,
      fighters: { Player: hit(player), Cpu: hit(cpu) },
    };
    yield* Ref.set(ref, next);
    yield* publish((view) => BattleEvent.MovesRevealed({ moves, outcome, damage, view }), next);
  });

// ---------------------------------------------------------------------------
// 7. 勝敗判定
// ---------------------------------------------------------------------------

const hpRatio = (f: FighterState): number => f.hp / f.character.maxHp;

/**
 * HP 0 → 敗北、手札 0 → 敗北。
 * 両者同時に手札 0 になった場合（全キャラ同枚数なら必ず同時）は HP 割合が高い方の勝ち、同率なら引き分け。
 */
export const judgeRound = (state: GameState): Effect.Effect<TurnResult> => {
  const { Player: p, Cpu: c } = state.fighters;
  const pDead = p.hp <= 0;
  const cDead = c.hp <= 0;
  if (pDead && cDead) return Effect.dieMessage("1 ターンで両者が HP 0 になった（ダメージは片側のみのはず）");
  if (pDead) return Effect.succeed(RoundResult.Victory({ winner: "Cpu", reason: "HpDepleted" }));
  if (cDead) return Effect.succeed(RoundResult.Victory({ winner: "Player", reason: "HpDepleted" }));

  const pEmpty = handTotal(p.hand) === 0;
  const cEmpty = handTotal(c.hand) === 0;
  if (pEmpty && cEmpty) {
    const diff = hpRatio(p) - hpRatio(c);
    if (diff === 0) return Effect.succeed(RoundResult.Draw({ reason: "HpRatioTie" }));
    return Effect.succeed(RoundResult.Victory({ winner: diff > 0 ? "Player" : "Cpu", reason: "HpRatioTiebreak" }));
  }
  if (pEmpty) return Effect.succeed(RoundResult.Victory({ winner: "Cpu", reason: "HandEmpty" }));
  if (cEmpty) return Effect.succeed(RoundResult.Victory({ winner: "Player", reason: "HandEmpty" }));
  return Effect.succeed({ _tag: "Continue" });
};

// ---------------------------------------------------------------------------
// ターンと試合
// ---------------------------------------------------------------------------

export type BattleEnv = RandomService | PlayerInput | CpuStrategy | BattleEvents;

/** 1 ターン：スキル判定 → 手選択 → オープン → ダメージ → 勝敗判定。 */
export const playTurn = (ref: StateRef, balance: Balance): Effect.Effect<TurnResult, never, BattleEnv> =>
  Effect.gen(function* () {
    const start = yield* Ref.get(ref);
    yield* checkInvariants(start);
    yield* publish((view) => BattleEvent.TurnStarted({ view }), start);

    yield* resolveSkills(ref);
    const moves = yield* chooseMoves(ref);
    yield* openAndResolve(ref, balance, moves);

    const end = yield* Ref.get(ref);
    yield* checkInvariants(end);
    return yield* judgeRound(end);
  });

/** 1 試合。開始時に HP・手札・スキル使用回数をリセットし、決着までターンを回す。 */
export const playRound = (setup: RoundSetup): Effect.Effect<RoundResult, never, BattleEnv> =>
  Effect.gen(function* () {
    const initial = initialGameState(setup.characters);
    yield* checkInvariants(initial);
    const ref = yield* Ref.make(initial);
    yield* publish((view) => BattleEvent.RoundStarted({ view }), initial);

    for (;;) {
      const result = yield* playTurn(ref, setup.balance);
      if (result._tag !== "Continue") {
        const final = yield* Ref.get(ref);
        yield* publish((view) => BattleEvent.RoundEnded({ result, view }), final);
        return result;
      }
    }
  });
