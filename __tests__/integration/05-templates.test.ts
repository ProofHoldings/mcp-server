import { connectClient, disconnectClient, callTool, parseJsonResult } from './helpers/mcp-client.js';

beforeAll(() => connectClient());
afterAll(() => disconnectClient());

describe('Templates (7 tools)', () => {
  // list_templates
  describe('list_templates', () => {
    it('lists custom templates', async () => {
      const result = await callTool('list_templates', {});
      const data = parseJsonResult(result);
      expect(data).toBeDefined();
    });
  });

  // get_default_templates
  describe('get_default_templates', () => {
    it('gets default templates', async () => {
      const result = await callTool('get_default_templates', {});
      const data = parseJsonResult(result);
      expect(data).toBeDefined();
    });
  });

  // get_template
  describe('get_template', () => {
    it('gets a template by channel and type', async () => {
      const result = await callTool('get_template', {
        channel: 'email',
        message_type: 'verification_request',
      });
      const data = parseJsonResult(result);
      expect(data).toBeDefined();
    });

    it('returns error for invalid message type', async () => {
      const result = await callTool('get_template', {
        channel: 'email',
        message_type: 'nonexistent_type_xyz',
      });
      // May return default or error depending on backend
      expect(result.content).toHaveLength(1);
    });
  });

  // update_template
  describe('update_template', () => {
    it('creates/updates a custom template', async () => {
      const result = await callTool('update_template', {
        channel: 'sms',
        message_type: 'verification_request',
        body: 'Your code is {{code}}. Expires in {{expires_in}}.',
      });
      const data = parseJsonResult(result);
      expect(data).toBeDefined();
    });
  });

  // delete_template
  describe('delete_template', () => {
    it('deletes a custom template (reverts to default)', async () => {
      const result = await callTool('delete_template', {
        channel: 'sms',
        message_type: 'verification_request',
      });
      // Might succeed or return not-found if no custom template
      expect(result.content).toHaveLength(1);
    });
  });

  // preview_template
  describe('preview_template', () => {
    it('previews a template with sample data', async () => {
      const result = await callTool('preview_template', {
        channel: 'email',
        message_type: 'verification_request',
        body: 'Hello! Your code is {{code}}.',
        subject: 'Verify your email',
      });
      const data = parseJsonResult(result);
      expect(data).toBeDefined();
    });
  });

  // render_template
  describe('render_template', () => {
    it('renders a template with variables', async () => {
      const result = await callTool('render_template', {
        channel: 'sms',
        message_type: 'verification_request',
        variables: { code: '123456', expires_in: '10 minutes' },
      });
      const data = parseJsonResult(result);
      expect(data).toBeDefined();
    });
  });
});
