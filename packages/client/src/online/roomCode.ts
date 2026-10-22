import { ROOM_CODE_ALPHABET } from "@pbj/shared/protocol";

/** ルームコードの桁数。 */
export const ROOM_CODE_LENGTH = 6;

/** 紛らわしいのでコードに使っていない文字（打たれたら注意を出す）。 */
const CONFUSABLE = new Set(["O", "0", "I", "1"]);

export interface NormalizedCode {
  /** 正規化したコード（使える文字だけ・大文字・最大 6 文字）。 */
  readonly code: string;
  /** 使えない文字のうち、紛らわしい文字（0 O 1 I）が含まれていたか。 */
  readonly hadConfusable: boolean;
}

/**
 * 入力欄の文字列をルームコードに正規化する。
 * 全角英数字（IME が ON のままの入力）は NFKC で半角に、小文字は大文字に直し、
 * 空白・ハイフンなど使えない文字は捨てる（招待文から貼り付けても通るように）。
 */
export const normalizeRoomCode = (raw: string): NormalizedCode => {
  const chars = Array.from(raw.normalize("NFKC").toUpperCase());
  const code = chars
    .filter((c) => ROOM_CODE_ALPHABET.includes(c))
    .slice(0, ROOM_CODE_LENGTH)
    .join("");
  return { code, hadConfusable: chars.some((c) => CONFUSABLE.has(c)) };
};
