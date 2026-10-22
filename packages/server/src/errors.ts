import { Data } from "effect";
import type { InvalidTransition } from "@pbj/shared/fsm";
import type { ErrorCode } from "@pbj/shared/protocol";

/**
 * サーバーの型付きエラー。どれも接続は切らず Error メッセージとして返す
 * （致命的なのは RateLimited 3 回・InvalidMessage 5 回の累積だけで、その判定は Hub が行う）。
 */
export class RoomNotFound extends Data.TaggedError("RoomNotFound")<{ readonly message: string }> {}
export class RoomFull extends Data.TaggedError("RoomFull")<{ readonly message: string }> {}
export class StaleTurn extends Data.TaggedError("StaleTurn")<{ readonly message: string }> {}
export class NotYourTurn extends Data.TaggedError("NotYourTurn")<{ readonly message: string }> {}
export class InvalidSequence extends Data.TaggedError("InvalidSequence")<{ readonly message: string }> {}
export class RateLimited extends Data.TaggedError("RateLimited")<{ readonly message: string }> {}
export class SessionExpired extends Data.TaggedError("SessionExpired")<{ readonly message: string }> {}
export class InvalidMessage extends Data.TaggedError("InvalidMessage")<{ readonly message: string }> {}
export class VersionMismatch extends Data.TaggedError("VersionMismatch")<{ readonly message: string }> {}

export type ServerError =
  | RoomNotFound
  | RoomFull
  | InvalidTransition
  | StaleTurn
  | NotYourTurn
  | InvalidSequence
  | RateLimited
  | SessionExpired
  | InvalidMessage
  | VersionMismatch;

/** エラーの _tag がそのままプロトコルのエラーコードになる（網羅性はコンパイラが保証）。 */
export const errorCode = (e: ServerError): ErrorCode => {
  switch (e._tag) {
    case "RoomNotFound":
    case "RoomFull":
    case "InvalidTransition":
    case "StaleTurn":
    case "NotYourTurn":
    case "InvalidSequence":
    case "RateLimited":
    case "SessionExpired":
    case "InvalidMessage":
    case "VersionMismatch":
      return e._tag;
  }
};
