import { Either } from "effect";
import { describe, expect, it } from "vitest";
import {
  MATCH_EVENTS,
  matchTransition,
  type MatchEvent,
  ROOM_EVENTS,
  roomTransition,
  type RoomEvent,
} from "../src/fsm";
import type { MatchState, RoomState } from "../src/protocol";

const ROOM_STATES: readonly RoomState[] = ["WAITING", "READY", "PLAYING", "FINISHED", "CLOSED"];
const MATCH_STATES: readonly MatchState[] = ["IDLE", "SELECTING", "EXTRA_SELECTING", "RESOLVING", "MATCH_OVER"];

/** 仕様どおりの正しい遷移（これ以外はすべて InvalidTransition）。 */
const ROOM_VALID: readonly (readonly [RoomState, RoomEvent, RoomState])[] = [
  ["WAITING", "JoinRoom", "READY"],
  ["WAITING", "IdleTimeout", "CLOSED"],
  ["WAITING", "Leave", "CLOSED"],
  ["WAITING", "DisconnectExpired", "CLOSED"],
  ["READY", "StartMatch", "PLAYING"],
  ["READY", "IdleTimeout", "CLOSED"],
  ["READY", "Leave", "CLOSED"],
  ["READY", "DisconnectExpired", "CLOSED"],
  ["PLAYING", "MatchDecided", "FINISHED"],
  ["PLAYING", "Leave", "FINISHED"],
  ["PLAYING", "DisconnectExpired", "FINISHED"],
  ["FINISHED", "Rematch", "READY"],
  ["FINISHED", "IdleTimeout", "CLOSED"],
  ["FINISHED", "Leave", "CLOSED"],
  ["FINISHED", "DisconnectExpired", "CLOSED"],
];

const MATCH_VALID: readonly (readonly [MatchState, MatchEvent, MatchState])[] = [
  ["IDLE", "Start", "SELECTING"],
  ["SELECTING", "BothSelected", "RESOLVING"],
  ["SELECTING", "BothSelectedNeedExtra", "EXTRA_SELECTING"],
  ["SELECTING", "Forfeit", "MATCH_OVER"],
  ["EXTRA_SELECTING", "ExtrasSelected", "RESOLVING"],
  ["EXTRA_SELECTING", "Forfeit", "MATCH_OVER"],
  ["RESOLVING", "TurnResolved", "SELECTING"],
  ["RESOLVING", "MatchDecided", "MATCH_OVER"],
  ["RESOLVING", "Forfeit", "MATCH_OVER"],
  ["MATCH_OVER", "Rematch", "IDLE"],
];

describe("ルームの状態機械", () => {
  it("全 5 状態 × 全 7 イベントの 35 通りが、仕様の表と一致する", () => {
    let checked = 0;
    for (const from of ROOM_STATES) {
      for (const event of ROOM_EVENTS) {
        const expected = ROOM_VALID.find(([f, e]) => f === from && e === event)?.[2];
        const actual = roomTransition(from, event);
        if (expected === undefined) {
          expect(Either.isLeft(actual)).toBe(true);
          expect(Either.getLeft(actual).pipe((o) => o._tag === "Some" && o.value._tag)).toBe("InvalidTransition");
        } else {
          expect(actual).toEqual(Either.right(expected));
        }
        checked++;
      }
    }
    expect(checked).toBe(35);
  });

  it("CLOSED は終端（どのイベントでも戻らない）", () => {
    for (const event of ROOM_EVENTS) expect(Either.isLeft(roomTransition("CLOSED", event))).toBe(true);
  });

  it("単調：FINISHED → READY（再戦）以外に、前の状態へ戻る遷移は無い", () => {
    const rank: Record<RoomState, number> = { WAITING: 0, READY: 1, PLAYING: 2, FINISHED: 3, CLOSED: 4 };
    for (const [from, event, to] of ROOM_VALID) {
      if (from === "FINISHED" && event === "Rematch") continue;
      expect(rank[to]).toBeGreaterThan(rank[from]);
    }
  });
});

describe("マッチの状態機械", () => {
  it("全 5 状態 × 全 8 イベントの 40 通りが、仕様の表と一致する", () => {
    let checked = 0;
    for (const from of MATCH_STATES) {
      for (const event of MATCH_EVENTS) {
        const expected = MATCH_VALID.find(([f, e]) => f === from && e === event)?.[2];
        const actual = matchTransition(from, event);
        expect(expected === undefined ? Either.isLeft(actual) : Either.getOrNull(actual) === expected).toBe(true);
        checked++;
      }
    }
    expect(checked).toBe(40);
  });

  it("MATCH_OVER は Rematch 以外を受け付けない／RESOLVING は入力（手の確定）を受け付けない", () => {
    for (const event of MATCH_EVENTS) {
      expect(Either.isRight(matchTransition("MATCH_OVER", event))).toBe(event === "Rematch");
    }
    expect(Either.isLeft(matchTransition("RESOLVING", "BothSelected"))).toBe(true);
    expect(Either.isLeft(matchTransition("RESOLVING", "ExtrasSelected"))).toBe(true);
  });
});
