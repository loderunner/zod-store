import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ZodJSONError } from './errors';
import { type MigrationStep, createZodJSON } from './persistence';

type V1Data = { name: string };
type V2DataWithAge = { name: string; age: number };
type V2DataWithDisplayName = { name: string; displayName: string };
type V3DataWithEmail = { name: string; age: number; email: string };

type V1Value = { value: number };
type V2Value = { value: number; doubled: number };
type V3Value = { value: number; doubled: number; tripled: number };
type V3ValueQuad = { value: number; doubled: number; quadrupled: number };

type V1Id = { id: number };
type V2Id = { id: number; asyncField: string };

type V2Required = { name: string; required: string };
type V2Email = { name: string; email: string };

describe('createZodJSON', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zod-store-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('initialization', () => {
    it('creates a ZodJSON instance with just a schema', () => {
      const schema = z.object({ name: z.string() });
      const store = createZodJSON({ schema });

      expect(store).toHaveProperty('load');
      expect(store).toHaveProperty('save');
    });

    it('creates a ZodJSON instance with schema and default', () => {
      const schema = z.object({ name: z.string() });
      const store = createZodJSON({ schema, default: { name: 'test' } });

      expect(store).toHaveProperty('load');
      expect(store).toHaveProperty('save');
    });

    it('creates a ZodJSON instance with version and migrations', () => {
      const schemaV1 = z.object({ name: z.string() });
      const schemaV2 = z.object({ name: z.string(), age: z.number() });

      const migration: MigrationStep<1, V1Data, V2DataWithAge> = {
        version: 1,
        schema: schemaV1,
        migrate: (data) => ({ ...data, age: 0 }),
      };

      const store = createZodJSON({
        version: 2 as const,
        schema: schemaV2,
        migrations: [migration],
      });

      expect(store).toHaveProperty('load');
      expect(store).toHaveProperty('save');
    });

    it('throws if migration chain is not sequential', () => {
      const schemaV2 = z.object({ name: z.string(), age: z.number() });
      const schemaV3 = z.object({
        name: z.string(),
        age: z.number(),
        email: z.string(),
      });

      const migration: MigrationStep<2, V2DataWithAge, V3DataWithEmail> = {
        version: 2,
        schema: schemaV2,
        migrate: (data) => ({ ...data, email: '' }),
      };

      expect(() =>
        createZodJSON({
          version: 3 as const,
          schema: schemaV3,
          migrations: [migration], // Missing version 1
        }),
      ).toThrow('Migration chain must be sequential starting from version 1');
    });

    it('throws if migration chain has gaps', () => {
      const schemaV1 = z.object({ name: z.string() });
      const schemaV3 = z.object({
        name: z.string(),
        age: z.number(),
        email: z.string(),
      });

      type V4Data = { name: string; age: number; email: string; phone: string };

      const migration1: MigrationStep<1, V1Data, V2DataWithAge> = {
        version: 1,
        schema: schemaV1,
        migrate: (data) => ({ ...data, age: 0 }),
      };

      const migration3: MigrationStep<3, V3DataWithEmail, V4Data> = {
        version: 3,
        schema: schemaV3,
        migrate: (data) => ({ ...data, phone: '' }),
      };

      expect(() =>
        createZodJSON({
          version: 4 as const,
          schema: z.object({
            name: z.string(),
            age: z.number(),
            email: z.string(),
            phone: z.string(),
          }),
          migrations: [migration1, migration3], // Missing version 2
        }),
      ).toThrow('Migration chain must be sequential starting from version 1');
    });

    it('throws if migration chain does not end at currentVersion - 1', () => {
      const schemaV1 = z.object({ name: z.string() });

      const migration: MigrationStep<1, V1Data, V2DataWithAge> = {
        version: 1,
        schema: schemaV1,
        migrate: (data) => ({ ...data, age: 0 }),
      };

      expect(() =>
        createZodJSON({
          version: 3 as const,
          schema: z.object({
            name: z.string(),
            age: z.number(),
            email: z.string(),
          }),
          migrations: [migration], // Only migration for v1, but version is 3 (missing v2 migration)
        }),
      ).toThrow('Migration chain must end at version 2');
    });

    it('throws if migrations provided without version', () => {
      const schemaV1 = z.object({ name: z.string() });

      const migration: MigrationStep<1, V1Data, V2DataWithAge> = {
        version: 1,
        schema: schemaV1,
        migrate: (data) => ({ ...data, age: 0 }),
      };

      expect(() =>
        createZodJSON({
          schema: z.object({ name: z.string(), age: z.number() }),
          migrations: [migration],
        }),
      ).toThrow('Version is required when migrations are provided');
    });

    it('sorts migrations by version', async () => {
      const schemaV1 = z.object({ value: z.number() });
      const schemaV2 = z.object({ value: z.number(), doubled: z.number() });
      const schemaV3 = z.object({
        value: z.number(),
        doubled: z.number(),
        tripled: z.number(),
      });

      const migration1: MigrationStep<1, V1Value, V2Value> = {
        version: 1,
        schema: schemaV1,
        migrate: (data) => ({ ...data, doubled: data.value * 2 }),
      };

      const migration2: MigrationStep<2, V2Value, V3Value> = {
        version: 2,
        schema: schemaV2,
        migrate: (data) => ({ ...data, tripled: data.value * 3 }),
      };

      // Provide migrations out of order
      const store = createZodJSON({
        version: 3 as const,
        schema: schemaV3,
        migrations: [migration2, migration1],
      });

      // Write a v1 file and verify migrations run in correct order
      const filePath = path.join(tempDir, 'sorted.json');
      await fs.writeFile(filePath, JSON.stringify({ _version: 1, value: 5 }));

      const result = await store.load(filePath);
      expect(result).toEqual({ value: 5, doubled: 10, tripled: 15 });
    });
  });

  describe('load', () => {
    describe('file reading', () => {
      it('throws FileRead error when file does not exist', async () => {
        const schema = z.object({ name: z.string() });
        const store = createZodJSON({ schema });

        const filePath = path.join(tempDir, 'nonexistent.json');

        await expect(store.load(filePath)).rejects.toThrow(ZodJSONError);
        await expect(store.load(filePath)).rejects.toMatchObject({
          code: 'FileRead',
        });
      });

      it('returns default when file does not exist and default is configured', async () => {
        const schema = z.object({ name: z.string() });
        const store = createZodJSON({ schema, default: { name: 'default' } });

        const filePath = path.join(tempDir, 'nonexistent.json');
        const result = await store.load(filePath);

        expect(result).toEqual({ name: 'default' });
      });

      it('returns default from factory function', async () => {
        const schema = z.object({ name: z.string(), timestamp: z.number() });
        const store = createZodJSON({
          schema,
          default: () => ({ name: 'generated', timestamp: Date.now() }),
        });

        const filePath = path.join(tempDir, 'nonexistent.json');
        const result = await store.load(filePath);

        expect(result.name).toBe('generated');
        expect(typeof result.timestamp).toBe('number');
      });

      it('throws when throwOnError is true even with default', async () => {
        const schema = z.object({ name: z.string() });
        const store = createZodJSON({ schema, default: { name: 'default' } });

        const filePath = path.join(tempDir, 'nonexistent.json');

        await expect(
          store.load(filePath, { throwOnError: true }),
        ).rejects.toMatchObject({
          code: 'FileRead',
        });
      });
    });

    describe('JSON parsing', () => {
      it('throws InvalidJSON error for malformed JSON', async () => {
        const schema = z.object({ name: z.string() });
        const store = createZodJSON({ schema });

        const filePath = path.join(tempDir, 'invalid.json');
        await fs.writeFile(filePath, '{ not valid json }');

        await expect(store.load(filePath)).rejects.toMatchObject({
          code: 'InvalidJSON',
        });
      });

      it('returns default for malformed JSON when default is configured', async () => {
        const schema = z.object({ name: z.string() });
        const store = createZodJSON({ schema, default: { name: 'default' } });

        const filePath = path.join(tempDir, 'invalid.json');
        await fs.writeFile(filePath, '{ not valid json }');

        const result = await store.load(filePath);
        expect(result).toEqual({ name: 'default' });
      });
    });

    describe('unversioned mode', () => {
      it('loads valid JSON without version field', async () => {
        const schema = z.object({ name: z.string(), count: z.number() });
        const store = createZodJSON({ schema });

        const filePath = path.join(tempDir, 'data.json');
        await fs.writeFile(
          filePath,
          JSON.stringify({ name: 'test', count: 42 }),
        );

        const result = await store.load(filePath);
        expect(result).toEqual({ name: 'test', count: 42 });
      });

      it('throws Validation error for invalid data', async () => {
        const schema = z.object({ name: z.string(), count: z.number() });
        const store = createZodJSON({ schema });

        const filePath = path.join(tempDir, 'data.json');
        await fs.writeFile(
          filePath,
          JSON.stringify({ name: 'test', count: 'not a number' }),
        );

        await expect(store.load(filePath)).rejects.toMatchObject({
          code: 'Validation',
        });
      });
    });

    describe('versioned mode', () => {
      it('throws InvalidVersion error when _version field is missing', async () => {
        const schema = z.object({ name: z.string() });
        const store = createZodJSON({ version: 1 as const, schema });

        const filePath = path.join(tempDir, 'data.json');
        await fs.writeFile(filePath, JSON.stringify({ name: 'test' }));

        await expect(store.load(filePath)).rejects.toMatchObject({
          code: 'InvalidVersion',
          message: expect.stringContaining('Missing _version field') as string,
        });
      });

      it('throws InvalidVersion error for non-integer version', async () => {
        const schema = z.object({ name: z.string() });
        const store = createZodJSON({ version: 1 as const, schema });

        const filePath = path.join(tempDir, 'data.json');
        await fs.writeFile(
          filePath,
          JSON.stringify({ _version: 1.5, name: 'test' }),
        );

        await expect(store.load(filePath)).rejects.toMatchObject({
          code: 'InvalidVersion',
        });
      });

      it('throws InvalidVersion error for version <= 0', async () => {
        const schema = z.object({ name: z.string() });
        const store = createZodJSON({ version: 1 as const, schema });

        const filePath = path.join(tempDir, 'data.json');
        await fs.writeFile(
          filePath,
          JSON.stringify({ _version: 0, name: 'test' }),
        );

        await expect(store.load(filePath)).rejects.toMatchObject({
          code: 'InvalidVersion',
        });

        await fs.writeFile(
          filePath,
          JSON.stringify({ _version: -1, name: 'test' }),
        );

        await expect(store.load(filePath)).rejects.toMatchObject({
          code: 'InvalidVersion',
        });
      });

      it('throws InvalidVersion error for non-number version', async () => {
        const schema = z.object({ name: z.string() });
        const store = createZodJSON({ version: 1 as const, schema });

        const filePath = path.join(tempDir, 'data.json');
        await fs.writeFile(
          filePath,
          JSON.stringify({ _version: 'one', name: 'test' }),
        );

        await expect(store.load(filePath)).rejects.toMatchObject({
          code: 'InvalidVersion',
        });
      });

      it('throws UnsupportedVersion error for future version', async () => {
        const schema = z.object({ name: z.string() });
        const store = createZodJSON({ version: 2 as const, schema });

        const filePath = path.join(tempDir, 'data.json');
        await fs.writeFile(
          filePath,
          JSON.stringify({ _version: 5, name: 'test' }),
        );

        await expect(store.load(filePath)).rejects.toMatchObject({
          code: 'UnsupportedVersion',
          message: expect.stringContaining('version 5') as string,
        });
      });

      it('loads current version data successfully', async () => {
        const schema = z.object({ name: z.string(), count: z.number() });
        const store = createZodJSON({ version: 1 as const, schema });

        const filePath = path.join(tempDir, 'data.json');
        await fs.writeFile(
          filePath,
          JSON.stringify({ _version: 1, name: 'test', count: 42 }),
        );

        const result = await store.load(filePath);
        expect(result).toEqual({ name: 'test', count: 42 });
      });

      it('strips _version field from loaded data', async () => {
        const schema = z.object({ name: z.string() });
        const store = createZodJSON({ version: 1 as const, schema });

        const filePath = path.join(tempDir, 'data.json');
        await fs.writeFile(
          filePath,
          JSON.stringify({ _version: 1, name: 'test' }),
        );

        const result = await store.load(filePath);
        expect(result).toEqual({ name: 'test' });
        expect('_version' in result).toBe(false);
      });

      it('returns default for invalid version when default is configured', async () => {
        const schema = z.object({ name: z.string() });
        const store = createZodJSON({
          version: 1 as const,
          schema,
          default: { name: 'default' },
        });

        const filePath = path.join(tempDir, 'data.json');
        await fs.writeFile(filePath, JSON.stringify({ name: 'no version' }));

        const result = await store.load(filePath);
        expect(result).toEqual({ name: 'default' });
      });
    });

    describe('migrations', () => {
      it('migrates data from older version', async () => {
        const schemaV1 = z.object({ name: z.string() });
        const schemaV2 = z.object({
          name: z.string(),
          displayName: z.string(),
        });

        const migration: MigrationStep<1, V1Data, V2DataWithDisplayName> = {
          version: 1,
          schema: schemaV1,
          migrate: (data) => ({
            ...data,
            displayName: data.name.toUpperCase(),
          }),
        };

        const store = createZodJSON({
          version: 2 as const,
          schema: schemaV2,
          migrations: [migration],
        });

        const filePath = path.join(tempDir, 'data.json');
        await fs.writeFile(
          filePath,
          JSON.stringify({ _version: 1, name: 'alice' }),
        );

        const result = await store.load(filePath);
        expect(result).toEqual({ name: 'alice', displayName: 'ALICE' });
      });

      it('runs multiple migrations in sequence', async () => {
        const schemaV1 = z.object({ value: z.number() });
        const schemaV2 = z.object({ value: z.number(), doubled: z.number() });
        const schemaV3 = z.object({
          value: z.number(),
          doubled: z.number(),
          quadrupled: z.number(),
        });

        const migration1: MigrationStep<1, V1Value, V2Value> = {
          version: 1,
          schema: schemaV1,
          migrate: (data) => ({ ...data, doubled: data.value * 2 }),
        };

        const migration2: MigrationStep<2, V2Value, V3ValueQuad> = {
          version: 2,
          schema: schemaV2,
          migrate: (data) => ({ ...data, quadrupled: data.doubled * 2 }),
        };

        const store = createZodJSON({
          version: 3 as const,
          schema: schemaV3,
          migrations: [migration1, migration2],
        });

        const filePath = path.join(tempDir, 'data.json');
        await fs.writeFile(
          filePath,
          JSON.stringify({ _version: 1, value: 10 }),
        );

        const result = await store.load(filePath);
        expect(result).toEqual({ value: 10, doubled: 20, quadrupled: 40 });
      });

      it('supports async migrations', async () => {
        const schemaV1 = z.object({ id: z.number() });
        const schemaV2 = z.object({ id: z.number(), asyncField: z.string() });

        const migration: MigrationStep<1, V1Id, V2Id> = {
          version: 1,
          schema: schemaV1,
          migrate: async (data) => {
            // Simulate async operation
            await new Promise((resolve) => setTimeout(resolve, 10));
            return { ...data, asyncField: `async-${data.id}` };
          },
        };

        const store = createZodJSON({
          version: 2 as const,
          schema: schemaV2,
          migrations: [migration],
        });

        const filePath = path.join(tempDir, 'data.json');
        await fs.writeFile(filePath, JSON.stringify({ _version: 1, id: 42 }));

        const result = await store.load(filePath);
        expect(result).toEqual({ id: 42, asyncField: 'async-42' });
      });

      it('throws Migration error when migration fails', async () => {
        const schemaV1 = z.object({ name: z.string() });
        const schemaV2 = z.object({ name: z.string(), required: z.string() });

        const migration: MigrationStep<1, V1Data, V2Required> = {
          version: 1,
          schema: schemaV1,
          migrate: (): V2Required => {
            throw new Error('Migration failed intentionally');
          },
        };

        const store = createZodJSON({
          version: 2 as const,
          schema: schemaV2,
          migrations: [migration],
        });

        const filePath = path.join(tempDir, 'data.json');
        await fs.writeFile(
          filePath,
          JSON.stringify({ _version: 1, name: 'test' }),
        );

        await expect(store.load(filePath)).rejects.toMatchObject({
          code: 'Migration',
        });
      });

      it('throws Migration error when migration schema validation fails', async () => {
        const schemaV1 = z.object({ name: z.string() });
        const schemaV2 = z.object({ name: z.string(), age: z.number() });

        const migration: MigrationStep<1, V1Data, V2DataWithAge> = {
          version: 1,
          schema: schemaV1,
          migrate: (data) => ({ ...data, age: 0 }),
        };

        const store = createZodJSON({
          version: 2 as const,
          schema: schemaV2,
          migrations: [migration],
        });

        // File has wrong type for v1 schema
        const filePath = path.join(tempDir, 'data.json');
        await fs.writeFile(
          filePath,
          JSON.stringify({ _version: 1, name: 123 }), // name should be string
        );

        await expect(store.load(filePath)).rejects.toMatchObject({
          code: 'Migration',
        });
      });

      it('loads file at intermediate version and runs remaining migrations', async () => {
        const schemaV1 = z.object({ name: z.string() });
        const schemaV2 = z.object({ name: z.string(), age: z.number() });
        const schemaV3 = z.object({
          name: z.string(),
          age: z.number(),
          email: z.string(),
        });

        const migration1: MigrationStep<1, V1Data, V2DataWithAge> = {
          version: 1,
          schema: schemaV1,
          migrate: (data) => ({ ...data, age: 0 }),
        };

        const migration2: MigrationStep<2, V2DataWithAge, V3DataWithEmail> = {
          version: 2,
          schema: schemaV2,
          migrate: (data) => ({ ...data, email: '' }),
        };

        const store = createZodJSON({
          version: 3 as const,
          schema: schemaV3,
          migrations: [migration1, migration2],
        });

        // Create a version 2 file - only v2 migration should run
        const filePath = path.join(tempDir, 'data.json');
        await fs.writeFile(
          filePath,
          JSON.stringify({ _version: 2, name: 'test', age: 25 }),
        );

        const result = await store.load(filePath);
        expect(result).toEqual({ name: 'test', age: 25, email: '' });
      });

      it('returns default when migration fails and default is configured', async () => {
        const schemaV1 = z.object({ name: z.string() });
        const schemaV2 = z.object({ name: z.string(), required: z.string() });

        const migration: MigrationStep<1, V1Data, V2Required> = {
          version: 1,
          schema: schemaV1,
          migrate: (): V2Required => {
            throw new Error('Migration failed');
          },
        };

        const store = createZodJSON({
          version: 2 as const,
          schema: schemaV2,
          default: { name: 'default', required: 'default' },
          migrations: [migration],
        });

        const filePath = path.join(tempDir, 'data.json');
        await fs.writeFile(
          filePath,
          JSON.stringify({ _version: 1, name: 'test' }),
        );

        const result = await store.load(filePath);
        expect(result).toEqual({ name: 'default', required: 'default' });
      });
    });

    describe('validation', () => {
      it('throws Validation error for schema mismatch after migrations', async () => {
        const schemaV1 = z.object({ name: z.string() });
        const schemaV2 = z.object({
          name: z.string(),
          email: z.string().email(),
        });

        const migration: MigrationStep<1, V1Data, V2Email> = {
          version: 1,
          schema: schemaV1,
          migrate: (data) => ({ ...data, email: 'not-an-email' }), // Invalid email
        };

        const store = createZodJSON({
          version: 2 as const,
          schema: schemaV2,
          migrations: [migration],
        });

        const filePath = path.join(tempDir, 'data.json');
        await fs.writeFile(
          filePath,
          JSON.stringify({ _version: 1, name: 'test' }),
        );

        await expect(store.load(filePath)).rejects.toMatchObject({
          code: 'Validation',
        });
      });

      it('returns default when validation fails and default is configured', async () => {
        const schema = z.object({ name: z.string(), count: z.number() });
        const store = createZodJSON({
          schema,
          default: { name: 'default', count: 0 },
        });

        const filePath = path.join(tempDir, 'data.json');
        await fs.writeFile(
          filePath,
          JSON.stringify({ name: 'test', count: 'invalid' }),
        );

        const result = await store.load(filePath);
        expect(result).toEqual({ name: 'default', count: 0 });
      });
    });
  });

  describe('save', () => {
    describe('unversioned mode', () => {
      it('saves data without _version field', async () => {
        const schema = z.object({ name: z.string(), count: z.number() });
        const store = createZodJSON({ schema });

        const filePath = path.join(tempDir, 'data.json');
        await store.save({ name: 'test', count: 42 }, filePath);

        const content = await fs.readFile(filePath, 'utf-8');
        const parsed = JSON.parse(content) as Record<string, unknown>;

        expect(parsed).toEqual({ name: 'test', count: 42 });
        expect('_version' in parsed).toBe(false);
      });

      it('saves with pretty formatting by default', async () => {
        const schema = z.object({ name: z.string() });
        const store = createZodJSON({ schema });

        const filePath = path.join(tempDir, 'data.json');
        await store.save({ name: 'test' }, filePath);

        const content = await fs.readFile(filePath, 'utf-8');
        expect(content).toContain('\n');
        expect(content).toContain('  '); // 2-space indent
      });

      it('saves compact when option is set', async () => {
        const schema = z.object({ name: z.string() });
        const store = createZodJSON({ schema });

        const filePath = path.join(tempDir, 'data.json');
        await store.save({ name: 'test' }, filePath, { compact: true });

        const content = await fs.readFile(filePath, 'utf-8');
        expect(content).toBe('{"name":"test"}');
      });
    });

    describe('versioned mode', () => {
      it('saves data with _version field', async () => {
        const schema = z.object({ name: z.string() });
        const store = createZodJSON({ version: 3 as const, schema });

        const filePath = path.join(tempDir, 'data.json');
        await store.save({ name: 'test' }, filePath);

        const content = await fs.readFile(filePath, 'utf-8');
        const parsed = JSON.parse(content) as {
          _version: number;
          name: string;
        };

        expect(parsed._version).toBe(3);
        expect(parsed.name).toBe('test');
      });

      it('places _version first in output', async () => {
        const schema = z.object({ alpha: z.string(), beta: z.string() });
        const store = createZodJSON({ version: 1 as const, schema });

        const filePath = path.join(tempDir, 'data.json');
        await store.save({ alpha: 'a', beta: 'b' }, filePath);

        const content = await fs.readFile(filePath, 'utf-8');
        const keys = Object.keys(
          JSON.parse(content) as Record<string, unknown>,
        );

        expect(keys[0]).toBe('_version');
      });
    });

    describe('encoding', () => {
      it('encodes data through schema before saving', async () => {
        const schema = z.object({
          name: z.string(),
          tags: z.array(z.string()),
        });

        const store = createZodJSON({ schema });

        const filePath = path.join(tempDir, 'data.json');
        await store.save({ name: 'test', tags: ['a', 'b'] }, filePath);

        const content = await fs.readFile(filePath, 'utf-8');
        const parsed = JSON.parse(content) as { name: string; tags: string[] };

        expect(parsed).toEqual({ name: 'test', tags: ['a', 'b'] });
      });

      it('throws Encoding error when encoding fails', async () => {
        const schema = z.object({
          value: z.string().transform((v) => {
            if (v === 'fail') {
              throw new Error('Encoding failed');
            }
            return v;
          }),
        });

        const store = createZodJSON({ schema });
        const filePath = path.join(tempDir, 'data.json');

        // When encoding/validating 'fail', the transform will throw
        await expect(
          store.save({ value: 'fail' as unknown as string }, filePath),
        ).rejects.toMatchObject({
          code: 'Encoding',
        });
      });
    });

    describe('file writing', () => {
      it('throws FileWrite error when directory does not exist', async () => {
        const schema = z.object({ name: z.string() });
        const store = createZodJSON({ schema });

        const filePath = path.join(tempDir, 'nonexistent', 'data.json');

        await expect(
          store.save({ name: 'test' }, filePath),
        ).rejects.toMatchObject({
          code: 'FileWrite',
        });
      });

      it('overwrites existing file', async () => {
        const schema = z.object({ name: z.string() });
        const store = createZodJSON({ schema });

        const filePath = path.join(tempDir, 'data.json');
        await fs.writeFile(filePath, JSON.stringify({ name: 'old' }));

        await store.save({ name: 'new' }, filePath);

        const content = await fs.readFile(filePath, 'utf-8');
        const parsed = JSON.parse(content) as { name: string };
        expect(parsed.name).toBe('new');
      });
    });
  });

  describe('round-trip', () => {
    it('can save and load data without version', async () => {
      const schema = z.object({
        name: z.string(),
        count: z.number(),
        active: z.boolean(),
      });
      const store = createZodJSON({ schema });

      const filePath = path.join(tempDir, 'data.json');
      const original = { name: 'test', count: 42, active: true };

      await store.save(original, filePath);
      const loaded = await store.load(filePath);

      expect(loaded).toEqual(original);
    });

    it('can save and load data with version', async () => {
      const schema = z.object({
        name: z.string(),
        count: z.number(),
      });
      const store = createZodJSON({ version: 1 as const, schema });

      const filePath = path.join(tempDir, 'data.json');
      const original = { name: 'test', count: 42 };

      await store.save(original, filePath);
      const loaded = await store.load(filePath);

      expect(loaded).toEqual(original);
    });

    it('handles nested objects', async () => {
      const schema = z.object({
        user: z.object({
          name: z.string(),
          settings: z.object({
            theme: z.string(),
            notifications: z.boolean(),
          }),
        }),
      });
      const store = createZodJSON({ schema });

      const filePath = path.join(tempDir, 'data.json');
      const original = {
        user: {
          name: 'alice',
          settings: {
            theme: 'dark',
            notifications: true,
          },
        },
      };

      await store.save(original, filePath);
      const loaded = await store.load(filePath);

      expect(loaded).toEqual(original);
    });

    it('handles arrays', async () => {
      const schema = z.object({
        items: z.array(z.object({ id: z.number(), name: z.string() })),
      });
      const store = createZodJSON({ schema });

      const filePath = path.join(tempDir, 'data.json');
      const original = {
        items: [
          { id: 1, name: 'first' },
          { id: 2, name: 'second' },
        ],
      };

      await store.save(original, filePath);
      const loaded = await store.load(filePath);

      expect(loaded).toEqual(original);
    });
  });
});
