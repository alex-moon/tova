import { buildMongoUri } from './mongoUri';

const ORIGINAL_ENV = { ...process.env };

describe('buildMongoUri', () => {
  beforeEach(() => {
    delete process.env.MONGODB_URL;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  describe('local fallback (host/password assembly)', () => {
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

  describe('MONGODB_URL precedence (issue #138)', () => {
    it('wins over host/password and passes through verbatim', () => {
      process.env.MONGODB_URL = 'mongodb+srv://tova:pw@cluster.example.net/?appName=app';
      expect(buildMongoUri('tova_evals', 'localhost', 'secret')).toBe(
        'mongodb+srv://tova:pw@cluster.example.net/?appName=app',
      );
    });

    it('passes a plain (non-srv) URL through verbatim too', () => {
      process.env.MONGODB_URL = 'mongodb://tova:pw@mongodb:27017/tova?authSource=admin';
      expect(buildMongoUri()).toBe('mongodb://tova:pw@mongodb:27017/tova?authSource=admin');
    });

    it('treats whitespace-only as unset', () => {
      process.env.MONGODB_URL = '   ';
      expect(buildMongoUri(undefined, 'localhost', 'secret')).toBe(
        'mongodb://tova:secret@localhost/tova?authSource=admin',
      );
    });

    it('falls back when unset', () => {
      expect(process.env.MONGODB_URL).toBeUndefined();
      expect(buildMongoUri(undefined, 'localhost', 'secret')).toBe(
        'mongodb://tova:secret@localhost/tova?authSource=admin',
      );
    });
  });
});
