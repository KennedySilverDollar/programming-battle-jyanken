import { Effect, Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  ClientMessage,
  decodeClientMessage,
  decodeServerMessage,
  encodeServerMessage,
  MatchSync,
  PROTOCOL_VERSION,
  PublicFighter,
  RoomCode,
  ServerMessage,
} from "../src/protocol";
import { publicFighter } from "../src/publicize";
import { initialGameState } from "../src/state";
import { character } from "./helpers";

const decodeClient = (raw: string) => Effect.runSync(Effect.either(decodeClientMessage(raw)));

describe("プロトコル", () => {
  it("正しいクライアントメッセージはデコードでき、不正な JSON・型・値は失敗する", () => {
    const ok = decodeClient(
      JSON.stringify({ _tag: "CreateRoom", characterId: "python", protocolVersion: PROTOCOL_VERSION, clientSeq: 1 }),
    );
    expect(Either.isRight(ok)).toBe(true);
    expect(Either.isLeft(decodeClient("{not json"))).toBe(true);
    expect(Either.isLeft(decodeClient(JSON.stringify({ _tag: "Hack", clientSeq: 1 })))).toBe(true);
    // ルームコードの形式違反（小文字・紛らわしい文字・桁数）
    for (const roomCode of ["abcdef", "ABCDE0", "ABCDE", "ABCDEFG"]) {
      expect(
        Either.isLeft(decodeClient(JSON.stringify({ _tag: "JoinRoom", roomCode, characterId: "c", clientSeq: 1 }))),
      ).toBe(true);
    }
    // 手の値の範囲外・負の clientSeq
    expect(
      Either.isLeft(
        decodeClient(
          JSON.stringify({
            _tag: "SelectMove",
            matchId: "00000000-0000-4000-8000-000000000000",
            turn: 1,
            move: "Guard",
            clientSeq: 1,
          }),
        ),
      ),
    ).toBe(true);
    expect(Either.isLeft(decodeClient(JSON.stringify({ _tag: "Heartbeat", clientSeq: -1 })))).toBe(true);
  });

  it("サーバーメッセージは encode → decode で元に戻る", () => {
    const code = Schema.decodeSync(RoomCode)("ABC234");
    const msg: ServerMessage = { _tag: "Error", code: "RoomNotFound", message: "x", serverSeq: 3 };
    const json = Effect.runSync(encodeServerMessage(msg));
    expect(Effect.runSync(decodeServerMessage(json))).toEqual(msg);
    expect(code).toBe("ABC234");
  });

  it("公開情報には手札の中身を入れる場所が無い（相手の手札は送れない）", () => {
    const fields = Object.keys(PublicFighter.fields);
    expect(fields).not.toContain("hand");
    const matchFields = Object.keys(MatchSync.fields);
    // 相手側は PublicFighter。確定前の相手の手を入れるフィールドも無い
    expect(matchFields).not.toContain("opponentMove");
    const f = publicFighter(initialGameState({ P1: character("php"), P2: character("c") }).fighters.P1);
    expect(Object.keys(f)).not.toContain("hand");
    expect(Schema.is(PublicFighter)(f)).toBe(true);
  });

  it("ClientMessage は 9 種類（仕様の 6 種＋ StartMatch・SelectExtraMove・Heartbeat）", () => {
    expect(ClientMessage.members.length).toBe(9);
  });
});
