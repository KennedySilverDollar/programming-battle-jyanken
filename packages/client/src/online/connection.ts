import { Socket } from "@effect/platform";
import { Duration, Effect, type Fiber, type Layer, Option, Schedule, Schema } from "effect";
import {
  type ClientMessage,
  decodeServerMessage,
  encodeClientMessage,
  type ServerMessage,
  SessionToken,
} from "@pbj/shared/protocol";

/**
 * サーバーとの WebSocket 接続（@effect/platform の Socket）。
 * - 接続は 1 本の Fiber として動き、切れたら待ってからつなぎ直す（その都度 Reconnect を送る）
 * - 受信したメッセージは購読者へ通知するだけ。表示側（Scene）は通知を受けて Fiber で演出する
 * - clientSeq は接続ごとに 0 から振る（サーバーも接続ごとに検査する）
 * - sessionToken はローカルストレージにだけ保存する
 */

export type Outgoing = ClientMessage extends infer M ? (M extends unknown ? Omit<M, "clientSeq"> : never) : never;

export type ConnectionStatus = "connecting" | "open" | "reconnecting";

/** sessionToken の保存先。ローカルストレージ以外には保存しない。 */
export interface TokenStore {
  readonly load: () => Option.Option<SessionToken>;
  readonly save: (token: SessionToken) => void;
  readonly clear: () => void;
}

const TOKEN_KEY = "programming-battle-jyanken.session.v1";
const decodeToken = Schema.decodeUnknownOption(SessionToken);

export const localStorageTokenStore: TokenStore = {
  load: () => {
    try {
      return decodeToken(window.localStorage.getItem(TOKEN_KEY));
    } catch {
      return Option.none();
    }
  },
  save: (token) => {
    try {
      window.localStorage.setItem(TOKEN_KEY, token);
    } catch {
      // 保存できなくても対戦は続けられる（再接続ができないだけ）
    }
  },
  clear: () => {
    try {
      window.localStorage.removeItem(TOKEN_KEY);
    } catch {
      // 同上
    }
  },
};

const HEARTBEAT = Duration.seconds(3);
const RETRY = Duration.seconds(2);

export class OnlineConnection {
  private readonly listeners = new Set<(m: ServerMessage) => void>();
  private readonly statusListeners = new Set<(s: ConnectionStatus) => void>();
  private write: Option.Option<(text: string) => Effect.Effect<void, Socket.SocketError>> = Option.none();
  private seq = 0;
  private fiber: Fiber.RuntimeFiber<never> | null = null;
  status: ConnectionStatus = "connecting";
  /** 最後に受け取った StateSync（Scene の切り替え直後に、現在の状態を描くため）。 */
  lastSync: Option.Option<Extract<ServerMessage, { readonly _tag: "StateSync" }>> = Option.none();

  constructor(
    readonly url: string,
    private readonly tokens: TokenStore,
    private readonly webSocket: Layer.Layer<Socket.WebSocketConstructor>,
  ) {}

  /** 接続 Fiber を起動する（何度呼んでも 1 本だけ）。 */
  start(): void {
    if (this.fiber !== null) return;
    this.fiber = Effect.runFork(this.program());
  }

  stop(): void {
    const fiber = this.fiber;
    this.fiber = null;
    if (fiber !== null) Effect.runFork(fiber.interruptAsFork(fiber.id()));
  }

  subscribe(listener: (m: ServerMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStatus(listener: (s: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  hasSession(): boolean {
    return Option.isSome(this.tokens.load());
  }

  /** 送信する（つながっていなければ捨てる。再接続後の StateSync で状態は戻る）。 */
  send(msg: Outgoing): void {
    if (msg._tag === "LeaveRoom") this.tokens.clear();
    Effect.runFork(this.sendEffect(msg));
  }

  private sendEffect(msg: Outgoing): Effect.Effect<void> {
    return Effect.suspend(() =>
      Option.match(this.write, {
        onNone: () => Effect.void,
        onSome: (write) => {
          const full: ClientMessage = { ...msg, clientSeq: this.seq };
          this.seq += 1;
          return encodeClientMessage(full).pipe(Effect.flatMap(write), Effect.ignore);
        },
      }),
    );
  }

  private setStatus(s: ConnectionStatus): void {
    this.status = s;
    for (const l of this.statusListeners) l(s);
  }

  private receive(raw: string | Uint8Array): Effect.Effect<void> {
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    return decodeServerMessage(text).pipe(
      Effect.tap((m) =>
        Effect.sync(() => {
          switch (m._tag) {
            case "RoomJoined":
              this.tokens.save(m.sessionToken);
              break;
            case "StateSync":
              this.lastSync = Option.some(m);
              break;
            case "Error":
              if (m.code === "SessionExpired") this.tokens.clear();
              break;
            case "MoveAccepted":
            case "TurnResolved":
            case "SkillActivated":
            case "HiddenTraitTriggered":
            case "MatchFinished":
              break;
          }
          for (const l of this.listeners) l(m);
        }),
      ),
      Effect.catchAll((e) => Effect.logWarning(`サーバーのメッセージを解釈できない: ${e.message}`)),
    );
  }

  private program(): Effect.Effect<never> {
    const once = Effect.scoped(
      Effect.gen(this, function* () {
        const scope = yield* Effect.scope;
        const socket = yield* Socket.makeWebSocket(this.url, { openTimeout: Duration.seconds(5) });
        const write = yield* socket.writer;
        const onOpen = Effect.gen(this, function* () {
          this.seq = 0;
          this.write = Option.some(write);
          this.setStatus("open");
          // 以前のセッションが残っていれば復帰を試みる（期限切れなら SessionExpired が返る）
          const token = this.tokens.load();
          if (Option.isSome(token)) yield* this.sendEffect({ _tag: "Reconnect", sessionToken: token.value });
          yield* Effect.forkIn(
            Effect.repeat(this.sendEffect({ _tag: "Heartbeat" }), Schedule.spaced(HEARTBEAT)),
            scope,
          );
        });
        yield* socket.runRaw((raw) => this.receive(raw), { onOpen });
      }),
    );
    return once.pipe(
      Effect.ignore,
      Effect.zipRight(
        Effect.sync(() => {
          this.write = Option.none();
          this.setStatus("reconnecting");
        }),
      ),
      Effect.zipRight(Effect.sleep(RETRY)),
      Effect.forever,
      Effect.provide(this.webSocket),
    );
  }
}

/** 接続先：VITE_SERVER_URL（ビルド時に指定）。無ければ同じホストの 8787 番。 */
export const serverUrl = (): string => {
  const configured: unknown = import.meta.env["VITE_SERVER_URL"];
  if (typeof configured === "string" && configured !== "") return configured;
  const secure = window.location.protocol === "https:";
  return `${secure ? "wss" : "ws"}://${window.location.hostname}:8787`;
};
