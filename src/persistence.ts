import fs from 'node:fs/promises';

import { ZodError, z } from 'zod';

import { ZodStoreError } from './errors';

/**
 * A migration step from version V to V+1.
 * TFrom is the data type at version V, TTo is the data type at version V+1.
 */
export type MigrationStep<V extends number, TFrom, TTo> = {
  /** The version this migration migrates FROM */
  version: V;
  /** The schema for validating data at this version before migration */
  schema: z.ZodType<TFrom>;
  /** The migration function that transforms data to the next version */
  migrate: (data: TFrom) => TTo | Promise<TTo>;
};

/**
 * Options for createZodStore, createZodJSON, and createZodYAML.
 * V is the current version number as a literal type.
 * T is the current version's data type.
 *
 * If migrations are provided, version must be defined.
 * If migrations are not provided, version can be undefined (and version field will be ignored in save/load).
 */
export type ZodStoreOptions<
  V extends number,
  T extends Record<string, unknown>,
> = {
  /** The Zod schema for validating and encoding data */
  schema: z.ZodObject<any, any> & z.ZodType<T>;
  /** Default value or factory function returned when loading fails and throwOnError is false */
  default?: T | (() => T);
  /** Current version number for versioned persistence */
  version?: V;
  /** Migration steps from previous versions */
  migrations?: MigrationStep<number, unknown, unknown>[];
};

export type LoadOptions = {
  /** If true, throw even if a default is configured */
  throwOnError?: boolean;
};

export type SaveOptions = {
  /** If true, save without indentation */
  compact?: boolean;
};

/**
 * A persistence store with typed load and save methods.
 */
export type ZodStore<T> = {
  /**
   * Loads and validates data from a file.
   *
   * @param path - Path to the file
   * @param options - Load options
   * @returns The validated data
   */
  load(path: string, options?: LoadOptions): Promise<T>;
  /**
   * Saves data to a file.
   *
   * @param data - The data to save
   * @param path - Path to the file
   * @param options - Save options
   */
  save(data: T, path: string, options?: SaveOptions): Promise<void>;
};

/**
 * A serializer that converts between data and string representation.
 */
export type Serializer = {
  /** Parses a string into data. Throws on invalid format. */
  parse(content: string): unknown;
  /** Stringifies data, optionally in compact form. */
  stringify(data: unknown, compact: boolean): string;
  /** Format name for error messages (e.g., "JSON", "YAML") */
  formatName: string;
};

/**
 * JSON serializer implementation.
 */
export const jsonSerializer: Serializer = {
  parse(content: string): unknown {
    return JSON.parse(content);
  },
  stringify(data: unknown, compact: boolean): string {
    return compact ? JSON.stringify(data) : JSON.stringify(data, null, 2);
  },
  formatName: 'JSON',
};

/**
 * Creates a ZodStore persistence instance with the given serializer.
 *
 * @param options - Configuration options
 * @param serializer - The serializer to use for parsing and stringifying
 * @returns A persistence instance with typed load and save methods
 */
export function createZodStore<
  V extends number,
  T extends Record<string, unknown>,
>(options: ZodStoreOptions<V, T>, serializer: Serializer): ZodStore<T> {
  const {
    version: currentVersion,
    schema,
    default: defaultValue,
    migrations = [],
  } = options;

  // Sort migrations by version ascending
  const sortedMigrations = [...migrations].sort(
    (a, b) => a.version - b.version,
  );

  // Validate migration chain is sequential
  for (let i = 0; i < sortedMigrations.length; i++) {
    const expectedVersion = i + 1;
    if (sortedMigrations[i].version !== expectedVersion) {
      throw new Error(
        `Migration chain must be sequential starting from version 1. Found version ${sortedMigrations[i].version} at position ${i}`,
      );
    }
  }

  // Validate migrations end at current version - 1
  if (sortedMigrations.length > 0) {
    if (currentVersion === undefined) {
      // This should be caught by TypeScript, but runtime check for safety
      throw new Error(
        'Version is required when migrations are provided. This should be caught by TypeScript.',
      );
    }
    const lastMigrationVersion =
      sortedMigrations[sortedMigrations.length - 1].version;
    if (lastMigrationVersion !== currentVersion - 1) {
      throw new Error(
        `Migration chain must end at version ${currentVersion - 1}, but last migration is for version ${lastMigrationVersion}`,
      );
    }
  }

  async function load(filePath: string, loadOptions?: LoadOptions): Promise<T> {
    const { throwOnError = false } = loadOptions ?? {};

    // Read file
    let fileContent: string;
    try {
      fileContent = await fs.readFile(filePath, 'utf-8');
    } catch (error) {
      if (throwOnError || defaultValue === undefined) {
        throw new ZodStoreError(
          'FileRead',
          `Failed to read file: ${filePath}`,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
      return getDefault();
    }

    // Parse content
    let parsed: unknown;
    try {
      parsed = serializer.parse(fileContent);
    } catch (error) {
      if (throwOnError || defaultValue === undefined) {
        throw new ZodStoreError(
          'InvalidFormat',
          `Invalid ${serializer.formatName} in file: ${filePath}`,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
      return getDefault();
    }

    let data: unknown;
    if (currentVersion !== undefined) {
      // Versioned mode: expect _version field
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !('_version' in parsed)
      ) {
        if (throwOnError || defaultValue === undefined) {
          throw new ZodStoreError(
            'InvalidVersion',
            `Missing _version field in file: ${filePath}`,
          );
        }
        return getDefault();
      }

      const versionValue = parsed._version;
      if (
        typeof versionValue !== 'number' ||
        !Number.isInteger(versionValue) ||
        versionValue <= 0
      ) {
        if (throwOnError || defaultValue === undefined) {
          throw new ZodStoreError(
            'InvalidVersion',
            `Invalid _version field in file: ${filePath}. Expected integer > 0, got ${JSON.stringify(versionValue)}`,
          );
        }
        return getDefault();
      }
      const fileVersion = versionValue;

      // Check for unsupported future version
      if (fileVersion > currentVersion) {
        if (throwOnError || defaultValue === undefined) {
          throw new ZodStoreError(
            'UnsupportedVersion',
            `Unsupported file version ${fileVersion} in ${filePath}. Current schema version is ${currentVersion}`,
          );
        }
        return getDefault();
      }

      // Extract data (remove _version)
      const { _version: _unused, ...extractedData } = parsed as {
        _version: number;
        [key: string]: unknown;
      };
      data = extractedData;

      let dataVersion = fileVersion;
      while (dataVersion < currentVersion) {
        const migration = sortedMigrations.find(
          (m) => m.version === dataVersion,
        );

        if (migration === undefined) {
          if (throwOnError || defaultValue === undefined) {
            throw new ZodStoreError(
              'Migration',
              `No migration found for version ${dataVersion} in file: ${filePath}`,
            );
          }
          return getDefault();
        }

        try {
          // Parse with migration's schema
          const parsedData = await migration.schema.parseAsync(data);

          // Run migration (handle both sync and async)
          const migrationResult = migration.migrate(parsedData);
          data = await Promise.resolve(migrationResult);

          dataVersion++;
        } catch (error) {
          if (throwOnError || defaultValue === undefined) {
            let message = `Migration from version ${dataVersion} failed in file: ${filePath}`;
            if (error instanceof ZodError) {
              message = `${message}\n${z.prettifyError(error)}`;
            }
            throw new ZodStoreError(
              'Migration',
              message,
              error instanceof Error ? error : new Error(String(error)),
            );
          }
          return getDefault();
        }
      }
    } else {
      data = parsed;
    }

    // Validate final data with current schema
    try {
      const result = await schema.parseAsync(data);
      return result;
    } catch (error) {
      if (throwOnError || defaultValue === undefined) {
        let message = `Schema validation failed for file: ${filePath}`;
        if (error instanceof ZodError) {
          message = `${message}\n${z.prettifyError(error)}`;
        }
        throw new ZodStoreError(
          'Validation',
          message,
          error instanceof ZodError ? error : new Error(String(error)),
        );
      }
      return getDefault();
    }
  }

  async function save(
    data: T,
    filePath: string,
    saveOptions?: SaveOptions,
  ): Promise<void> {
    const { compact = false } = saveOptions ?? {};

    // Encode data with schema (for codec support)
    // Use encodeAsync to support async transforms
    let encoded: unknown;
    try {
      encoded = await schema.encodeAsync(data);
    } catch (error) {
      let message = `Schema encoding failed for file: ${filePath}`;
      if (error instanceof ZodError) {
        message = `${message}\n${z.prettifyError(error)}`;
      }
      throw new ZodStoreError(
        'Encoding',
        message,
        error instanceof ZodError ? error : new Error(String(error)),
      );
    }

    // Wrap with version (only if version is configured)
    const fileData =
      currentVersion !== undefined
        ? {
            _version: currentVersion,
            ...(typeof encoded === 'object' && encoded !== null ? encoded : {}),
          }
        : encoded;

    // Stringify data
    const content = serializer.stringify(fileData, compact);

    // Write file
    try {
      await fs.writeFile(filePath, content, 'utf-8');
    } catch (error) {
      throw new ZodStoreError(
        'FileWrite',
        `Failed to write file: ${filePath}`,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  function getDefault(): T {
    if (defaultValue === undefined) {
      throw new Error('No default value configured');
    }
    if (typeof defaultValue === 'function') {
      return defaultValue();
    }
    return defaultValue;
  }

  return {
    load,
    save,
  };
}

// Legacy type aliases for backwards compatibility
/** @deprecated Use ZodStore instead */
export type ZodJSON<T> = ZodStore<T>;
/** @deprecated Use ZodStoreOptions instead */
export type ZodJSONOptions<
  V extends number,
  T extends Record<string, unknown>,
> = ZodStoreOptions<V, T>;

/**
 * Creates a ZodStore persistence instance for versioned JSON files with Zod validation.
 *
 * @param options - Configuration options
 * @returns A persistence instance with typed load and save methods
 *
 * @example
 * ```typescript
 * // Without version - version field is ignored in save/load
 * const SettingsSchema = z.object({ theme: z.string() });
 * const settings = createZodJSON({
 *   schema: SettingsSchema,
 *   default: { theme: 'light' },
 * });
 *
 * // With migrations - version must be explicitly provided
 * const settingsV2 = createZodJSON({
 *   version: 2 as const,
 *   schema: SettingsSchemaV2,
 *   migrations: [
 *     { version: 1, schema: SettingsSchemaV1, migrate: (v1) => ({ ...v1, newField: 'default' }) },
 *   ],
 * });
 *
 * const data = await settings.load('/path/to/settings.json');
 * await settings.save(data, '/path/to/settings.json');
 * ```
 */
export function createZodJSON<
  V extends number,
  T extends Record<string, unknown>,
>(options: ZodStoreOptions<V, T>): ZodStore<T> {
  return createZodStore(options, jsonSerializer);
}
