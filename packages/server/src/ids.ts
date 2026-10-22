import { randomUUID, webcrypto } from "node:crypto";
import { Context, Effect, Layer, Ref, Schema } from "effect";
import { MatchId, ROOM_CODE_ALPHABET, RoomCode, SessionToken } from "@pbj/shared/protocol";

/**
 * ID の発行。ルームコード・セッショントークンは推測されないよう暗号論的乱数で作る
 * （ゲームの乱数 RandomService とは別物。こちらはゲーム結果に影響しない）。
 */
export class Ids extends Context.Tag("Ids")<
  Ids,
  {
    readonly roomCode: Effect.Effect<RoomCode>;
    readonly sessionToken: Effect.Effect<SessionToken>;
    readonly matchId: Effect.Effect<MatchId>;
  }
>() {}

const decode =
  <A, I>(schema: Schema.Schema<A, I>) =>
  (raw: unknown): Effect.Effect<A> =>
    Effect.orDie(Schema.decodeUnknown(schema)(raw));

export const liveIds: Layer.Layer<Ids> = Layer.succeed(Ids, {
  roomCode: Effect.suspend(() => {
    const bytes = webcrypto.getRandomValues(new Uint8Array(6));
    // 32 文字のアルファベットなので剰余の偏りは無い
    return decode(RoomCode)(Array.from(bytes, (b) => ROOM_CODE_ALPHABET[b % ROOM_CODE_ALPHABET.length]).join(""));
  }),
  sessionToken: Effect.suspend(() => decode(SessionToken)(randomUUID())),
  matchId: Effect.suspend(() => decode(MatchId)(randomUUID())),
});

/** テスト用：連番から決定論的に ID を作る。codes を渡すとルームコードはその順に返す（衝突の再現用）。 */
export const testIds = (codes: readonly string[] = []): Layer.Layer<Ids> =>
  Layer.effect(
    Ids,
    Effect.gen(function* () {
      const counter = yield* Ref.make(0);
      const next = Ref.updateAndGet(counter, (n) => n + 1);
      const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
      return {
        roomCode: Effect.flatMap(next, (n) => {
          const fixed = codes[n - 1];
          const generated = Array.from({ length: 6 }, (_, i) => ROOM_CODE_ALPHABET[(n * 7 + i * 3) % 32]).join("");
          return decode(RoomCode)(fixed ?? generated);
        }),
        sessionToken: Effect.flatMap(next, (n) => decode(SessionToken)(uuid(n))),
        matchId: Effect.flatMap(next, (n) => decode(MatchId)(uuid(n + 0x100000))),
      };
    }),
  );
