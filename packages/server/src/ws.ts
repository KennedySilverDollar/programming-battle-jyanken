import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Socket } from "@effect/platform";
import { Effect, FiberSet } from "effect";
import { type WebSocket as WsSocket, WebSocketServer } from "ws";
import type { Hub } from "./hub";

/**
 * HTTP サーバーの上に WebSocket を載せ、Hub とつなぐ薄い層。
 * - GET /healthz は 200（Render などのヘルスチェック用）。それ以外の HTTP は 426
 * - Origin が許可リストに無い接続は握手の段階で断る（リストが空なら制限しない）
 * - 接続ごとに 1 本の Fiber で受信し、受け取った文字列をそのまま Hub に渡す
 */

export interface ListenOptions {
  readonly port: number;
  readonly host: string;
  /** 許可する Origin（`https://*.pages.dev` のように先頭のサブドメインを * にできる）。空なら制限しない。 */
  readonly allowedOrigins: readonly string[];
}

/** 1 メッセージの上限（プロトコルのメッセージは 1KB 未満）。 */
const MAX_PAYLOAD = 16 * 1024;
/** サーバー再起動（1012 Service Restart）。クライアントは再接続を試みる。 */
const CLOSE_RESTART = 1012;

const decoder = new TextDecoder();

export const originAllowed = (allowed: readonly string[], origin: string | undefined): boolean => {
  if (allowed.length === 0) return true;
  if (origin === undefined) return false;
  return allowed.some((pattern) => {
    const star = pattern.indexOf("://*.");
    if (star < 0) return pattern === origin;
    const scheme = pattern.slice(0, star + 3);
    const suffix = pattern.slice(star + 4);
    return origin.startsWith(scheme) && origin.endsWith(suffix) && origin.length > scheme.length + suffix.length;
  });
};

/**
 * ws の WebSocket を @effect/platform の Socket に渡すための型の橋渡し。
 * @effect/platform-node 自身も同じ ws の接続を Socket.fromWebSocket に渡している（API は互換）。
 */
const isWebSocketLike = (ws: WsSocket): ws is WsSocket & globalThis.WebSocket =>
  typeof ws.send === "function" && typeof ws.close === "function" && typeof ws.addEventListener === "function";

/** 1 本の接続を Hub につなぎ、切れるまで受信する。 */
const handleSocket = (hub: Hub, socket: Socket.Socket): Effect.Effect<void> =>
  Effect.scoped(
    Effect.gen(function* () {
      const write = yield* socket.writer;
      const id = yield* hub.open({
        send: (text) => Effect.ignore(write(text)),
        // Hub はロックの中から呼ぶので、閉じる処理は待たずに別 Fiber で進める
        close: (code, reason) =>
          Effect.asVoid(Effect.forkDaemon(Effect.ignore(write(new Socket.CloseEvent(code, reason))))),
      });
      yield* socket
        .runRaw((data) => hub.message(id, typeof data === "string" ? data : decoder.decode(data)))
        .pipe(Effect.ignore, Effect.ensuring(hub.closed(id)));
    }),
  );

const respond = (hub: Hub) => (req: IncomingMessage, res: ServerResponse) => {
  if (req.method === "GET" && (req.url === "/healthz" || req.url === "/")) {
    void Effect.runPromise(hub.roomCount).then((rooms) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, rooms }));
    });
    return;
  }
  res.writeHead(426, { "content-type": "text/plain; charset=utf-8" });
  res.end("WebSocket で接続してください\n");
};

/** 待ち受けを始め、スコープが閉じる（SIGTERM など）まで動き続ける。 */
export const serveWebSocket = (hub: Hub, options: ListenOptions): Effect.Effect<never, Error> =>
  Effect.scoped(
    Effect.gen(function* () {
      const run = yield* FiberSet.makeRuntime();
      const http = yield* Effect.acquireRelease(
        Effect.sync(() => createServer(respond(hub))),
        (server) =>
          Effect.async((resume: (done: Effect.Effect<void>) => void) => {
            server.close(() => {
              resume(Effect.void);
            });
            server.closeAllConnections();
          }),
      );
      const wss = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new WebSocketServer({
              server: http,
              maxPayload: MAX_PAYLOAD,
              verifyClient: (info: { readonly origin: string | undefined }) =>
                originAllowed(options.allowedOrigins, info.origin),
            }),
        ),
        (server) =>
          Effect.async((resume: (done: Effect.Effect<void>) => void) => {
            for (const client of server.clients) client.close(CLOSE_RESTART, "server restart");
            server.close(() => {
              resume(Effect.void);
            });
          }),
      );
      wss.on("connection", (conn) => {
        if (!isWebSocketLike(conn)) {
          conn.terminate();
          return;
        }
        const socket = Socket.fromWebSocket(
          Effect.acquireRelease(Effect.succeed(conn), (c) =>
            Effect.sync(() => {
              c.close();
            }),
          ),
        );
        run(Effect.flatMap(socket, (s) => handleSocket(hub, s)));
      });
      yield* Effect.async((resume: (done: Effect.Effect<void, Error>) => void) => {
        http.once("error", (e) => {
          resume(Effect.fail(e));
        });
        http.listen(options.port, options.host, () => {
          resume(Effect.void);
        });
      });
      yield* Effect.logInfo(`じゃんけんチャンバラ対戦サーバー: ws://${options.host}:${String(options.port)}`);
      if (options.allowedOrigins.length > 0) {
        yield* Effect.logInfo(`許可する Origin: ${options.allowedOrigins.join(", ")}`);
      }
      return yield* Effect.never;
    }),
  );
