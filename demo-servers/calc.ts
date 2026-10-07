import { McpStdioServer } from './mcp-stdio-server.ts';

function num(args: Record<string, unknown>, key: string): number {
  const v = args[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`argument "${key}" must be a finite number`);
  }
  return v;
}

const numberArg = (desc: string) => ({ type: 'number', description: desc });

new McpStdioServer('calc-server', '1.0.0', [
  {
    name: 'add',
    description: 'Add two numbers.',
    inputSchema: {
      type: 'object',
      properties: { a: numberArg('First operand.'), b: numberArg('Second operand.') },
      required: ['a', 'b'],
    },
    handler: (args) => num(args, 'a') + num(args, 'b'),
  },
  {
    name: 'subtract',
    description: 'Subtract b from a.',
    inputSchema: {
      type: 'object',
      properties: { a: numberArg('Minuend.'), b: numberArg('Subtrahend.') },
      required: ['a', 'b'],
    },
    handler: (args) => num(args, 'a') - num(args, 'b'),
  },
  {
    name: 'multiply',
    description: 'Multiply two numbers.',
    inputSchema: {
      type: 'object',
      properties: { a: numberArg('First factor.'), b: numberArg('Second factor.') },
      required: ['a', 'b'],
    },
    handler: (args) => num(args, 'a') * num(args, 'b'),
  },
  {
    name: 'divide',
    description: 'Divide a by b.',
    inputSchema: {
      type: 'object',
      properties: { a: numberArg('Dividend.'), b: numberArg('Divisor, must not be zero.') },
      required: ['a', 'b'],
    },
    handler: (args) => {
      const b = num(args, 'b');
      if (b === 0) throw new Error('division by zero');
      return num(args, 'a') / b;
    },
  },
  {
    name: 'now',
    description: 'Return the current UTC time as an ISO string.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => new Date().toISOString(),
  },
]).run();
