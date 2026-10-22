import { NodeRuntime, NodeSocketServer } from "@effect/platform-node";
import { Config, Effect } from "effect";
import { loadGameData } from "@pbj/shared/gameData";
import { DEFAULT_CONFIG } from "./config";
import { makeHub } from "./hub";
import { liveIds } from "./ids";
import { serveWebSocket } from "./ws";

/** エントリポイント：ゲームデータを検証してから WebSocket サーバーを起動する。PORT（既定 8787）で待ち受ける。 */
const program = Effect.gen(function* () {
  const port = yield* Config.port("PORT").pipe(Config.withDefault(8787));
  const data = yield* loadGameData();
  const hub = yield* makeHub(DEFAULT_CONFIG, data);
  yield* Effect.logInfo(`じゃんけんチャンバラ対戦サーバー: ws://0.0.0.0:${String(port)}`);
  return yield* serveWebSocket(hub).pipe(Effect.provide(NodeSocketServer.layerWebSocket({ port })));
});

NodeRuntime.runMain(program.pipe(Effect.scoped, Effect.provide(liveIds)));
