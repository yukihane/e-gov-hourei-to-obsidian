/**
 * 指定ミリ秒だけ待機する。
 */
export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * APIベースURLから法令ページのベースURLを復元する。
 */
export function getLawSiteBaseUrl(apiBaseUrl: string): string {
  return apiBaseUrl.replace(/\/api\/2\/?$/, '').replace(/\/$/, '');
}
