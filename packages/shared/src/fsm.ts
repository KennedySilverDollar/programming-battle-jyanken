import { Data, Either } from "effect";
import type { MatchState, RoomState } from "./protocol";

/**
 * ルームとマッチの状態機械（純粋関数）。
 * 遷移表は全セルを Record で定義するので、状態やイベントを追加したら埋めない限りコンパイルできない。
 * null のセルは不正遷移で、InvalidTransition（型付きエラー）になる。
 */

export class InvalidTransition extends Data.TaggedError("InvalidTransition")<{
  readonly machine: "Room" | "Match";
  readonly from: string;
  readonly event: string;
}> {
  override get message(): string {
    return `${this.machine}: ${this.from} で ${this.event} は受け付けられない`;
  }
}

/** ルームに起きる出来事。 */
export type RoomEvent =
  | "JoinRoom"
  | "StartMatch"
  | "MatchDecided"
  | "Rematch"
  | "Leave"
  /** 再接続猶予（30 秒）切れ。 */
  | "DisconnectExpired"
  /** 状態ごとの放置タイムアウト（WAITING 300 秒・READY 60 秒・FINISHED 60 秒）。 */
  | "IdleTimeout";

export const ROOM_EVENTS = [
  "JoinRoom",
  "StartMatch",
  "MatchDecided",
  "Rematch",
  "Leave",
  "DisconnectExpired",
  "IdleTimeout",
] satisfies readonly RoomEvent[];

/**
 * - WAITING → JoinRoom で READY、放置 300 秒で CLOSED
 * - READY → StartMatch で PLAYING、放置 60 秒で CLOSED
 * - PLAYING → 決着で FINISHED。退出・切断 30 秒超過も（その側の負けで）FINISHED
 * - FINISHED → Rematch で READY、放置 60 秒で CLOSED
 * - CLOSED → 終端
 * 待機中の退出・切断は、単調性を保つため（READY → WAITING に戻さず）ルームを閉じる。
 */
export const ROOM_TRANSITIONS: Readonly<Record<RoomState, Readonly<Record<RoomEvent, RoomState | null>>>> = {
  WAITING: {
    JoinRoom: "READY",
    StartMatch: null,
    MatchDecided: null,
    Rematch: null,
    Leave: "CLOSED",
    DisconnectExpired: "CLOSED",
    IdleTimeout: "CLOSED",
  },
  READY: {
    JoinRoom: null,
    StartMatch: "PLAYING",
    MatchDecided: null,
    Rematch: null,
    Leave: "CLOSED",
    DisconnectExpired: "CLOSED",
    IdleTimeout: "CLOSED",
  },
  PLAYING: {
    JoinRoom: null,
    StartMatch: null,
    MatchDecided: "FINISHED",
    Rematch: null,
    Leave: "FINISHED",
    DisconnectExpired: "FINISHED",
    IdleTimeout: null,
  },
  FINISHED: {
    JoinRoom: null,
    StartMatch: null,
    MatchDecided: null,
    Rematch: "READY",
    Leave: "CLOSED",
    DisconnectExpired: "CLOSED",
    IdleTimeout: "CLOSED",
  },
  CLOSED: {
    JoinRoom: null,
    StartMatch: null,
    MatchDecided: null,
    Rematch: null,
    Leave: null,
    DisconnectExpired: null,
    IdleTimeout: null,
  },
};

export const roomTransition = (from: RoomState, event: RoomEvent): Either.Either<RoomState, InvalidTransition> => {
  const to = ROOM_TRANSITIONS[from][event];
  return to === null ? Either.left(new InvalidTransition({ machine: "Room", from, event })) : Either.right(to);
};

/** 放置タイムアウトの秒数（状態ごと）。null はタイムアウトしない。 */
export const ROOM_IDLE_SECONDS: Readonly<Record<RoomState, number | null>> = {
  WAITING: 300,
  READY: 60,
  PLAYING: null,
  FINISHED: 60,
  CLOSED: null,
};

/** マッチに起きる出来事。 */
export type MatchEvent =
  | "Start"
  /** 両者の手が確定（イベントループ不要）。 */
  | "BothSelected"
  /** 両者の手が確定し、イベントループの追加の 1 手が必要。 */
  | "BothSelectedNeedExtra"
  | "ExtrasSelected"
  /** ターンを解決し、マッチは続く。 */
  | "TurnResolved"
  /** ターンを解決し、マッチの勝者が決まった。 */
  | "MatchDecided"
  /** 退出・切断による決着。 */
  | "Forfeit"
  /** 再戦のためにリセット。 */
  | "Rematch";

export const MATCH_EVENTS = [
  "Start",
  "BothSelected",
  "BothSelectedNeedExtra",
  "ExtrasSelected",
  "TurnResolved",
  "MatchDecided",
  "Forfeit",
  "Rematch",
] satisfies readonly MatchEvent[];

/**
 * IDLE → SELECTING →（EXTRA_SELECTING →）RESOLVING →（SELECTING | MATCH_OVER）
 * MATCH_OVER は Rematch（→ IDLE）以外を受け付けない。
 */
export const MATCH_TRANSITIONS: Readonly<Record<MatchState, Readonly<Record<MatchEvent, MatchState | null>>>> = {
  IDLE: {
    Start: "SELECTING",
    BothSelected: null,
    BothSelectedNeedExtra: null,
    ExtrasSelected: null,
    TurnResolved: null,
    MatchDecided: null,
    Forfeit: null,
    Rematch: null,
  },
  SELECTING: {
    Start: null,
    BothSelected: "RESOLVING",
    BothSelectedNeedExtra: "EXTRA_SELECTING",
    ExtrasSelected: null,
    TurnResolved: null,
    MatchDecided: null,
    Forfeit: "MATCH_OVER",
    Rematch: null,
  },
  EXTRA_SELECTING: {
    Start: null,
    BothSelected: null,
    BothSelectedNeedExtra: null,
    ExtrasSelected: "RESOLVING",
    TurnResolved: null,
    MatchDecided: null,
    Forfeit: "MATCH_OVER",
    Rematch: null,
  },
  RESOLVING: {
    Start: null,
    BothSelected: null,
    BothSelectedNeedExtra: null,
    ExtrasSelected: null,
    TurnResolved: "SELECTING",
    MatchDecided: "MATCH_OVER",
    Forfeit: "MATCH_OVER",
    Rematch: null,
  },
  MATCH_OVER: {
    Start: null,
    BothSelected: null,
    BothSelectedNeedExtra: null,
    ExtrasSelected: null,
    TurnResolved: null,
    MatchDecided: null,
    Forfeit: null,
    Rematch: "IDLE",
  },
};

export const matchTransition = (from: MatchState, event: MatchEvent): Either.Either<MatchState, InvalidTransition> => {
  const to = MATCH_TRANSITIONS[from][event];
  return to === null ? Either.left(new InvalidTransition({ machine: "Match", from, event })) : Either.right(to);
};

/** ルームが受け付けを終えた（戻らない）か。 */
export const isTerminal = (state: RoomState): boolean => state === "CLOSED";
