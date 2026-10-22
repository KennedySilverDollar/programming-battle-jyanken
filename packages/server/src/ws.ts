import { Socket, SocketServer } from "@effect/platform";
import { Effect } from "effect";
import type { Hub } from "./hub";

/**
 * WebSocket（@effect/platform の SocketServer）と Hub をつなぐ薄い層。
 * 接続ごとに 1 本の Fiber で受信し、受け取った文字列をそのまま Hub に渡す。
 */
const decoder = new TextDecoder();

export const serveWebSocket = (
  hub: Hub,
): Effect.Effect<never, SocketServer.SocketServerError, SocketServer.SocketServer> =>
  Effect.flatMap(SocketServer.SocketServer, (server) =>
    server.run((socket) =>
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
      ),
    ),
  );
