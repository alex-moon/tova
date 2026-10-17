import { MigrationInterface } from 'mongo-migrate-ts';
import { Db } from 'mongodb';

// Seeds the fixed model roster (mirroring ROSTER_SEED); $setOnInsert so an admin edit is never clobbered by a re-run.
// @see #232 #233 #316
const ROWS = [
  {
    modelId: 'deepseek-ai/DeepSeek-V4.1-Flash',
    label: 'DeepSeek V4.1 Flash',
    tools: true,
    vision: true,
    contextLength: 1048576,
    inputPrice: 0.2,
    outputPrice: 0.6,
    eligible: true,
    providers: [
      {
        provider: 'deepinfra',
        modelId: 'deepseek-ai/DeepSeek-V4.1-Flash',
        inputPrice: 0.2,
        outputPrice: 0.6,
        enabled: true,
        disabledUntil: null,
      },
      {
        provider: 'fireworks',
        modelId: 'accounts/fireworks/models/deepseek-v4p1-flash',
        inputPrice: 0.3,
        outputPrice: 1.2,
        enabled: true,
        disabledUntil: null,
      },
    ],
  },
  {
    modelId: 'zai-org/GLM-5.3-Flash',
    label: 'GLM 5.3 Flash',
    tools: true,
    vision: true,
    contextLength: 1048576,
    inputPrice: 0.15,
    outputPrice: 0.5,
    eligible: true,
    providers: [
      {
        provider: 'deepinfra',
        modelId: 'zai-org/GLM-5.3-Flash',
        inputPrice: 0.15,
        outputPrice: 0.5,
        enabled: true,
        disabledUntil: null,
      },
      {
        provider: 'fireworks',
        modelId: 'accounts/fireworks/models/glm-5p3-flash',
        inputPrice: 0.15,
        outputPrice: 0.5,
        enabled: true,
        disabledUntil: null,
      },
    ],
  },
];

export class SeedModelRoster implements MigrationInterface {
  async up(db: Db): Promise<void> {
    for (const row of ROWS) {
      await db
        .collection('modelrosters')
        .updateOne({ modelId: row.modelId }, { $setOnInsert: row }, { upsert: true });
    }
  }

  async down(db: Db): Promise<void> {
    for (const row of ROWS) {
      await db.collection('modelrosters').deleteOne({ modelId: row.modelId });
    }
  }
}
