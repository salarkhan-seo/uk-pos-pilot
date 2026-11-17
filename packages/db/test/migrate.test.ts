/**
 * Unit tests for the migration SQL splitter (Build-02, Objective 1).
 *
 * The splitter must not break PL/pgSQL function bodies: a `;` inside a
 * dollar-quoted block is part of the function, not a statement boundary.
 * It must also ignore semicolons inside strings and comments.
 */
import { describe, expect, it } from 'vitest';
import { splitSqlStatements } from '../src/migrate';

describe('splitSqlStatements', () => {
  it('keeps a PL/pgSQL function body as one statement', () => {
    const script = `
      CREATE OR REPLACE FUNCTION f() RETURNS trigger AS $$
      BEGIN
        IF NEW.x > 0 THEN
          RAISE EXCEPTION 'bad; semicolon inside';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TABLE t (id int);
    `;
    const statements = splitSqlStatements(script);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("RAISE EXCEPTION 'bad; semicolon inside'");
    expect(statements[1]).toBe('CREATE TABLE t (id int)');
  });

  it('ignores semicolons in strings and line comments', () => {
    const statements = splitSqlStatements(`
      -- a comment; with a semicolon
      INSERT INTO t VALUES ('a;b');
      SELECT 1;
    `);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("'a;b'");
  });

  it('handles dollar-quoted tags other than $$', () => {
    const statements = splitSqlStatements(`
      CREATE FUNCTION g() RETURNS void AS $body$
      BEGIN
        PERFORM 1;
      END;
      $body$ LANGUAGE plpgsql;
      SELECT 2;
    `);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('PERFORM 1;');
  });

  it('drops empty statements', () => {
    expect(splitSqlStatements(';; SELECT 1; ;')).toEqual(['SELECT 1']);
  });
});
