import { buildMongoUri } from './mongoUri';

describe('buildMongoUri', () => {
  it('defaults to the tova database', () => {
    expect(buildMongoUri(undefined, 'localhost', 'secret')).toBe(
      'mongodb://tova:secret@localhost/tova?authSource=admin',
    );
  });

  it('accepts an eval database name (issue #112)', () => {
    expect(buildMongoUri('tova_evals', 'localhost', 'secret')).toBe(
      'mongodb://tova:secret@localhost/tova_evals?authSource=admin',
    );
  });

  it('keeps the authSource when the database name changes', () => {
    expect(buildMongoUri('tova_evals', 'localhost', 'secret')).toContain('?authSource=admin');
  });
});
