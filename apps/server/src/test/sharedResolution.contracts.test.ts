import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

// Drift test for the @tova/shared source-resolution points (#288). Every leg
// that resolves the shared package — client Vite alias, client tsconfig paths,
// server tsconfig paths, Jest moduleNameMapper — must point at apps/shared/src/main,
// so no leg can silently fall back to the built `dist` again. The server build
// config is pinned paths-free with `rootDir: src/main`, so shared source cannot
// enter an emitting program.
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');

const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf8');

type Config = { compilerOptions?: { paths?: Record<string, string[]>; rootDir?: string } };

const readTsConfig = (rel: string): Config => {
  // tsconfig files are JSONC (comments, trailing commas): use TypeScript's
  // reader rather than JSON.parse. `extends` is left unresolved, which is fine
  // for the fields pinned here (they are written literally in each file).
  const parsed = ts.readConfigFile(join(REPO_ROOT, rel), (p) => readFileSync(p, 'utf8'));
  if (parsed.error) {
    throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n'));
  }
  return parsed.config as Config;
};

const readJson = (rel: string): Record<string, unknown> =>
  JSON.parse(read(rel)) as Record<string, unknown>;

describe('@tova/shared source resolution (#288)', () => {
  it('client Vite alias points @shared at shared source', () => {
    expect(read('apps/client/vite.config.ts')).toContain(
      "'@shared': path.resolve(__dirname, '../shared/src/main')",
    );
  });

  it('client tsconfig paths point @shared/* at shared source', () => {
    expect(
      readTsConfig('apps/client/tsconfig.app.json').compilerOptions?.paths?.['@shared/*'],
    ).toEqual(['../shared/src/main/*']);
  });

  it('server tsconfig paths point @tova/shared at shared source', () => {
    expect(
      readTsConfig('apps/server/tsconfig.json').compilerOptions?.paths?.['@tova/shared'],
    ).toEqual(['../shared/src/main']);
  });

  it('jest resolves @tova/shared to shared source', () => {
    expect(read('jest.config.js')).toContain(
      "'^@tova/shared$': '<rootDir>/apps/shared/src/main/index.ts'",
    );
  });

  it('server build config stays paths-free with rootDir src/main', () => {
    const options = readTsConfig('apps/server/tsconfig.build.json').compilerOptions;
    expect(options?.paths).toEqual({});
    expect(options?.rootDir).toBe('src/main');
  });

  it('no workspace declares a lifecycle prepare script', () => {
    for (const workspace of ['client', 'server', 'shared', 'migrations']) {
      const pkg = readJson(`apps/${workspace}/package.json`) as {
        scripts?: Record<string, string>;
      };
      expect(pkg.scripts ?? {}).not.toHaveProperty('prepare');
    }
  });

  it('dev and typecheck no longer build shared as a prefix', () => {
    const scripts =
      (readJson('package.json') as { scripts?: Record<string, string> }).scripts ?? {};
    expect(scripts.dev ?? '').not.toContain('apps/shared');
    expect(scripts.typecheck ?? '').not.toContain('apps/shared');
  });
});
