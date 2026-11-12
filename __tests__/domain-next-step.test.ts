/**
 * A provider connection PUBLISHES the record; the domain is verified only once it is served in public DNS
 * (h-fix-provider-domain-verification-evidence). An agent reading a `verifying` answer must be told the
 * next step — never left to guess from a bare status — and the structured result must stay the API's.
 */
import { describe, it, expect } from 'vitest';
import { domainResult, PUBLISHED_RECORD_NEXT_STEP, NO_AUTO_RECHECK_NEXT_STEP } from '../src/tools/domains.js';

const row = (over: Record<string, unknown>) => ({ id: 'd1', domain: 'example.com', verification_method: 'auto_dns', ...over });

describe('domainResult', () => {
  it('adds the next step for a published, not-yet-served domain, naming the tools to call', () => {
    const result = domainResult(row({ status: 'verifying' }));
    const texts = result.content.map((c) => c.text);
    expect(texts).toContain(PUBLISHED_RECORD_NEXT_STEP);
    expect(PUBLISHED_RECORD_NEXT_STEP).toMatch(/get_domain/);
    expect(PUBLISHED_RECORD_NEXT_STEP).toMatch(/verify_domain/);
    expect((result as { structuredContent?: unknown }).structuredContent).toEqual(row({ status: 'verifying' }));
  });

  it('reads the row inside verify_domain\'s {data} envelope too', () => {
    const result = domainResult({ verified: false, message: 'x', data: row({ status: 'verifying' }) });
    expect(result.content.map((c) => c.text)).toContain(PUBLISHED_RECORD_NEXT_STEP);
  });

  it('adds nothing for a verified domain, or a verifying one that is not provider-published', () => {
    expect(domainResult(row({ status: 'verified' })).content).toHaveLength(1);
    expect(domainResult(row({ status: 'verifying', verification_method: 'email' })).content).toHaveLength(1);
  });

  it('a row the server is NOT re-checking (error_message present) is told to call verify_domain, never that the server keeps checking', () => {
    const result = domainResult(row({ status: 'verifying', error_message: 'any words' }));
    const texts = result.content.map((c) => c.text);
    expect(texts).toContain(NO_AUTO_RECHECK_NEXT_STEP);
    expect(texts).not.toContain(PUBLISHED_RECORD_NEXT_STEP);
    expect(NO_AUTO_RECHECK_NEXT_STEP).toMatch(/verify_domain/);
    expect(NO_AUTO_RECHECK_NEXT_STEP).not.toMatch(/keeps checking/);
  });

  it('a null or empty error_message is no signal', () => {
    for (const error_message of [null, '']) {
      expect(domainResult(row({ status: 'verifying', error_message })).content.map((c) => c.text)).toContain(PUBLISHED_RECORD_NEXT_STEP);
    }
  });
});
