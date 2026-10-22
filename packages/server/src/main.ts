import { NodeRuntime } from "@effect/platform-node";
import { Config, Effect } from "effect";
import { loadGameData } from "@pbj/shared/gameData";
import { DEFAULT_CONFIG } from "./config";
import { makeHub } from "./hub";
import { liveIds } from "./ids";
import { serveWebSocket } from "./ws";

/**
 * エントリポイント：ゲームデータを検証してから待ち受ける。環境変数：
 * - PORT（既定 8787。Render では Render が設定する）
 * - HOST（既定 0.0.0.0）
 * - ALLOWED_ORIGINS（カンマ区切り。例 `https://xxx.pages.dev,https://*.xxx.pages.dev`。空なら制限しない）
 */
const program = Effect.gen(function* () {
  const port = yield* Config.port("PORT").pipe(Config.withDefault(8787));
  const host = yield* Config.string("HOST").pipe(Config.withDefault("0.0.0.0"));
  const origins = yield* Config.string("ALLOWED_ORIGINS").pipe(Config.withDefault(""));
  const allowedOrigins = origins
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter((s) => s !== "");
  const data = yield* loadGameData();
  const hub = yield* makeHub(DEFAULT_CONFIG, data);
  return yield* serveWebSocket(hub, { port, host, allowedOrigins });
});

NodeRuntime.runMain(program.pipe(Effect.scoped, Effect.provide(liveIds)));
