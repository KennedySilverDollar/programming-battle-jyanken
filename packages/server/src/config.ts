/** タイマー・制限の設定（すべてサーバーの時計で判定する）。 */
export interface ServerConfig {
  /** 手選択（イベントループの追加の 1 手も同じ）の制限時間。満了で未選択の側はランダム代理選択。 */
  readonly selectTimeoutMs: number;
  /** 再接続の猶予。超過で切断側の負け（試合中）／退出（待機中）。 */
  readonly reconnectGraceMs: number;
  /** この時間メッセージ（ハートビート含む）が届かなければ切断とみなす。 */
  readonly heartbeatTimeoutMs: number;
  /** 1 秒あたりのメッセージ上限。超過は RateLimited。 */
  readonly rateLimitPerSecond: number;
  /** RateLimited がこの回数たまったら切断。 */
  readonly rateLimitStrikes: number;
  /** InvalidMessage がこの回数たまったら切断。 */
  readonly invalidMessageStrikes: number;
}

export const DEFAULT_CONFIG: ServerConfig = {
  selectTimeoutMs: 15_000,
  reconnectGraceMs: 30_000,
  heartbeatTimeoutMs: 10_000,
  rateLimitPerSecond: 5,
  rateLimitStrikes: 3,
  invalidMessageStrikes: 5,
};
