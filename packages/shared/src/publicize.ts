import { Option } from "effect";
import type { EngineEvent } from "./engine";
import { handTotal } from "./hand";
import type { Move } from "./move";
import type {
  MatchState,
  PrivateFighter,
  PublicActivation,
  PublicEvent,
  PublicFighter,
  PublicFighters,
  RoomCode,
  RoomState,
  SyncState,
} from "./protocol";
import { opponentOf, type Side } from "./side";
import type { ActivationDetail } from "./skills";
import { type FighterState, type GameState, isBareHanded, playableMoves, thunkTotal } from "./state";

/**
 * エンジンの状態・出来事を、プロトコルの公開情報に変換する（サーバー → クライアントの唯一の出口）。
 * 相手に見せてよい情報だけを通す。
 */

export const publicFighter = (f: FighterState): PublicFighter => ({
  characterId: f.character.id,
  hp: f.hp,
  maxHp: f.character.maxHp,
  discard: f.discard,
  skillUsed: f.skill.used,
  skillActivations: f.skill.activations,
  thunks:
    f.skill.spec.activate._tag === "LazyEvaluation"
      ? { count: f.lazy.thunks.length, total: thunkTotal(f.lazy), forced: f.lazy.forced }
      : null,
  stwPenalty: Math.max(f.status.stwPenaltyNow, f.status.stwPenaltyNext),
});

export const publicFighters = (s: GameState): PublicFighters => ({
  P1: publicFighter(s.fighters.P1),
  P2: publicFighter(s.fighters.P2),
});

export const privateFighter = (f: FighterState): PrivateFighter => ({
  ...publicFighter(f),
  hand: f.hand,
  locked: Option.getOrNull(f.status.locked),
  bare: isBareHanded(f),
});

/** C の一時確保で引いたカードは非公開。それ以外の効果はもともと公開情報（捨て札との移動）。 */
export const publicActivation = (d: ActivationDetail): PublicActivation => {
  switch (d._tag) {
    case "Recycled":
      return { _tag: "Recycled", moves: d.moves };
    case "Allocated":
      return { _tag: "Allocated" };
    case "RaiiArmed":
      return { _tag: "RaiiArmed" };
    case "EventLoopArmed":
      return { _tag: "EventLoopArmed" };
    case "Revealed":
      return { _tag: "Revealed" };
    case "Destroyed":
      return { _tag: "Destroyed", moves: d.moves };
  }
};

export const publicEvent = (e: EngineEvent): PublicEvent => {
  const fighters = publicFighters(e.state);
  switch (e._tag) {
    case "SkillActivated":
      return {
        _tag: "SkillActivated",
        side: e.side,
        skillId: e.skillId,
        name: e.name,
        description: e.description,
        detail: publicActivation(e.detail),
        fighters,
      };
    case "StopTheWorld":
      return { _tag: "StopTheWorld", side: e.side, penalty: e.penalty, fighters };
    case "TraitTriggered":
      return {
        _tag: "TraitTriggered",
        side: e.side,
        traitId: e.traitId,
        displayName: e.displayName,
        achievementId: e.achievementId,
        fighters,
      };
    case "ThunksForced":
      return { _tag: "ThunksForced", side: e.side, total: e.total, fighters };
    case "MovesRevealed":
      return { _tag: "MovesRevealed", plays: e.plays, fighters };
    case "ExtraMovePlayed":
      return { _tag: "ExtraMovePlayed", side: e.side, move: e.move, fighters };
    case "ExchangeResolved":
      return {
        _tag: "ExchangeResolved",
        winner: e.winner,
        winningMove: e.winningMove,
        damage: e.damage,
        bashDiscard: e.bashDiscard,
        thunkDropped: e.thunkDropped,
        fighters,
      };
    case "TurnEnded":
      return { _tag: "TurnEnded", notes: e.notes, fighters };
  }
};

export interface MatchSyncInput {
  readonly roomCode: RoomCode;
  readonly roomState: RoomState;
  readonly matchState: MatchState;
  readonly state: GameState;
  readonly you: Side;
  readonly scores: Readonly<Record<Side, number>>;
  readonly selected: Readonly<Record<Side, boolean>>;
  readonly extraFor: readonly Side[];
  readonly remainingMs: number | null;
  readonly connected: Readonly<Record<Side, boolean>>;
}

const isSelecting = (m: MatchState): boolean => m === "SELECTING" || m === "EXTRA_SELECTING";

/** 1 人分の試合中の同期情報。相手の手札の中身・確定前の手は含めない。 */
export const matchSync = (i: MatchSyncInput): SyncState => {
  const self = i.state.fighters[i.you];
  const opponent = i.state.fighters[opponentOf(i.you)];
  const extraForYou = i.matchState === "EXTRA_SELECTING" && i.extraFor.includes(i.you);
  const canChoose = (i.matchState === "SELECTING" && !i.selected[i.you]) || extraForYou;
  const playable: readonly Move[] = canChoose ? playableMoves(self) : [];
  return {
    _tag: "Match",
    roomCode: i.roomCode,
    roomState: i.roomState,
    matchState: i.matchState,
    you: i.you,
    round: i.state.round,
    turn: i.state.turnsPlayed + 1,
    scores: i.scores,
    self: privateFighter(self),
    opponent: publicFighter(opponent),
    opponentHandTotal: isSelecting(i.matchState) ? handTotal(opponent.hand) : null,
    opponentRevealedHand: self.status.revealsOpponentHand ? opponent.hand : null,
    playable,
    selected: { you: i.selected[i.you], opponent: i.selected[opponentOf(i.you)] },
    extraForYou,
    remainingMs: i.remainingMs,
    connected: i.connected,
  };
};
