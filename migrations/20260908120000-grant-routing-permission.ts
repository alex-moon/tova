import { MigrationInterface, Db } from 'mongo-migrate-ts';

const ADMIN_EMAIL = 'formsatz@gmail.com';

export class GrantRoutingPermission implements MigrationInterface {
  async up(db: Db): Promise<void> {
    await db
      .collection('users')
      .updateOne({ email: ADMIN_EMAIL }, { $addToSet: { permissions: 'routing' } });
  }

  async down(db: Db): Promise<void> {
    await db
      .collection('users')
      .updateOne({ email: ADMIN_EMAIL }, { $pull: { permissions: 'routing' } });
  }
}
