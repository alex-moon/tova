import { MigrationInterface, Db } from 'mongo-migrate-ts';
import bcrypt from 'bcryptjs';
import 'dotenv/config';

const ADMIN_EMAIL = 'formsatz@gmail.com';

export class EmailIdentityAndAdminSeed implements MigrationInterface {
  async up(db: Db): Promise<void> {
    const users = db.collection('users');

    const password = process.env.ADMIN_PASSWORD;
    if (!password) {
      throw new Error(
        'ADMIN_PASSWORD is not set: refusing to seed the admin user with a known default password. Set ADMIN_PASSWORD in .env (see .env.example).'
      );
    }
    const passwordHash = bcrypt.hashSync(password, 10);
    const now = new Date();
    await users.insertOne({
      email: ADMIN_EMAIL,
      passwordHash,
      role: 'admin',
      createdAt: now,
      updatedAt: now,
    });
  }

  async down(db: Db): Promise<void> {
    await db.collection('users').deleteOne({ email: ADMIN_EMAIL });
  }
}
