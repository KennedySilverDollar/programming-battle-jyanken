import { Effect, Layer, Schema, type Scope, TestClock, TestContext } from "effect";
import { loadGameData } from "@pbj/shared/gameData";
import type { Move } from "@pbj/shared/move";
import { type ClientMessage, PROTOCOL_VERSION, ServerMessage, type SyncState } from "@pbj/shared/protocol";
import { type ServerConfig, DEFAULT_CONFIG } from "../src/config";
import { type ConnId, type Hub, makeHub } from "../src/hub";
import { Ids, testIds } from "../src/ids";

/** テスト用の偽クライアントとハーネス。時計は TestClock なので、タイマーは adjust で進める。 */

const decode = Schema.decodeUnknownSync(Schema.parseJson(ServerMessage));

export type Tag = ServerMessage["_tag"];
export type Msg<T extends Tag> = Extract<ServerMessage, { readonly _tag: T }>;
export type MatchSync = Extract<SyncState, { readonly _tag: "Match" }>;

export type Outgoing = ClientMessage extends infer M ? (M extends unknown ? Omit<M, "clientSeq"> : never) : never;

export interface FakeClient {
  readonly id: ConnId;
  /** 受け取った生の文字列（再送の同一性の確認用）。 */
  readonly raw: string[];
  readonly inbox: ServerMessage[];
  closedWith: number | null;
  seq: number;
  readonly send: (msg: Outgoing) => Effect.Effect<void>;
  /** clientSeq を指定して送る（再送・逆行のテスト用）。 */
  readonly sendWithSeq: (msg: Outgoing, clientSeq: number) => Effect.Effect<void>;
  readonly sendRaw: (raw: string) => Effect.Effect<void>;
  readonly disconnect: Effect.Effect<void>;
}

export const all = <T extends Tag>(c: FakeClient, tag: T): Msg<T>[] =>
  c.inbox.filter((m): m is Msg<T> => m._tag === tag);

export const last = <T extends Tag>(c: FakeClient, tag: T): Msg<T> => {
  const found = all(c, tag).at(-1);
  if (found === undefined) throw new Error(`${tag} を受け取っていない`);
  return found;
};

export const lastSync = (c: FakeClient): MatchSync => {
  const s = last(c, "StateSync").state;
  if (s._tag !== "Match") throw new Error("試合中の StateSync ではない");
  return s;
};

export const connect = (hub: Hub): Effect.Effect<FakeClient> =>
  Effect.gen(function* () {
    const raw: string[] = [];
    const inbox: ServerMessage[] = [];
    const client: { -readonly [K in keyof FakeClient]: FakeClient[K] } = {
      id: -1,
      raw,
      inbox,
      closedWith: null,
      seq: 0,
      send: (msg) => Effect.suspend(() => client.sendWithSeq(msg, client.seq++)),
      sendWithSeq: (msg, clientSeq) => hub.message(client.id, JSON.stringify({ ...msg, clientSeq })),
      sendRaw: (text) => hub.message(client.id, text),
      disconnect: Effect.suspend(() => hub.closed(client.id)),
    };
    client.id = yield* hub.open({
      send: (text) =>
        Effect.sync(() => {
          raw.push(text);
          inbox.push(decode(text));
        }),
      close: (code) =>
        Effect.sync(() => {
          client.closedWith = code;
        }),
    });
    return client;
  });

/** 待機用の設定：ハートビートを長めにして、手選択のタイマーだけを試せるようにする。 */
export const RELAXED: ServerConfig = { ...DEFAULT_CONFIG, heartbeatTimeoutMs: 10 * 60_000 };

export const runHub = <A>(
  body: (hub: Hub) => Effect.Effect<A, never, Scope.Scope | Ids>,
  config: ServerConfig = RELAXED,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const data = yield* Effect.orDie(loadGameData());
      const hub = yield* makeHub(config, data);
      return yield* body(hub);
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(TestContext.TestContext, testIds()))),
  );

/** ルームを作って 2 人そろえ、マッチを始める。 */
export const startedRoom = (
  hub: Hub,
  characters: { readonly p1: string; readonly p2: string } = { p1: "java", p2: "python" },
): Effect.Effect<{ readonly p1: FakeClient; readonly p2: FakeClient }> =>
  Effect.gen(function* () {
    const p1 = yield* connect(hub);
    const p2 = yield* connect(hub);
    yield* p1.send({ _tag: "CreateRoom", characterId: characters.p1, protocolVersion: PROTOCOL_VERSION });
    const roomCode = last(p1, "RoomJoined").roomCode;
    yield* p2.send({ _tag: "JoinRoom", roomCode, characterId: characters.p2 });
    yield* p1.send({ _tag: "StartMatch", roomCode });
    return { p1, p2 };
  });

/** 今のターンに、出せる手のうち pick で選んだ手を出す。 */
export const play = (
  c: FakeClient,
  pick: (playable: readonly Move[]) => Move | undefined = (p) => p[0],
): Effect.Effect<void> =>
  Effect.suspend(() => {
    const sync = lastSync(c);
    const matchId = last(c, "StateSync").matchId;
    const move = pick(sync.playable);
    if (matchId === null || move === undefined) return Effect.dieMessage("手を出せる状態ではない");
    return sync.extraForYou
      ? c.send({ _tag: "SelectExtraMove", matchId, turn: sync.turn, move })
      : c.send({ _tag: "SelectMove", matchId, turn: sync.turn, move });
  });

export const advance = (ms: number): Effect.Effect<void> => TestClock.adjust(ms);

/** serverSeq を除いた内容（両者への配信の同一性の確認用）。 */
export const withoutSeq = (m: ServerMessage): string =>
  JSON.stringify(m, (key, value: unknown) => (key === "serverSeq" ? undefined : value));

export { Ids };
