import { Option } from "effect";
import type { CharacterSpec } from "@pbj/shared/characters";
import { BattleEvent, type RoundResult, type TurnNote } from "@pbj/shared/events";
import type { Hand } from "@pbj/shared/hand";
import type { Move, Outcome } from "@pbj/shared/move";
import type {
  PrivateFighter,
  PublicEvent,
  PublicFighter,
  PublicFighters,
  ServerMessage,
  SyncState,
} from "@pbj/shared/protocol";
import { opponentOf, type Side } from "@pbj/shared/side";
import { isRepeatable } from "@pbj/shared/skills";
import type { BattleView, ChoiceView, OpponentView, OwnView } from "@pbj/shared/view";

/**
 * サーバーのメッセージ（席は絶対的な P1 / P2）を、オフラインと同じ BattleUi が描ける形に変換する。
 * UI は常に「自分 = P1（左）」で描くので、自分が P2 のときは席を入れ替える（relative）。
 * 入ってくるのは公開情報と自分の手札だけなので、ここで相手の非公開情報が増えることはない。
 */

export type MatchSync = Extract<SyncState, { readonly _tag: "Match" }>;
export type TurnResolved = Extract<ServerMessage, { readonly _tag: "TurnResolved" }>;

/** 絶対的な席 → 画面上の席（自分が P1）。入れ替えは自分自身の逆なので、逆変換にも使える。 */
export const relative =
  (you: Side) =>
  (side: Side): Side =>
    you === "P1" ? side : opponentOf(side);

/** 自分の手札まわり（StateSync でだけ届く）。 */
export interface OwnPrivate {
  readonly hand: Hand;
  readonly bare: boolean;
  readonly locked: Move | null;
}

export const ownPrivate = (f: PrivateFighter): OwnPrivate => ({ hand: f.hand, bare: f.bare, locked: f.locked });

export interface Perspective {
  readonly you: Side;
  /** 絶対的な席ごとのキャラ。 */
  readonly characters: Readonly<Record<Side, CharacterSpec>>;
}

const base = (f: PublicFighter, character: CharacterSpec, side: Side) => ({
  side,
  character,
  hp: f.hp,
  discard: f.discard,
  skill: {
    name: character.skill.displayName,
    concept: character.skill.concept,
    description: character.skill.description,
    used: f.skillUsed,
    activations: f.skillActivations,
    repeatable: isRepeatable(character.skill.kind),
  },
  thunks: Option.fromNullable(f.thunks),
  stwPenalty: f.stwPenalty,
});

/** 公開状態と自分の手札から、自分視点の BattleView を作る。 */
export const viewFrom = (
  p: Perspective,
  fighters: PublicFighters,
  own: OwnPrivate,
  revealedHand: Hand | null,
  round: number,
  turn: number,
): BattleView => {
  const them = opponentOf(p.you);
  const self: OwnView = {
    ...base(fighters[p.you], p.characters[p.you], "P1"),
    hand: own.hand,
    bare: own.bare,
    locked: Option.fromNullable(own.locked),
  };
  const opponent: OpponentView = {
    ...base(fighters[them], p.characters[them], "P2"),
    revealedHand: Option.fromNullable(revealedHand),
  };
  return { round, turn, self, opponent };
};

const fightersOf = (s: MatchSync): PublicFighters => {
  const f = s.self;
  const self: PublicFighter = {
    characterId: f.characterId,
    hp: f.hp,
    maxHp: f.maxHp,
    discard: f.discard,
    skillUsed: f.skillUsed,
    skillActivations: f.skillActivations,
    thunks: f.thunks,
    stwPenalty: f.stwPenalty,
  };
  return s.you === "P1" ? { P1: self, P2: s.opponent } : { P1: s.opponent, P2: self };
};

export const syncView = (p: Perspective, s: MatchSync): BattleView =>
  viewFrom(p, fightersOf(s), ownPrivate(s.self), s.opponentRevealedHand, s.round, s.turn);

export const choiceFrom = (p: Perspective, s: MatchSync): ChoiceView => ({
  ...syncView(p, s),
  opponentHandTotal: s.opponentHandTotal ?? 0,
  playable: s.playable,
});

export const relativeWins = (you: Side, scores: Readonly<Record<Side, number>>): Readonly<Record<Side, number>> =>
  you === "P1" ? scores : { P1: scores.P2, P2: scores.P1 };

export const relativeRoundResult = (you: Side, r: RoundResult): RoundResult => {
  switch (r._tag) {
    case "Victory":
      return { ...r, winner: relative(you)(r.winner) };
    case "Draw":
      return r;
  }
};

const outcomeFor = (winner: Side | null): Outcome => (winner === null ? "Draw" : winner === "P1" ? "Win" : "Lose");

const relNote = (rel: (s: Side) => Side, n: TurnNote): TurnNote => ({ ...n, side: rel(n.side) });

/** ターン中の 1 イベントを、表示用の BattleEvent に変換する。 */
export const battleEventFrom = (
  p: Perspective,
  e: PublicEvent,
  own: OwnPrivate,
  revealedHand: Hand | null,
  round: number,
  turn: number,
  firstUnlock: (achievementId: string) => boolean,
): BattleEvent => {
  const rel = relative(p.you);
  const view = viewFrom(p, e.fighters, own, revealedHand, round, turn);
  switch (e._tag) {
    case "SkillActivated":
      return BattleEvent.SkillActivated({
        side: rel(e.side),
        skillId: e.skillId,
        name: e.name,
        description: e.description,
        detail: e.detail,
        view,
      });
    case "StopTheWorld":
      return BattleEvent.StopTheWorld({ side: rel(e.side), penalty: e.penalty, view });
    case "TraitTriggered":
      return BattleEvent.TraitTriggered({
        side: rel(e.side),
        traitId: e.traitId,
        displayName: e.displayName,
        achievementId: e.achievementId,
        firstUnlock: firstUnlock(e.achievementId),
        view,
      });
    case "ThunksForced":
      return BattleEvent.ThunksForced({ side: rel(e.side), total: e.total, view });
    case "MovesRevealed":
      return BattleEvent.MovesRevealed({
        plays: p.you === "P1" ? e.plays : { P1: e.plays.P2, P2: e.plays.P1 },
        view,
      });
    case "ExtraMovePlayed":
      return BattleEvent.ExtraMovePlayed({ side: rel(e.side), move: e.move, view });
    case "ExchangeResolved":
      return BattleEvent.ExchangeResolved({
        outcome: outcomeFor(e.winner === null ? null : rel(e.winner)),
        winningMove: e.winningMove,
        damage: e.damage === null ? null : { ...e.damage, target: rel(e.damage.target) },
        bashDiscard: e.bashDiscard === null ? null : { ...e.bashDiscard, side: rel(e.bashDiscard.side) },
        thunkDropped: e.thunkDropped === null ? null : { ...e.thunkDropped, side: rel(e.thunkDropped.side) },
        view,
      });
    case "TurnEnded":
      return BattleEvent.TurnEnded({ notes: e.notes.map((n) => relNote(rel, n)), view });
  }
};

/** TurnResolved 1 通ぶんの演出（ターン中の出来事 → 試合の決着）。 */
export const turnEvents = (
  p: Perspective,
  t: TurnResolved,
  own: OwnPrivate,
  revealedHand: Hand | null,
  firstUnlock: (achievementId: string) => boolean,
): readonly BattleEvent[] => {
  const events = t.events.map((e) => battleEventFrom(p, e, own, revealedHand, t.round, t.turn, firstUnlock));
  if (t.roundResult === null) return events;
  const final = viewFrom(p, { P1: t.p1, P2: t.p2 }, own, revealedHand, t.round, t.turn);
  return [
    ...events,
    BattleEvent.RoundEnded({
      result: relativeRoundResult(p.you, t.roundResult),
      wins: relativeWins(p.you, t.scores),
      view: final,
    }),
  ];
};
