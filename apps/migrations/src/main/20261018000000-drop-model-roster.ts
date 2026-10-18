import { MigrationInterface } from 'mongo-migrate-ts';
import { Db } from 'mongodb';

// Drops the model roster collection; routing is env-pinned since #387.
// @see #387
const SEED_ROWS = [
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

export class DropModelRoster implements MigrationInterface {
  async up(db: Db): Promise<void> {
    await db
      .collection('modelrosters')
      .drop()
      .catch(() => {});
  }

  async down(db: Db): Promise<void> {
    for (const row of SEED_ROWS) {
      await db
        .collection('modelrosters')
        .updateOne({ modelId: row.modelId }, { $set: row }, { upsert: true });
    }
  }
}
