import { createHook, setAttributes } from '@workflow/core';

export async function attributeUpgradeWorkflow(token: string) {
  'use workflow';

  using cancel = createHook<string>({ token: `${token}:cancel` });
  const winner = await Promise.race([
    setAttributes({ phase: 'preparing' }).then(() => 'prepared'),
    (async () => {
      await cancel;
      return 'cancelled';
    })(),
  ]);
  const recorded = await recordDecision(winner);

  using finish = createHook<string>({ token: `${token}:finish` });
  const signal = await finish;
  return recordAfterRestart(winner, recorded, signal);
}

async function recordDecision(winner: string) {
  'use step';
  return winner;
}

async function recordAfterRestart(
  winner: string,
  recorded: string,
  signal: string
) {
  'use step';
  return { winner, recorded, signal };
}
