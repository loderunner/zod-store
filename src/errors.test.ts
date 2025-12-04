import { describe, expect, it } from 'vitest';

import { ZodJSONError } from './errors';

describe('ZodJSONError', () => {
  it('creates an error with code and message', () => {
    const error = new ZodJSONError('FileRead', 'Failed to read file');

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ZodJSONError);
    expect(error.name).toBe('ZodJSONError');
    expect(error.code).toBe('FileRead');
    expect(error.message).toBe('Failed to read file');
    expect(error.cause).toBeUndefined();
  });

  it('creates an error with cause', () => {
    const cause = new Error('ENOENT: no such file');
    const error = new ZodJSONError('FileRead', 'Failed to read file', cause);

    expect(error.code).toBe('FileRead');
    expect(error.message).toBe('Failed to read file');
    expect(error.cause).toBe(cause);
  });

  it('supports all error codes', () => {
    const codes = [
      'FileRead',
      'FileWrite',
      'InvalidJSON',
      'InvalidVersion',
      'UnsupportedVersion',
      'Validation',
      'Migration',
      'Encoding',
    ] as const;

    for (const code of codes) {
      const error = new ZodJSONError(code, `Error with code ${code}`);
      expect(error.code).toBe(code);
    }
  });
});
