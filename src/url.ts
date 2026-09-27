// Query parameters that sign a URL for one reader: presigned S3 and GCS links,
// CDN access tokens. They are credentials, not part of which page a URL names,
// so they never reach the ledger, the site or a recorded fixture.

const SIGNED_PARAM = /^(?:authorization|signature|sig|token|access_token|id_token|policy|key-pair-id|x-amz-.+|x-goog-.+)$/i;

export function isSignedParam(name: string): boolean {
  return SIGNED_PARAM.test(name);
}

/** `url` without its signing parameters. Anything else, including a URL with none, comes back unchanged. */
export function withoutSignedParams(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return url;
  const signed = [...u.searchParams.keys()].filter(isSignedParam);
  if (signed.length === 0) return url;
  for (const k of signed) u.searchParams.delete(k);
  return u.toString();
}

const HTTP_URL = /https?:\/\/[^\s"'\\<>]+/g;

/** Every http(s) URL in `text` without its signing parameters. */
export function stripSignedParamsIn(text: string): string {
  return text.replace(HTTP_URL, withoutSignedParams);
}
