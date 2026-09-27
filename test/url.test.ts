import { describe, expect, test } from 'bun:test';

import { stripSignedParamsIn, withoutSignedParams } from '../src/url.ts';

describe('withoutSignedParams', () => {
  test('drops presigned and token parameters, keeps the rest', () => {
    expect(withoutSignedParams('https://s3.example/r.pdf?id=7&X-Amz-Credential=a&X-Amz-Signature=b&Expires=1')).toBe('https://s3.example/r.pdf?id=7&Expires=1');
    expect(withoutSignedParams('https://files.example/doc?Authorization=abc.def')).toBe('https://files.example/doc');
    expect(withoutSignedParams('https://gcs.example/o?X-Goog-Signature=z&token=t&sig=s')).toBe('https://gcs.example/o');
  });

  test('anything without signing parameters comes back exactly as given', () => {
    for (const u of ['https://news.example/a b?q=1', 'https://Example.com', 'not a url', 'mailto:x@example.com']) {
      expect(withoutSignedParams(u)).toBe(u);
    }
  });

  test('stripSignedParamsIn cleans every URL in a text', () => {
    const json = JSON.stringify({ url: 'https://a.example/x?Authorization=secret', other: 'see https://b.example/y?sig=1&page=2 too' });
    const cleaned = stripSignedParamsIn(json);
    expect(cleaned).not.toContain('secret');
    expect(JSON.parse(cleaned)).toEqual({ url: 'https://a.example/x', other: 'see https://b.example/y?page=2 too' });
  });
});
