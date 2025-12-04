/**
 * Error codes for different failure stages in ZodJSON/ZodYAML operations.
 */
export type ErrorCode =
  | 'FileRead' // File could not be read
  | 'FileWrite' // File could not be written
  | 'InvalidJSON' // File content is not valid JSON
  | 'InvalidYAML' // File content is not valid YAML
  | 'InvalidVersion' // _version field missing, not an integer, or <= 0
  | 'UnsupportedVersion' // File version > current schema version
  | 'Validation' // Zod schema validation failed
  | 'Migration' // Migration function threw
  | 'Encoding' // Schema encoding failed
  | 'MissingDependency'; // Optional dependency not installed

/**
 * Error thrown by ZodJSON operations.
 * The message is always user-friendly; callers can inspect `cause` for underlying details.
 */
export class ZodJSONError extends Error {
  code: ErrorCode;
  cause?: Error;

  constructor(code: ErrorCode, message: string, cause?: Error) {
    super(message);
    this.name = 'ZodJSONError';
    this.code = code;
    this.cause = cause;
  }
}
