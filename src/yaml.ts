import fs from 'node:fs/promises';

import { ZodError, z } from 'zod';

import { ZodJSONError } from './errors';
import type { LoadOptions, MigrationStep, SaveOptions } from './persistence';

/**
 * Type definition for the js-yaml module.
 * Used for dynamic import type safety.
 */
type JsYaml = typeof import('js-yaml');

/**
 * Cached reference to the js-yaml module.
 * Lazily loaded on first use.
 */
let jsYamlModule: JsYaml | undefined;

/**
 * Dynamically imports and caches the js-yaml module.
 * Throws a helpful error if js-yaml is not installed.
 *
 * @returns The js-yaml module
 * @throws {ZodJSONError} with code 'MissingDependency' if js-yaml is not installed
 */
async function getJsYaml(): Promise<JsYaml> {
  if (jsYamlModule !== undefined) {
    return jsYamlModule;
  }

  try {
    jsYamlModule = await import('js-yaml');
    return jsYamlModule;
  } catch {
    throw new ZodJSONError(
      'MissingDependency',
      'js-yaml is required for YAML support. Install it with: npm install js-yaml',
    );
  }
}

/**
 * Options for createZodYAML.
 * V is the current version number as a literal type.
 * T is the current version's data type.
 *
 * If migrations are provided, version must be defined.
 * If migrations are not provided, version can be undefined (and version field will be ignored in save/load).
 */
export type ZodYAMLOptions<
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

export type ZodYAML<T> = {
  /**
   * Loads and validates data from a YAML file.
   *
   * @param path - Path to the YAML file
   * @param options - Load options
   * @returns The validated data
   */
  load(path: string, options?: LoadOptions): Promise<T>;
  /**
   * Saves data to a YAML file.
   *
   * @param data - The data to save
   * @param path - Path to the YAML file
   * @param options - Save options
   */
  save(data: T, path: string, options?: SaveOptions): Promise<void>;
};

/**
 * Creates a ZodYAML persistence instance for versioned YAML files with Zod validation.
 *
 * @param options - Configuration options
 * @returns A persistence instance with typed load and save methods
 *
 * @example
 * ```typescript
 * // Without version - version field is ignored in save/load
 * const SettingsSchema = z.object({ theme: z.string() });
 * const settings = createZodYAML({
 *   schema: SettingsSchema,
 *   default: { theme: 'light' },
 * });
 *
 * // With migrations - version must be explicitly provided
 * const settingsV2 = createZodYAML({
 *   version: 2 as const,
 *   schema: SettingsSchemaV2,
 *   migrations: [
 *     { version: 1, schema: SettingsSchemaV1, migrate: (v1) => ({ ...v1, newField: 'default' }) },
 *   ],
 * });
 *
 * const data = await settings.load('/path/to/settings.yaml');
 * await settings.save(data, '/path/to/settings.yaml');
 * ```
 */
export function createZodYAML<
  V extends number,
  T extends Record<string, unknown>,
>(options: ZodYAMLOptions<V, T>): ZodYAML<T> {
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

    // Ensure js-yaml is available before proceeding
    let yaml: JsYaml;
    try {
      yaml = await getJsYaml();
    } catch (error) {
      if (throwOnError || defaultValue === undefined) {
        throw error;
      }
      return getDefault();
    }

    // Read file
    let fileContent: string;
    try {
      fileContent = await fs.readFile(filePath, 'utf-8');
    } catch (error) {
      if (throwOnError || defaultValue === undefined) {
        throw new ZodJSONError(
          'FileRead',
          `Failed to read file: ${filePath}`,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
      return getDefault();
    }

    // Parse YAML
    let parsed: unknown;
    try {
      parsed = yaml.load(fileContent);
    } catch (error) {
      if (throwOnError || defaultValue === undefined) {
        throw new ZodJSONError(
          'InvalidYAML',
          `Invalid YAML in file: ${filePath}`,
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
          throw new ZodJSONError(
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
          throw new ZodJSONError(
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
          throw new ZodJSONError(
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
            throw new ZodJSONError(
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
            throw new ZodJSONError(
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
        throw new ZodJSONError(
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

    // Ensure js-yaml is available
    const yaml = await getJsYaml();

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
      throw new ZodJSONError(
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

    // Stringify YAML
    const yamlString = yaml.dump(fileData, {
      indent: compact ? 0 : 2,
      flowLevel: compact ? 0 : -1,
      lineWidth: compact ? -1 : 80,
    });

    // Write file
    try {
      await fs.writeFile(filePath, yamlString, 'utf-8');
    } catch (error) {
      throw new ZodJSONError(
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
