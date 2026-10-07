import { McpStdioServer } from './mcp-stdio-server.ts';

const store = new Map<string, string>();

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v === '') {
    throw new Error(`argument "${key}" must be a non-empty string`);
  }
  return v;
}

new McpStdioServer('notes-server', '1.0.0', [
  {
    name: 'note_set',
    description: 'Store a text note under a key.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Note key.' },
        value: { type: 'string', description: 'Note text.' },
      },
      required: ['key', 'value'],
    },
    handler: (args) => {
      store.set(str(args, 'key'), str(args, 'value'));
      return 'ok';
    },
  },
  {
    name: 'note_get',
    description: 'Fetch a note by key.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string', description: 'Note key.' } },
      required: ['key'],
    },
    handler: (args) => {
      const v = store.get(str(args, 'key'));
      if (v === undefined) throw new Error('note not found');
      return v;
    },
  },
  {
    name: 'note_list',
    description: 'List all note keys.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => JSON.stringify([...store.keys()]),
  },
  {
    name: 'note_delete',
    description: 'Delete a note by key.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string', description: 'Note key.' } },
      required: ['key'],
    },
    handler: (args) => (store.delete(str(args, 'key')) ? 'ok' : 'missing'),
  },
]).run();
