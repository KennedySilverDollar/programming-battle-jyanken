import { Clock, type Context, Effect, Either, Option, Schedule, type Scope } from "effect";
import { applyRoundResult, MAX_ROUNDS } from "@pbj/shared/battle";
import type { CharacterSpec } from "@pbj/shared/characters";
import {
  beginResolution,
  type EngineEvent,
  finishResolution,
  type PhaseA,
  proxyMoves,
  randomPlayable,
  validateMove,
} from "@pbj/shared/engine";
import type { TurnResult } from "@pbj/shared/events";
import {
  InvalidTransition,
  type MatchEvent,
  matchTransition,
  ROOM_IDLE_SECONDS,
  type RoomEvent,
  roomTransition,
} from "@pbj/shared/fsm";
import { findCharacter, type GameData } from "@pbj/shared/gameData";
import type { Move } from "@pbj/shared/move";
import {
  type ClientMessage,
  decodeClientMessage,
  encodeServerMessage,
  type MatchId,
  type MatchState,
  type Outcome,
  PROTOCOL_VERSION,
  type RoomCode,
  type RoomState,
  type ServerMessage,
  type ServerPayload,
  type SessionToken,
  type SyncState,
} from "@pbj/shared/protocol";
import { matchSync, publicActivation, publicEvent, publicFighter } from "@pbj/shared/publicize";
import { mulberry32, RandomService, randomServiceFrom, seedFromMatchId } from "@pbj/shared/random";
import { opponentOf, SIDES, type Side } from "@pbj/shared/side";
import {
  assertInvariant,
  checkInvariants,
  type FighterState,
  type GameState,
  initialGameState,
  withFighter,
} from "@pbj/shared/state";
import type { ServerConfig } from "./config";
import {
  errorCode,
  InvalidMessage,
  InvalidSequence,
  NotYourTurn,
  RateLimited,
  RoomFull,
  RoomNotFound,
  type ServerError,
  SessionExpired,
  StaleTurn,
  VersionMismatch,
} from "./errors";
import { Ids } from "./ids";

/**
 * 通信手段に依存しない対戦サーバーの本体（ルーム・セッション・タイマー・採番・流量制限）。
 *
 * - 全操作を 1 本のロック（セマフォ）で直列化する。ルームをまたぐ操作（再接続など）もあるので、
 *   小規模な対戦サーバーではこれがいちばん単純で、競合状態が起きない。
 * - 時刻はすべて Effect の Clock から取る（クライアントの時計は使わない。テストでは TestClock）。
 * - タイマーは「世代番号（epoch）」付きで起動し、発火時に世代が変わっていれば何もしない。
 * - ゲームの乱数は matchId から導いたシードの RandomService だけを使う（呼び出し順はエンジンが固定）。
 */

export type ConnId = number;

/** 1 本の接続（WebSocket など）。close は非同期に閉じ始めるだけで、完了を待たない。 */
export interface Transport {
  readonly send: (text: string) => Effect.Effect<void>;
  readonly close: (code: number, reason: string) => Effect.Effect<void>;
}

export interface Hub {
  readonly open: (transport: Transport) => Effect.Effect<ConnId>;
  readonly message: (id: ConnId, raw: string) => Effect.Effect<void>;
  readonly closed: (id: ConnId) => Effect.Effect<void>;
  /** 稼働中のルーム数（監視・テスト用）。 */
  readonly roomCount: Effect.Effect<number>;
}

/** 切断理由（WebSocket の close code）。 */
export const CLOSE_CODE = {
  /** 流量制限・不正メッセージの累積。 */
  policy: 1008,
  /** 同じセッションで新しい接続が来た（新しい方を残す）。 */
  replaced: 4000,
  /** ハートビートが途絶えた。 */
  heartbeat: 4001,
} satisfies Record<string, number>;

interface SeatRef {
  readonly code: RoomCode;
  readonly side: Side;
}

interface Conn {
  readonly id: ConnId;
  readonly transport: Transport;
  open: boolean;
  nextServerSeq: number;
  /** 最後に受理した clientSeq（INV-8：接続ごとに単調増加）。 */
  lastClientSeq: number;
  /** 最後に受理したメッセージへの応答（エンコード済み）。同じ clientSeq の再送にはこれをそのまま返す。 */
  lastReplies: readonly string[];
  /** 処理中のメッセージへの応答を集める。 */
  capture: string[] | null;
  recent: readonly number[];
  rateStrikes: number;
  invalidStrikes: number;
  lastSeen: number;
  seat: Option.Option<SeatRef>;
}

interface Seat {
  readonly character: CharacterSpec;
  readonly token: SessionToken;
  conn: Option.Option<ConnId>;
  /** 再接続猶予タイマーの世代。 */
  graceEpoch: number;
}

interface Match {
  readonly id: MatchId;
  readonly random: Context.Tag.Service<RandomService>;
  state: MatchState;
  game: GameState;
  chosen: Record<Side, Option.Option<Move>>;
  /** イベントループの追加の 1 手を待っている途中経過。 */
  phase: Option.Option<PhaseA>;
  extras: Record<Side, Option.Option<Move>>;
  /** EXTRA_SELECTING に入るときにスキル発動を通知済みか。 */
  announced: boolean;
  deadline: number | null;
  timerEpoch: number;
}

interface Room {
  readonly code: RoomCode;
  state: RoomState;
  readonly seats: { readonly P1: Seat; P2: Option.Option<Seat> };
  wins: Record<Side, number>;
  match: Option.Option<Match>;
  lastMatchId: Option.Option<MatchId>;
  rematch: Set<Side>;
  idleEpoch: number;
}

const NO_MOVES: Record<Side, Option.Option<Move>> = { P1: Option.none(), P2: Option.none() };
const isSelecting = (m: MatchState): boolean => m === "SELECTING" || m === "EXTRA_SELECTING";

/** 捨て札から、このターンに伏せたカード（＝最後に積まれた同じ手）を 1 枚隠す。オープン前の同期用。 */
const hideCommitted = (f: FighterState, move: Move): FighterState => {
  const i = f.discard.lastIndexOf(move);
  return i < 0 ? f : { ...f, discard: [...f.discard.slice(0, i), ...f.discard.slice(i + 1)] };
};

const outcomeOf = (events: readonly EngineEvent[]): Outcome => {
  for (const e of events) {
    if (e._tag !== "ExchangeResolved") continue;
    switch (e.winner) {
      case "P1":
        return "P1Win";
      case "P2":
        return "P2Win";
      case null:
        return "Draw";
    }
  }
  return "Draw";
};

export const makeHub = (config: ServerConfig, data: GameData): Effect.Effect<Hub, never, Ids | Scope.Scope> =>
  Effect.gen(function* () {
    const ids = yield* Ids;
    const scope = yield* Effect.scope;
    const lock = yield* Effect.makeSemaphore(1);
    const locked = lock.withPermits(1);

    const conns = new Map<ConnId, Conn>();
    const rooms = new Map<RoomCode, Room>();
    const sessions = new Map<SessionToken, SeatRef>();
    let nextConnId = 1;

    const now = Clock.currentTimeMillis;
    /** 指定時間後にロックを取って実行する（スコープが閉じれば中断される）。 */
    const after = (ms: number, effect: Effect.Effect<void>): Effect.Effect<void> =>
      Effect.asVoid(Effect.forkIn(Effect.zipRight(Effect.sleep(ms), locked(effect)), scope));

    // -------------------------------------------------------------------------
    // 送信
    // -------------------------------------------------------------------------

    const send = (conn: Conn, payload: ServerPayload): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (!conn.open) return;
        const message: ServerMessage = { ...payload, serverSeq: conn.nextServerSeq };
        conn.nextServerSeq += 1;
        const text = yield* Effect.orDie(encodeServerMessage(message));
        conn.capture?.push(text);
        yield* conn.transport.send(text);
      });

    const sendError = (conn: Conn, e: ServerError): Effect.Effect<void> =>
      send(conn, { _tag: "Error", code: errorCode(e), message: e.message });

    const seatOf = (room: Room, side: Side): Option.Option<Seat> =>
      side === "P1" ? Option.some(room.seats.P1) : room.seats.P2;

    const connOf = (room: Room, side: Side): Option.Option<Conn> =>
      Option.flatMap(seatOf(room, side), (seat) =>
        Option.flatMap(seat.conn, (id) => Option.fromNullable(conns.get(id))),
      );

    const sendTo = (room: Room, side: Side, payload: ServerPayload): Effect.Effect<void> =>
      Option.match(connOf(room, side), { onNone: () => Effect.void, onSome: (c) => send(c, payload) });

    /** 両者に同じ内容を送る（INV-7）。切断中の側には再接続時の StateSync で届く。 */
    const broadcast = (room: Room, payload: ServerPayload): Effect.Effect<void> =>
      Effect.forEach(SIDES, (side) => sendTo(room, side, payload), { discard: true });

    // -------------------------------------------------------------------------
    // 同期情報
    // -------------------------------------------------------------------------

    const connected = (room: Room): Record<Side, boolean> => ({
      P1: Option.isSome(connOf(room, "P1")),
      P2: Option.isSome(connOf(room, "P2")),
    });

    const syncFor = (room: Room, side: Side, at: number): SyncState =>
      Option.match(
        Option.filter(room.match, () => room.state === "PLAYING"),
        {
          onNone: (): SyncState => ({
            _tag: "Lobby",
            roomCode: room.code,
            roomState: room.state,
            you: side,
            characters: {
              P1: room.seats.P1.character.id,
              P2: Option.match(room.seats.P2, { onNone: () => null, onSome: (s) => s.character.id }),
            },
            connected: connected(room),
            scores: room.wins,
          }),
          onSome: (m) => {
            const phase = Option.filter(m.phase, () => m.state === "EXTRA_SELECTING");
            // イベントループ待ちの間は、相手が伏せた手が捨て札から分からないよう 1 枚隠す
            const state = Option.match(phase, {
              onNone: () => m.game,
              onSome: (p) => {
                const opp = opponentOf(side);
                return withFighter(p.state, hideCommitted(p.state.fighters[opp], p.pending.commits[opp].move));
              },
            });
            const extraFor = Option.match(phase, {
              onNone: () => [],
              onSome: (p) => p.needExtra.filter((s) => Option.isNone(m.extras[s])),
            });
            return matchSync({
              roomCode: room.code,
              roomState: room.state,
              matchState: m.state,
              state,
              you: side,
              scores: room.wins,
              selected:
                m.state === "SELECTING"
                  ? { P1: Option.isSome(m.chosen.P1), P2: Option.isSome(m.chosen.P2) }
                  : { P1: true, P2: true },
              extraFor,
              remainingMs: m.deadline === null ? null : Math.max(0, m.deadline - at),
              connected: connected(room),
            });
          },
        },
      );

    const syncSide = (room: Room, side: Side): Effect.Effect<void> =>
      Effect.flatMap(now, (at) =>
        sendTo(room, side, {
          _tag: "StateSync",
          matchId: Option.getOrNull(
            Option.orElse(
              Option.map(room.match, (m) => m.id),
              () => room.lastMatchId,
            ),
          ),
          state: syncFor(room, side, at),
        }),
      );

    const syncBoth = (room: Room): Effect.Effect<void> =>
      Effect.forEach(SIDES, (side) => syncSide(room, side), { discard: true });

    // -------------------------------------------------------------------------
    // 状態遷移
    // -------------------------------------------------------------------------

    const isCurrent = (room: Room): boolean => rooms.get(room.code) === room && room.state !== "CLOSED";

    const armIdle = (room: Room): Effect.Effect<void> => {
      room.idleEpoch += 1;
      const epoch = room.idleEpoch;
      const seconds = ROOM_IDLE_SECONDS[room.state];
      if (seconds === null) return Effect.void;
      return after(
        seconds * 1000,
        Effect.suspend(() =>
          isCurrent(room) && room.idleEpoch === epoch
            ? Effect.flatMap(Effect.orDie(transitionRoom(room, "IdleTimeout")), () => closeRoom(room))
            : Effect.void,
        ),
      );
    };

    const transitionRoom = (room: Room, event: RoomEvent): Effect.Effect<void, InvalidTransition> =>
      Either.match(roomTransition(room.state, event), {
        onLeft: Effect.fail,
        onRight: (to) => {
          room.state = to;
          return armIdle(room);
        },
      });

    /** サーバー内部の遷移。表に無い遷移は実装の欠陥なので die。 */
    const transitionMatch = (m: Match, event: MatchEvent): Effect.Effect<void> =>
      Either.match(matchTransition(m.state, event), {
        onLeft: (e) => Effect.die(e),
        onRight: (to) => {
          m.state = to;
          return Effect.void;
        },
      });

    const closeRoom = (room: Room): Effect.Effect<void> =>
      Effect.gen(function* () {
        room.state = "CLOSED";
        room.idleEpoch += 1;
        for (const side of SIDES) {
          const seat = seatOf(room, side);
          if (Option.isNone(seat)) continue;
          sessions.delete(seat.value.token);
          yield* syncSide(room, side);
          const conn = connOf(room, side);
          if (Option.isSome(conn)) conn.value.seat = Option.none();
          seat.value.conn = Option.none();
        }
        if (Option.isSome(room.match)) room.match.value.timerEpoch += 1;
        rooms.delete(room.code);
      });

    // -------------------------------------------------------------------------
    // マッチの進行
    // -------------------------------------------------------------------------

    const withRandom =
      (m: Match) =>
      <A, E>(effect: Effect.Effect<A, E, RandomService>): Effect.Effect<A, E> =>
        Effect.provideService(effect, RandomService, m.random);

    const charactersOf = (room: Room): Effect.Effect<Record<Side, CharacterSpec>> =>
      Option.match(room.seats.P2, {
        onNone: () => Effect.dieMessage("P2 がいないのにマッチを始めようとした"),
        onSome: (p2) => Effect.succeed({ P1: room.seats.P1.character, P2: p2.character }),
      });

    /** 手選択（または追加の 1 手）の締め切りを設定する。満了したら未選択の側をランダム代理選択。 */
    const armSelect = (room: Room, m: Match): Effect.Effect<void> =>
      Effect.gen(function* () {
        m.timerEpoch += 1;
        const epoch = m.timerEpoch;
        m.deadline = (yield* now) + config.selectTimeoutMs;
        yield* after(
          config.selectTimeoutMs,
          Effect.suspend(() => {
            if (!isCurrent(room) || Option.getOrUndefined(room.match) !== m || m.timerEpoch !== epoch) {
              return Effect.void;
            }
            switch (m.state) {
              case "SELECTING":
                return resolveTurn(room, m);
              case "EXTRA_SELECTING":
                return Option.match(m.phase, {
                  onNone: () => Effect.dieMessage("EXTRA_SELECTING なのに途中経過が無い"),
                  onSome: (phase) => Effect.zipRight(transitionMatch(m, "ExtrasSelected"), finishTurn(room, m, phase)),
                });
              case "IDLE":
              case "RESOLVING":
              case "MATCH_OVER":
                return Effect.void;
            }
          }),
        );
      });

    const startMatch = (room: Room): Effect.Effect<void> =>
      Effect.gen(function* () {
        const id = yield* ids.matchId;
        const characters = yield* charactersOf(room);
        const m: Match = {
          id,
          random: randomServiceFrom(mulberry32(seedFromMatchId(id))),
          state: "IDLE",
          game: initialGameState(characters, 1),
          chosen: { ...NO_MOVES },
          phase: Option.none(),
          extras: { ...NO_MOVES },
          announced: false,
          deadline: null,
          timerEpoch: 0,
        };
        yield* checkInvariants(m.game);
        room.wins = { P1: 0, P2: 0 };
        room.rematch.clear();
        room.match = Option.some(m);
        yield* transitionMatch(m, "Start");
        yield* armSelect(room, m);
        yield* syncBoth(room);
      });

    /** スキル・隠れデメリットの発動を、両者に通知する。 */
    const announce = (room: Room, turn: number, events: readonly EngineEvent[]): Effect.Effect<void> =>
      Effect.forEach(
        events,
        (e) => {
          switch (e._tag) {
            case "SkillActivated":
              return broadcast(room, {
                _tag: "SkillActivated",
                player: e.side,
                skillId: e.skillId,
                skillName: e.name,
                effect: publicActivation(e.detail),
                turn,
              });
            case "TraitTriggered":
              return broadcast(room, {
                _tag: "HiddenTraitTriggered",
                player: e.side,
                achievementId: e.achievementId,
                displayName: e.displayName,
                turn,
              });
            case "StopTheWorld":
            case "ThunksForced":
            case "MovesRevealed":
            case "ExtraMovePlayed":
            case "ExchangeResolved":
            case "TurnEnded":
              return Effect.void;
          }
        },
        { discard: true },
      );

    /** 両者の手が揃った（または時間切れ）。1〜3 を解決し、必要ならイベントループの追加の 1 手を待つ。 */
    const resolveTurn = (room: Room, m: Match): Effect.Effect<void> =>
      Effect.gen(function* () {
        const random = withRandom(m);
        const moves = yield* random(proxyMoves(m.game, m.chosen));
        const phase = yield* random(beginResolution(m.game, moves)).pipe(
          Effect.orDieWith((e) => `検証済みの手が出せない: ${e.side} ${e.move}`),
        );
        if (phase.needExtra.length > 0) {
          yield* transitionMatch(m, "BothSelectedNeedExtra");
          m.phase = Option.some(phase);
          m.extras = { ...NO_MOVES };
          m.announced = true;
          yield* announce(room, m.game.turnsPlayed + 1, phase.events);
          yield* armSelect(room, m);
          return yield* syncBoth(room);
        }
        yield* transitionMatch(m, "BothSelected");
        yield* finishTurn(room, m, phase);
      });

    /** 4〜7 を解決し、TurnResolved を両者に一斉配信して次へ進める。 */
    const finishTurn = (room: Room, m: Match, phase: PhaseA): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* assertInvariant(m.state === "RESOLVING", `RESOLVING 以外でターンを解決しようとした: ${m.state}`);
        const random = withRandom(m);
        const turn = m.game.turnsPlayed + 1;
        // 追加の 1 手を選ばなかった側は代理選択（P1 → P2 の順に乱数を使う）
        const extras: Record<Side, Option.Option<Move>> = { ...NO_MOVES };
        for (const side of SIDES) {
          if (!phase.needExtra.includes(side)) continue;
          extras[side] = Option.some(
            yield* Option.match(m.extras[side], {
              onNone: () => random(randomPlayable(phase.state.fighters[side])),
              onSome: Effect.succeed,
            }),
          );
        }
        const done = yield* random(finishResolution(data.balance, phase, extras)).pipe(
          Effect.orDieWith((e) => `検証済みの追加の手が出せない: ${e.side} ${e.move}`),
        );
        yield* checkInvariants(done.state);
        m.timerEpoch += 1;
        m.deadline = null;

        if (!m.announced) yield* announce(room, turn, phase.events);
        yield* announce(room, turn, done.events);

        const result: TurnResult = done.result;
        const roundOver = result._tag !== "Continue";
        const { wins, champion } = roundOver
          ? applyRoundResult(room.wins, result, data.balance.roundsToWin)
          : { wins: room.wins, champion: undefined };
        room.wins = { ...wins };

        // INV-6：TurnResolved は RESOLVING 中にだけ作る。INV-7：同じオブジェクトを両者に送る
        yield* assertInvariant(!isSelecting(m.state), "手選択中に TurnResolved を送ろうとした");
        yield* broadcast(room, {
          _tag: "TurnResolved",
          matchId: m.id,
          turn,
          round: done.state.round,
          p1: publicFighter(done.state.fighters.P1),
          p2: publicFighter(done.state.fighters.P2),
          outcome: outcomeOf(done.events),
          events: [...phase.events, ...done.events].map(publicEvent),
          roundResult: result._tag === "Continue" ? null : result,
          scores: room.wins,
        });

        m.phase = Option.none();
        m.extras = { ...NO_MOVES };
        m.chosen = { ...NO_MOVES };
        m.announced = false;

        if (champion !== undefined) {
          yield* transitionMatch(m, "MatchDecided");
          return yield* finishMatch(room, m, champion, "Decided", "MatchDecided");
        }
        if (result._tag === "Continue") {
          m.game = done.state;
        } else {
          yield* assertInvariant(done.state.round < MAX_ROUNDS, "試合数が上限を超えた");
          m.game = initialGameState(yield* charactersOf(room), done.state.round + 1);
          yield* checkInvariants(m.game);
        }
        yield* transitionMatch(m, "TurnResolved");
        yield* armSelect(room, m);
        yield* syncBoth(room);
      });

    const finishMatch = (
      room: Room,
      m: Match,
      winner: Side,
      reason: "Decided" | "Forfeit" | "Disconnected",
      event: RoomEvent,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        m.timerEpoch += 1;
        m.deadline = null;
        yield* Effect.orDie(transitionRoom(room, event));
        room.lastMatchId = Option.some(m.id);
        room.match = Option.none();
        room.rematch.clear();
        yield* broadcast(room, { _tag: "MatchFinished", matchId: m.id, winner, scores: room.wins, reason });
        yield* syncBoth(room);
      });

    /** 退出・切断による決着（loser の負け）。 */
    const forfeit = (room: Room, loser: Side, reason: "Forfeit" | "Disconnected"): Effect.Effect<void> =>
      Option.match(room.match, {
        onNone: () => Effect.dieMessage("PLAYING なのにマッチが無い"),
        onSome: (m) =>
          Effect.zipRight(
            transitionMatch(m, "Forfeit"),
            finishMatch(room, m, opponentOf(loser), reason, reason === "Forfeit" ? "Leave" : "DisconnectExpired"),
          ),
      });

    // -------------------------------------------------------------------------
    // 接続・切断
    // -------------------------------------------------------------------------

    const detach = (conn: Conn): void => {
      Option.map(conn.seat, (ref) => {
        const room = rooms.get(ref.code);
        if (room === undefined) return;
        Option.map(seatOf(room, ref.side), (seat) => {
          if (Option.getOrUndefined(seat.conn) === conn.id) seat.conn = Option.none();
        });
      });
      conn.seat = Option.none();
    };

    /** 席から接続が外れた。猶予内に再接続が無ければ、試合中は負け・それ以外は退出扱い。 */
    const startGrace = (code: RoomCode, side: Side): Effect.Effect<void> =>
      Effect.gen(function* () {
        const room = rooms.get(code);
        if (room === undefined) return;
        const seat = seatOf(room, side);
        if (Option.isNone(seat)) return;
        seat.value.graceEpoch += 1;
        const epoch = seat.value.graceEpoch;
        yield* syncSide(room, opponentOf(side));
        yield* after(
          config.reconnectGraceMs,
          Effect.suspend(() => {
            if (!isCurrent(room) || seat.value.graceEpoch !== epoch || Option.isSome(seat.value.conn)) {
              return Effect.void;
            }
            return room.state === "PLAYING"
              ? forfeit(room, side, "Disconnected")
              : Effect.flatMap(Effect.orDie(transitionRoom(room, "DisconnectExpired")), () => closeRoom(room));
          }),
        );
      });

    const handleClosed = (conn: Conn): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (!conns.has(conn.id)) return;
        conns.delete(conn.id);
        conn.open = false;
        const ref = conn.seat;
        detach(conn);
        if (Option.isSome(ref)) yield* startGrace(ref.value.code, ref.value.side);
      });

    /** サーバー側から切る（流量制限・ハートビート途絶）。 */
    const drop = (conn: Conn, code: number, reason: string): Effect.Effect<void> =>
      Effect.zipRight(conn.transport.close(code, reason), handleClosed(conn));

    // -------------------------------------------------------------------------
    // メッセージの処理
    // -------------------------------------------------------------------------

    const roomOf = (conn: Conn, code: RoomCode): Effect.Effect<{ room: Room; side: Side }, RoomNotFound> => {
      const ref = Option.getOrUndefined(conn.seat);
      const room = ref?.code === code ? rooms.get(code) : undefined;
      return ref === undefined || room === undefined
        ? Effect.fail(new RoomNotFound({ message: `ルーム ${code} に参加していない` }))
        : Effect.succeed({ room, side: ref.side });
    };

    const seatedRoom = (conn: Conn): Effect.Effect<{ room: Room; side: Side }, RoomNotFound> =>
      Option.match(conn.seat, {
        onNone: () => Effect.fail(new RoomNotFound({ message: "ルームに参加していない" })),
        onSome: (ref) => roomOf(conn, ref.code),
      });

    const characterFor = (id: string): Effect.Effect<CharacterSpec, InvalidMessage> =>
      findCharacter(data.roster, id).pipe(
        Effect.mapError((e) => new InvalidMessage({ message: `不明なキャラクター: ${e.id}` })),
      );

    const notSeated = (conn: Conn, event: string): Effect.Effect<void, InvalidTransition> =>
      Option.match(conn.seat, {
        onNone: () => Effect.void,
        onSome: (ref) =>
          Effect.fail(new InvalidTransition({ machine: "Room", from: rooms.get(ref.code)?.state ?? "CLOSED", event })),
      });

    const newRoomCode: Effect.Effect<RoomCode> = Effect.gen(function* () {
      for (let i = 0; i < 32; i++) {
        const code = yield* ids.roomCode;
        if (!rooms.has(code)) return code;
      }
      return yield* Effect.dieMessage("ルームコードを割り当てられない");
    });

    /** 現在のマッチの、指定ターンへの手の提出か（古い matchId・ターンは StaleTurn）。 */
    const currentMatch = (room: Room, matchId: MatchId, turn: number): Effect.Effect<Match, StaleTurn> => {
      const m = Option.getOrUndefined(room.match);
      if (m?.id !== matchId) {
        return Effect.fail(new StaleTurn({ message: "このマッチは終了している" }));
      }
      const current = m.game.turnsPlayed + 1;
      return turn === current
        ? Effect.succeed(m)
        : Effect.fail(new StaleTurn({ message: `ターン ${String(turn)} は現在のターン ${String(current)} ではない` }));
    };

    const playable = (f: FighterState, move: Move): Effect.Effect<Move, InvalidMessage> =>
      validateMove(f, move).pipe(
        Effect.mapError((e) => new InvalidMessage({ message: `その手は出せない: ${e.move}` })),
      );

    const handle = (conn: Conn, msg: ClientMessage): Effect.Effect<void, ServerError> =>
      Effect.gen(function* () {
        switch (msg._tag) {
          case "Heartbeat":
            return;

          case "CreateRoom": {
            if (msg.protocolVersion !== PROTOCOL_VERSION) {
              return yield* new VersionMismatch({
                message: `プロトコルのバージョンが違う（サーバー ${String(PROTOCOL_VERSION)}・クライアント ${String(msg.protocolVersion)}）`,
              });
            }
            yield* notSeated(conn, "CreateRoom");
            const character = yield* characterFor(msg.characterId);
            const code = yield* newRoomCode;
            const token = yield* ids.sessionToken;
            const room: Room = {
              code,
              state: "WAITING",
              seats: { P1: { character, token, conn: Option.some(conn.id), graceEpoch: 0 }, P2: Option.none() },
              wins: { P1: 0, P2: 0 },
              match: Option.none(),
              lastMatchId: Option.none(),
              rematch: new Set(),
              idleEpoch: 0,
            };
            rooms.set(code, room);
            sessions.set(token, { code, side: "P1" });
            conn.seat = Option.some({ code, side: "P1" });
            yield* armIdle(room);
            yield* send(conn, {
              _tag: "RoomJoined",
              roomCode: code,
              playerId: "P1",
              sessionToken: token,
              opponent: null,
            });
            return yield* syncSide(room, "P1");
          }

          case "JoinRoom": {
            yield* notSeated(conn, "JoinRoom");
            const room = rooms.get(msg.roomCode);
            if (room === undefined || room.state === "CLOSED") {
              return yield* new RoomNotFound({ message: `ルーム ${msg.roomCode} は存在しない` });
            }
            if (Option.isSome(room.seats.P2)) {
              return yield* new RoomFull({ message: `ルーム ${msg.roomCode} は満員` });
            }
            const character = yield* characterFor(msg.characterId);
            yield* transitionRoom(room, "JoinRoom");
            const token = yield* ids.sessionToken;
            room.seats.P2 = Option.some({ character, token, conn: Option.some(conn.id), graceEpoch: 0 });
            sessions.set(token, { code: room.code, side: "P2" });
            conn.seat = Option.some({ code: room.code, side: "P2" });
            yield* send(conn, {
              _tag: "RoomJoined",
              roomCode: room.code,
              playerId: "P2",
              sessionToken: token,
              opponent: { characterId: room.seats.P1.character.id },
            });
            return yield* syncBoth(room);
          }

          case "StartMatch": {
            const { room, side } = yield* roomOf(conn, msg.roomCode);
            if (side !== "P1") return yield* new NotYourTurn({ message: "マッチを始められるのはルームの作成者だけ" });
            yield* transitionRoom(room, "StartMatch");
            return yield* startMatch(room);
          }

          case "SelectMove": {
            const { room, side } = yield* seatedRoom(conn);
            const m = yield* currentMatch(room, msg.matchId, msg.turn);
            if (m.state !== "SELECTING") {
              return yield* new InvalidTransition({ machine: "Match", from: m.state, event: "SelectMove" });
            }
            if (Option.isSome(m.chosen[side])) {
              return yield* new NotYourTurn({ message: "このターンの手は確定済み" });
            }
            const move = yield* playable(m.game.fighters[side], msg.move);
            m.chosen[side] = Option.some(move);
            yield* send(conn, { _tag: "MoveAccepted", matchId: m.id, turn: msg.turn, extra: false });
            if (SIDES.every((s) => Option.isSome(m.chosen[s]))) return yield* resolveTurn(room, m);
            return yield* syncBoth(room);
          }

          case "SelectExtraMove": {
            const { room, side } = yield* seatedRoom(conn);
            const m = yield* currentMatch(room, msg.matchId, msg.turn);
            const phase = Option.getOrUndefined(Option.filter(m.phase, () => m.state === "EXTRA_SELECTING"));
            if (phase === undefined) {
              return yield* new InvalidTransition({ machine: "Match", from: m.state, event: "SelectExtraMove" });
            }
            if (!phase.needExtra.includes(side)) {
              return yield* new NotYourTurn({ message: "イベントループは発動していない" });
            }
            if (Option.isSome(m.extras[side])) {
              return yield* new NotYourTurn({ message: "追加の 1 手は確定済み" });
            }
            const move = yield* playable(phase.state.fighters[side], msg.move);
            m.extras[side] = Option.some(move);
            yield* send(conn, { _tag: "MoveAccepted", matchId: m.id, turn: msg.turn, extra: true });
            if (phase.needExtra.every((s) => Option.isSome(m.extras[s]))) {
              yield* transitionMatch(m, "ExtrasSelected");
              return yield* finishTurn(room, m, phase);
            }
            return yield* syncBoth(room);
          }

          case "Rematch": {
            const { room, side } = yield* seatedRoom(conn);
            if (Option.getOrUndefined(room.lastMatchId) !== msg.matchId) {
              return yield* new StaleTurn({ message: "直前のマッチではない" });
            }
            if (room.state !== "FINISHED") {
              return yield* new InvalidTransition({ machine: "Room", from: room.state, event: "Rematch" });
            }
            room.rematch.add(side);
            if (!SIDES.every((s) => room.rematch.has(s))) return yield* syncBoth(room);
            // 両者が希望したら READY を経てすぐに次のマッチを始める
            yield* transitionRoom(room, "Rematch");
            yield* transitionRoom(room, "StartMatch");
            return yield* startMatch(room);
          }

          case "LeaveRoom": {
            const { room, side } = yield* roomOf(conn, msg.roomCode);
            if (room.state === "PLAYING") {
              yield* forfeit(room, side, "Forfeit");
              // 退出した側の席は以後使えない（再接続・再戦は不可）
              Option.map(seatOf(room, side), (seat) => {
                sessions.delete(seat.token);
                seat.conn = Option.none();
                seat.graceEpoch += 1;
              });
              conn.seat = Option.none();
              return yield* syncSide(room, opponentOf(side));
            }
            yield* transitionRoom(room, "Leave");
            return yield* closeRoom(room);
          }

          case "Reconnect": {
            const ref = sessions.get(msg.sessionToken);
            const room = ref === undefined ? undefined : rooms.get(ref.code);
            const seat =
              ref === undefined || room === undefined ? undefined : Option.getOrUndefined(seatOf(room, ref.side));
            if (ref === undefined || room === undefined || seat === undefined || !isCurrent(room)) {
              return yield* new SessionExpired({ message: "セッションの有効期限が切れている" });
            }
            // 二重接続：新しい接続を残し、古い接続は閉じる
            const old = Option.getOrUndefined(Option.flatMap(seat.conn, (id) => Option.fromNullable(conns.get(id))));
            if (old !== undefined && old !== conn) {
              old.seat = Option.none();
              yield* old.transport.close(CLOSE_CODE.replaced, "別の接続で再接続された");
              conns.delete(old.id);
              old.open = false;
            }
            if (Option.isSome(conn.seat) && Option.getOrUndefined(conn.seat) !== ref) {
              const prev = conn.seat.value;
              detach(conn);
              yield* startGrace(prev.code, prev.side);
            }
            seat.conn = Option.some(conn.id);
            seat.graceEpoch += 1;
            conn.seat = Option.some(ref);
            const opponent = Option.getOrUndefined(seatOf(room, opponentOf(ref.side)));
            yield* send(conn, {
              _tag: "RoomJoined",
              roomCode: room.code,
              playerId: ref.side,
              sessionToken: seat.token,
              opponent: opponent === undefined ? null : { characterId: opponent.character.id },
            });
            return yield* syncBoth(room);
          }
        }
      });

    const receive = (conn: Conn, raw: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const at = yield* now;
        conn.lastSeen = at;

        // 流量制限（直近 1 秒の件数）
        conn.recent = [...conn.recent.filter((t) => at - t < 1000), at];
        if (conn.recent.length > config.rateLimitPerSecond) {
          conn.rateStrikes += 1;
          yield* sendError(conn, new RateLimited({ message: "メッセージが多すぎる" }));
          if (conn.rateStrikes >= config.rateLimitStrikes) yield* drop(conn, CLOSE_CODE.policy, "rate limited");
          return;
        }

        const decoded = yield* Effect.either(decodeClientMessage(raw));
        if (Either.isLeft(decoded)) {
          conn.invalidStrikes += 1;
          yield* sendError(conn, new InvalidMessage({ message: "メッセージの形式が正しくない" }));
          if (conn.invalidStrikes >= config.invalidMessageStrikes)
            yield* drop(conn, CLOSE_CODE.policy, "invalid messages");
          return;
        }
        const msg = decoded.right;

        // 採番：同じ clientSeq は同じ応答（同じ serverSeq）をそのまま再送、古いものは拒否
        if (msg.clientSeq === conn.lastClientSeq) {
          for (const text of conn.lastReplies) yield* conn.transport.send(text);
          return;
        }
        if (msg.clientSeq < conn.lastClientSeq) {
          return yield* sendError(
            conn,
            new InvalidSequence({
              message: `clientSeq ${String(msg.clientSeq)} は受理済みの ${String(conn.lastClientSeq)} より古い`,
            }),
          );
        }
        yield* assertInvariant(msg.clientSeq > conn.lastClientSeq, "INV-8 clientSeq が単調増加でない");
        conn.lastClientSeq = msg.clientSeq;
        const replies: string[] = [];
        conn.capture = replies;
        const result = yield* Effect.either(handle(conn, msg));
        if (Either.isLeft(result)) yield* sendError(conn, result.left);
        conn.capture = null;
        conn.lastReplies = replies;
      });

    // ハートビート：一定時間何も届かない接続は切断扱い（サーバーの時計で判定）
    yield* Effect.forkIn(
      Effect.repeat(
        locked(
          Effect.gen(function* () {
            const at = yield* now;
            for (const conn of [...conns.values()]) {
              if (at - conn.lastSeen > config.heartbeatTimeoutMs) {
                yield* drop(conn, CLOSE_CODE.heartbeat, "heartbeat timeout");
              }
            }
          }),
        ),
        Schedule.spaced("1 second"),
      ),
      scope,
    );

    return {
      open: (transport) =>
        locked(
          Effect.gen(function* () {
            const id = nextConnId;
            nextConnId += 1;
            conns.set(id, {
              id,
              transport,
              open: true,
              nextServerSeq: 0,
              lastClientSeq: -1,
              lastReplies: [],
              capture: null,
              recent: [],
              rateStrikes: 0,
              invalidStrikes: 0,
              lastSeen: yield* now,
              seat: Option.none(),
            });
            return id;
          }),
        ),
      message: (id, raw) =>
        locked(
          Effect.suspend(() => {
            const conn = conns.get(id);
            return conn === undefined ? Effect.void : receive(conn, raw);
          }),
        ),
      closed: (id) =>
        locked(
          Effect.suspend(() => {
            const conn = conns.get(id);
            return conn === undefined ? Effect.void : handleClosed(conn);
          }),
        ),
      roomCount: locked(Effect.sync(() => rooms.size)),
    };
  });
