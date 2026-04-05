/**
 * Next.js 15+ may pass `params` as a Promise in App Router route handlers; Next 14 passes a plain object.
 * Always await this before reading segment params.
 */
export async function unwrapRouteParams<T extends Record<string, string>>(params: T | Promise<T>): Promise<T> {
  return await Promise.resolve(params);
}
