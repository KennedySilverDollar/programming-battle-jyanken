import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@pbj/shared/protocol";
import { DEFAULT_CONFIG } from "../src/config";
import { CLOSE_CODE } from "../src/hub";
import {
  advance,
  all,
  connect,
  type FakeClient,
  last,
  type Outgoing,
  lastSync,
  play,
  runHub,
  startedRoom,
  withoutSeq,
} from "./harness";

const errors = (c: FakeClient) => all(c, "Error").map((e) => e.code);

/** 両者が出せる手の先頭（P1）・末尾（P2）を出し続け、マッチが終わるまで進める。 */
const playToEnd = (p1: FakeClient, p2: FakeClient): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let i = 0; i < 400 && all(p1, "MatchFinished").length === 0; i++) {
      yield* advance(400);
      const s1 = lastSync(p1);
      const s2 = lastSync(p2);
      if (s1.matchState === "SELECTING" && !s1.selected.you) yield* play(p1);
      else if (s1.extraForYou) yield* play(p1);
      if (all(p1, "MatchFinished").length > 0) break;
      if (s2.matchState === "SELECTING" && !lastSync(p2).selected.you) yield* play(p2, (p) => p.at(-1));
      else if (lastSync(p2).extraForYou) yield* play(p2, (p) => p.at(-1));
    }
  });

describe("ルームとマッチ", () => {
  it("作成 → 参加 → 開始で、両者に試合中の StateSync が届く", () =>
    runHub((hub) =>
      Effect.gen(function* () {
        const { p1, p2 } = yield* startedRoom(hub);
        const r1 = last(p1, "RoomJoined");
        const r2 = last(p2, "RoomJoined");
        expect(r1.playerId).toBe("P1");
        expect(r2.playerId).toBe("P2");
        expect(r2.opponent?.characterId).toBe("java");
        expect(r1.sessionToken).not.toBe(r2.sessionToken);
        expect(lastSync(p1)).toMatchObject({ matchState: "SELECTING", you: "P1", turn: 1, round: 1 });
        expect(lastSync(p2)).toMatchObject({ matchState: "SELECTING", you: "P2", turn: 1, round: 1 });
        expect(errors(p1)).toEqual([]);
        expect(errors(p2)).toEqual([]);
      }),
    ));

  it("両者が手を出すと、同じ内容の TurnResolved が両者に届く（INV-7）", () =>
    runHub((hub) =>
      Effect.gen(function* () {
        const { p1, p2 } = yield* startedRoom(hub);
        yield* play(p1);
        expect(last(p1, "MoveAccepted")).toMatchObject({ turn: 1, extra: false });
        expect(all(p2, "TurnResolved")).toHaveLength(0);
        yield* play(p2);
        const t1 = last(p1, "TurnResolved");
        const t2 = last(p2, "TurnResolved");
        expect(withoutSeq(t1)).toBe(withoutSeq(t2));
        expect(t1.turn).toBe(1);
        expect(lastSync(p1).turn).toBe(2);
      }),
    ));

  it("手選択中、相手に送る情報には確定した手の中身が含まれない（INV-6）", () =>
    runHub((hub) =>
      Effect.gen(function* () {
        const { p1, p2 } = yield* startedRoom(hub);
        const before = lastSync(p2).opponent;
        const seen = p2.inbox.length;
        yield* play(p1);
        const after = p2.inbox.slice(seen);
        expect(after.map((m) => m._tag)).toEqual(["StateSync"]);
        const sync = lastSync(p2);
        expect(sync.selected.opponent).toBe(true);
        expect(sync.opponent).toEqual(before);
        expect(Object.keys(sync)).not.toContain("opponentHand");
      }),
    ));

  it("同じ matchId・同じ入力列なら、TurnResolved は同じになる（決定論）", async () => {
    const run = () =>
      runHub((hub) =>
        Effect.gen(function* () {
          const { p1, p2 } = yield* startedRoom(hub, { p1: "javascript", p2: "c" });
          yield* playToEnd(p1, p2);
          return all(p1, "TurnResolved").map(withoutSeq);
        }),
      );
    const a = await run();
    const b = await run();
    expect(a.length).toBeGreaterThan(0);
    expect(a).toEqual(b);
  });

  it("ベストオブ 3 を最後まで進め、MatchFinished の後に両者の Rematch で次のマッチが始まる", () =>
    runHub((hub) =>
      Effect.gen(function* () {
        const { p1, p2 } = yield* startedRoom(hub, { p1: "haskell", p2: "php" });
        yield* playToEnd(p1, p2);
        const finished = last(p1, "MatchFinished");
        expect(finished.reason).toBe("Decided");
        expect(Math.max(finished.scores.P1, finished.scores.P2)).toBe(2);
        expect(withoutSeq(finished)).toBe(withoutSeq(last(p2, "MatchFinished")));
        expect(last(p1, "StateSync").state).toMatchObject({ _tag: "Lobby", roomState: "FINISHED" });

        yield* p1.send({ _tag: "Rematch", matchId: finished.matchId });
        expect(last(p1, "StateSync").state._tag).toBe("Lobby");
        yield* p2.send({ _tag: "Rematch", matchId: finished.matchId });
        const sync = lastSync(p1);
        expect(sync).toMatchObject({ matchState: "SELECTING", round: 1, turn: 1, scores: { P1: 0, P2: 0 } });
        expect(last(p1, "StateSync").matchId).not.toBe(finished.matchId);
        expect(errors(p1)).toEqual([]);
        expect(errors(p2)).toEqual([]);
      }),
    ));
});

describe("エラー", () => {
  it("プロトコルのバージョン違い・存在しないルーム・満員", () =>
    runHub((hub) =>
      Effect.gen(function* () {
        const a = yield* connect(hub);
        yield* a.send({ _tag: "CreateRoom", characterId: "java", protocolVersion: PROTOCOL_VERSION + 1 });
        expect(errors(a)).toEqual(["VersionMismatch"]);

        yield* a.sendRaw(
          JSON.stringify({ _tag: "JoinRoom", roomCode: "ZZZZZZ", characterId: "java", clientSeq: a.seq++ }),
        );
        expect(errors(a).at(-1)).toBe("RoomNotFound");

        const { p1 } = yield* startedRoom(hub);
        const roomCode = last(p1, "RoomJoined").roomCode;
        yield* a.send({ _tag: "JoinRoom", roomCode, characterId: "c" });
        expect(errors(a).at(-1)).toBe("RoomFull");
      }),
    ));

  it("古いターンへの手は StaleTurn、P2 の StartMatch は NotYourTurn、待機中の手は InvalidTransition", () =>
    runHub((hub) =>
      Effect.gen(function* () {
        const p1 = yield* connect(hub);
        const p2 = yield* connect(hub);
        yield* p1.send({ _tag: "CreateRoom", characterId: "java", protocolVersion: PROTOCOL_VERSION });
        const roomCode = last(p1, "RoomJoined").roomCode;
        yield* p2.send({ _tag: "JoinRoom", roomCode, characterId: "cpp" });
        yield* p2.send({ _tag: "StartMatch", roomCode });
        expect(errors(p2)).toEqual(["NotYourTurn"]);
        yield* p1.send({ _tag: "StartMatch", roomCode });
        yield* p1.send({ _tag: "StartMatch", roomCode });
        expect(errors(p1)).toEqual(["InvalidTransition"]);
        yield* advance(1000);

        const matchId = last(p1, "StateSync").matchId;
        if (matchId === null) throw new Error("matchId が無い");
        yield* p1.send({ _tag: "SelectMove", matchId, turn: 2, move: "Slash" });
        expect(errors(p1).at(-1)).toBe("StaleTurn");
        yield* p1.send({ _tag: "SelectExtraMove", matchId, turn: 1, move: "Slash" });
        expect(errors(p1).at(-1)).toBe("InvalidTransition");
        yield* play(p1);
        yield* p1.send({ _tag: "SelectMove", matchId, turn: 1, move: "Slash" });
        expect(errors(p1).at(-1)).toBe("NotYourTurn");
      }),
    ));

  it("同じ clientSeq の再送には同じ応答（同じ serverSeq）を返し、古い clientSeq は InvalidSequence", () =>
    runHub((hub) =>
      Effect.gen(function* () {
        const a = yield* connect(hub);
        const create: Outgoing = { _tag: "CreateRoom", characterId: "java", protocolVersion: PROTOCOL_VERSION };
        yield* a.sendWithSeq(create, 5);
        const first = [...a.raw];
        expect(first).toHaveLength(2);
        yield* a.sendWithSeq(create, 5);
        expect(a.raw.slice(2)).toEqual(first);
        expect(all(a, "RoomJoined")).toHaveLength(2);

        yield* a.sendWithSeq({ _tag: "Heartbeat" }, 3);
        expect(errors(a)).toEqual(["InvalidSequence"]);
        yield* a.sendWithSeq({ _tag: "Heartbeat" }, 6);
        expect(errors(a)).toEqual(["InvalidSequence"]);
      }),
    ));

  it("不正なメッセージは InvalidMessage、5 回で切断", () =>
    runHub((hub) =>
      Effect.gen(function* () {
        const a = yield* connect(hub);
        for (let i = 0; i < 4; i++) {
          yield* a.sendRaw(`{"_tag":"Nope","n":${String(i)}}`);
          yield* advance(1000);
        }
        expect(errors(a)).toEqual(["InvalidMessage", "InvalidMessage", "InvalidMessage", "InvalidMessage"]);
        expect(a.closedWith).toBeNull();
        yield* a.sendRaw("not json");
        expect(a.closedWith).toBe(CLOSE_CODE.policy);
      }),
    ));

  it("1 秒に 5 件を超えると RateLimited、3 回で切断", () =>
    runHub((hub) =>
      Effect.gen(function* () {
        const a = yield* connect(hub);
        for (let i = 0; i < 5; i++) yield* a.send({ _tag: "Heartbeat" });
        expect(errors(a)).toEqual([]);
        yield* a.send({ _tag: "Heartbeat" });
        yield* a.send({ _tag: "Heartbeat" });
        expect(errors(a)).toEqual(["RateLimited", "RateLimited"]);
        expect(a.closedWith).toBeNull();
        yield* a.send({ _tag: "Heartbeat" });
        expect(a.closedWith).toBe(CLOSE_CODE.policy);
      }),
    ));
});

describe("タイマー（サーバーの時計）", () => {
  it("15 秒で未選択の側はランダム代理選択され、ターンが進む", () =>
    runHub((hub) =>
      Effect.gen(function* () {
        const { p1, p2 } = yield* startedRoom(hub);
        yield* play(p1);
        yield* advance(DEFAULT_CONFIG.selectTimeoutMs - 1);
        expect(all(p1, "TurnResolved")).toHaveLength(0);
        yield* advance(1);
        expect(all(p1, "TurnResolved")).toHaveLength(1);
        expect(withoutSeq(last(p1, "TurnResolved"))).toBe(withoutSeq(last(p2, "TurnResolved")));
        // 誰も出さなくても進む
        yield* advance(DEFAULT_CONFIG.selectTimeoutMs);
        expect(all(p2, "TurnResolved")).toHaveLength(2);
      }),
    ));

  it("ハートビートが 10 秒途絶えると切断する", () =>
    runHub(
      (hub) =>
        Effect.gen(function* () {
          const a = yield* connect(hub);
          const b = yield* connect(hub);
          for (let i = 0; i < 4; i++) {
            yield* advance(3000);
            yield* a.send({ _tag: "Heartbeat" });
          }
          expect(a.closedWith).toBeNull();
          expect(b.closedWith).toBe(CLOSE_CODE.heartbeat);
        }),
      DEFAULT_CONFIG,
    ));

  it("待機中のルームは 300 秒で閉じる", () =>
    runHub((hub) =>
      Effect.gen(function* () {
        const a = yield* connect(hub);
        yield* a.send({ _tag: "CreateRoom", characterId: "java", protocolVersion: PROTOCOL_VERSION });
        expect(yield* hub.roomCount).toBe(1);
        yield* advance(299_000);
        expect(yield* hub.roomCount).toBe(1);
        yield* advance(1000);
        expect(yield* hub.roomCount).toBe(0);
        expect(last(a, "StateSync").state).toMatchObject({ roomState: "CLOSED" });
      }),
    ));
});

describe("再接続", () => {
  it("30 秒以内なら sessionToken で復帰し、全状態の StateSync を受け取る", () =>
    runHub((hub) =>
      Effect.gen(function* () {
        const { p1, p2 } = yield* startedRoom(hub);
        const token = last(p2, "RoomJoined").sessionToken;
        yield* play(p2);
        yield* p2.disconnect;
        expect(lastSync(p1).connected.P2).toBe(false);
        yield* advance(10_000);
        const again = yield* connect(hub);
        yield* again.send({ _tag: "Reconnect", sessionToken: token });
        expect(last(again, "RoomJoined").playerId).toBe("P2");
        const sync = lastSync(again);
        expect(sync).toMatchObject({ you: "P2", matchState: "SELECTING", selected: { you: true, opponent: false } });
        expect(lastSync(p1).connected.P2).toBe(true);
        yield* advance(30_000);
        expect(all(p1, "MatchFinished")).toHaveLength(0);
      }),
    ));

  it("二重接続では新しい接続が残り、古い接続は閉じられる", () =>
    runHub((hub) =>
      Effect.gen(function* () {
        const { p1 } = yield* startedRoom(hub);
        const token = last(p1, "RoomJoined").sessionToken;
        const tab = yield* connect(hub);
        yield* tab.send({ _tag: "Reconnect", sessionToken: token });
        expect(p1.closedWith).toBe(CLOSE_CODE.replaced);
        expect(lastSync(tab).you).toBe("P1");
        yield* play(tab);
        expect(last(tab, "MoveAccepted").turn).toBe(1);
      }),
    ));

  it("猶予の 30 秒を過ぎると、切断した側の負けでマッチが終わる", () =>
    runHub((hub) =>
      Effect.gen(function* () {
        const { p1, p2 } = yield* startedRoom(hub);
        const token = last(p2, "RoomJoined").sessionToken;
        yield* p2.disconnect;
        yield* advance(DEFAULT_CONFIG.reconnectGraceMs);
        expect(last(p1, "MatchFinished")).toMatchObject({ winner: "P1", reason: "Disconnected" });
        // 決着後もルームは FINISHED で 60 秒残るので再接続はできるが、試合は終わっている
        const again = yield* connect(hub);
        yield* again.send({ _tag: "Reconnect", sessionToken: token });
        expect(last(again, "StateSync").state).toMatchObject({ _tag: "Lobby", roomState: "FINISHED" });
        yield* advance(60_000);
        const late = yield* connect(hub);
        yield* late.send({ _tag: "Reconnect", sessionToken: token });
        expect(errors(late)).toEqual(["SessionExpired"]);
      }),
    ));

  it("試合中の退出はその側の負け（Forfeit）", () =>
    runHub((hub) =>
      Effect.gen(function* () {
        const { p1, p2 } = yield* startedRoom(hub);
        const roomCode = last(p1, "RoomJoined").roomCode;
        yield* p1.send({ _tag: "LeaveRoom", roomCode });
        expect(last(p2, "MatchFinished")).toMatchObject({ winner: "P2", reason: "Forfeit" });
        expect(errors(p1)).toEqual([]);
      }),
    ));
});
