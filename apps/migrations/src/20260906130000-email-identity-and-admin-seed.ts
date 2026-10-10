import { MigrationInterface, Db } from 'mongo-migrate-ts';
import bcrypt from 'bcryptjs';
import 'dotenv/config';

const ADMIN_EMAIL = 'formsatz@gmail.com';

export class EmailIdentityAndAdminSeed implements MigrationInterface {
  async up(db: Db): Promise<void> {
    const users = db.collection('users');

    const passwordHash = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin', 10);
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
