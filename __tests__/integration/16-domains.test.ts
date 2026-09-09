import { connectClient, disconnectClient, callTool, parseJsonResult, parseErrorResult } from './helpers/mcp-client.js';
import { uniqueDomain, NONEXISTENT_ID } from './helpers/test-data.js';

beforeAll(() => connectClient());
afterAll(() => disconnectClient());

describe('Domains (17 tools)', () => {
  let domainId: string | undefined;

  // list_domains
  describe('list_domains', () => {
    it('lists domains for the account', async () => {
      const result = await callTool('list_domains', {});
      const data = parseJsonResult(result);
      expect(data).toBeDefined();
    });
  });

  // add_domain
  describe('add_domain', () => {
    it('adds a domain', async () => {
      const result = await callTool('add_domain', { domain: uniqueDomain() });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('id');
      domainId = data.id as string;
    });

    it('adds a domain with verification method', async () => {
      const result = await callTool('add_domain', {
        domain: uniqueDomain(),
        verification_method: 'manual_dns',
      });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('id');
      // Clean up
      if (data.id) await callTool('delete_domain', { id: data.id as string });
    });
  });

  // get_domain
  describe('get_domain', () => {
    it('gets a domain by ID', async () => {
      if (!domainId) return;
      const result = await callTool('get_domain', { id: domainId });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('id', domainId);
    });

    it('returns error for nonexistent ID', async () => {
      const result = await callTool('get_domain', { id: NONEXISTENT_ID });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // verify_domain
  describe('verify_domain', () => {
    it('triggers verification on a domain', async () => {
      if (!domainId) return;
      const result = await callTool('verify_domain', { id: domainId });
      // May fail (DNS not set up) but should not error fatally
      expect(result.content).toHaveLength(1);
    });

    it('returns error for nonexistent ID', async () => {
      const result = await callTool('verify_domain', { id: NONEXISTENT_ID });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // connect_cloudflare
  describe('connect_cloudflare', () => {
    it('returns error for nonexistent domain', async () => {
      const result = await callTool('connect_cloudflare', {
        id: NONEXISTENT_ID,
        api_token: 'fake_token_for_test',
      });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // connect_godaddy
  describe('connect_godaddy', () => {
    it('returns error for nonexistent domain', async () => {
      const result = await callTool('connect_godaddy', {
        id: NONEXISTENT_ID,
        api_key: 'fake_key',
        api_secret: 'fake_secret',
      });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // connect_dns_provider
  describe('connect_dns_provider', () => {
    it('returns error for nonexistent domain', async () => {
      const result = await callTool('connect_dns_provider', {
        id: NONEXISTENT_ID,
        provider: 'route53',
        credentials: { access_key: 'test', secret_key: 'test' },
      });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // add_verification_provider
  describe('add_verification_provider', () => {
    it('returns error for nonexistent domain', async () => {
      const result = await callTool('add_verification_provider', {
        id: NONEXISTENT_ID,
        provider: 'cloudflare',
        credentials: { api_token: 'test' },
      });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // get_dns_providers
  describe('get_dns_providers', () => {
    it('returns supported DNS providers', async () => {
      const result = await callTool('get_dns_providers', {});
      const data = parseJsonResult(result);
      expect(data).toBeDefined();
    });
  });

  // verify_domain_with_credentials
  describe('verify_domain_with_credentials', () => {
    it('returns error for nonexistent domain', async () => {
      const result = await callTool('verify_domain_with_credentials', { id: NONEXISTENT_ID });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // check_domain_credentials
  describe('check_domain_credentials', () => {
    it('returns error for nonexistent domain', async () => {
      const result = await callTool('check_domain_credentials', { id: NONEXISTENT_ID });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // start_domain_email_verification
  describe('start_domain_email_verification', () => {
    it('returns error for nonexistent domain', async () => {
      const result = await callTool('start_domain_email_verification', { id: NONEXISTENT_ID });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // confirm_domain_email_code
  describe('confirm_domain_email_code', () => {
    it('returns error for nonexistent domain', async () => {
      const result = await callTool('confirm_domain_email_code', { id: NONEXISTENT_ID, code: '000000' });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // resend_domain_email
  describe('resend_domain_email', () => {
    it('returns error for nonexistent domain', async () => {
      const result = await callTool('resend_domain_email', { id: NONEXISTENT_ID });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // setup_domain_email
  describe('setup_domain_email', () => {
    it('returns error for nonexistent domain', async () => {
      const result = await callTool('setup_domain_email', { id: NONEXISTENT_ID });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // check_domain_email_status
  describe('check_domain_email_status', () => {
    it('returns error for nonexistent domain', async () => {
      const result = await callTool('check_domain_email_status', { id: NONEXISTENT_ID });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // delete_domain (cleanup — run last)
  describe('delete_domain', () => {
    it('deletes a domain', async () => {
      if (!domainId) return;
      const result = await callTool('delete_domain', { id: domainId });
      expect(result.content).toHaveLength(1);
    });

    it('returns error for nonexistent ID', async () => {
      const result = await callTool('delete_domain', { id: NONEXISTENT_ID });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });
});
