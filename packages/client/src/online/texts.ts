import type { ErrorCode } from "@pbj/shared/protocol";

/** サーバーのエラーコードを画面用の文に（詳細はサーバーの message を添える）。 */
const ERROR_TEXT: Readonly<Record<ErrorCode, string>> = {
  RoomNotFound: "ルームが見つかりません",
  RoomFull: "ルームは満員です",
  InvalidTransition: "今はその操作はできません",
  StaleTurn: "そのターンはもう終わっています",
  NotYourTurn: "その操作はできません",
  InvalidSequence: "通信の順序が乱れました",
  RateLimited: "操作が速すぎます",
  SessionExpired: "前回のセッションは期限切れです",
  InvalidMessage: "不正な操作です",
  VersionMismatch: "クライアントのバージョンが古いです。再読み込みしてください",
};

export const errorText = (code: ErrorCode, message: string): string => `${ERROR_TEXT[code]}（${message}）`;
