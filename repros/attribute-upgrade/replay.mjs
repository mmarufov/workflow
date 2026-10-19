import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deserialize } from 'node:v8';

assert.equal(
  process.versions.node.split('.')[0],
  '24',
  'Use Node 24 as required by the tested checkout.'
);
assert(
  process.argv[2],
  'Usage: node replay.mjs /absolute/path/to/built/workflow/checkout [legacy|legacy-cancelled|post-fix]'
);
process.env.WORKFLOW_VM = 'node';
const checkout = resolve(process.argv[2]);
const fixture = process.argv[3] ?? 'legacy';
assert(
  ['legacy', 'legacy-cancelled', 'post-fix'].includes(fixture),
  'Choose legacy, legacy-cancelled or post-fix'
);
const here = join(
  fileURLToPath(new URL('.', import.meta.url)),
  'fixtures',
  fixture
);
const provenance = JSON.parse(
  await readFile(join(here, 'provenance.json'), 'utf8')
);
const bytes = await readFile(join(here, 'history.bin'));
const hash = (data) => createHash('sha256').update(data).digest('hex');
assert.equal(hash(bytes), provenance.historySha256);
assert.equal(
  hash(await readFile(join(here, 'workflows/race.ts'))),
  provenance.workflowSha256
);
const seed = deserialize(bytes);
const savedDecision = seed.events.find(
  (event) =>
    event.eventType === 'step_created' &&
    event.eventData.stepName.endsWith('//recordDecision')
);
assert(savedDecision, 'The fixture must contain the saved decision input.');
const savedResult = seed.events.find(
  (event) =>
    event.eventType === 'step_completed' &&
    event.correlationId === savedDecision.correlationId
);
assert(savedResult, 'The fixture must contain the saved decision result.');
const load = (path) => import(pathToFileURL(join(checkout, path)).href);
const core = await load('packages/core/dist/runtime.js');
const codec = await load('packages/core/dist/serialization-format.js');
const { buildSimBundle } = await load('packages/world-sim/dist/build.js');
const { loadFlowHandler } = await load('packages/world-sim/dist/index.js');
const { createVirtualClock } = await load('packages/world-sim/dist/clock.js');
const { createSimWorld, WORKFLOW_QUEUE_PREFIX } = await load(
  'packages/world-sim/dist/world.js'
);
const { driveQueue, DEFAULT_LIMITS } = await load(
  'packages/world-sim/dist/drive.js'
);

// Use core's installed dependencies for the temporary build; remove only this
// newly created directory afterwards. No tracked source or fixture is changed.
const app = await mkdtemp(join(checkout, 'packages/core/.attribute-upgrade-'));
let uninstallClock;
try {
  await mkdir(join(app, 'node_modules/@workflow'), { recursive: true });
  await symlink(
    join(checkout, 'packages/core'),
    join(app, 'node_modules/@workflow/core'),
    'dir'
  );
  await symlink(
    join(checkout, 'packages/workflow'),
    join(app, 'node_modules/workflow'),
    'dir'
  );
  await writeFile(
    join(app, 'package.json'),
    '{"type":"module","private":true}\n'
  );
  await cp(join(here, 'workflows'), join(app, 'workflows'), {
    recursive: true,
  });
  const runtimePath = createRequire(join(app, 'package.json')).resolve(
    'workflow/runtime'
  );
  assert.equal(
    (await import(pathToFileURL(runtimePath).href)).workflowEntrypoint,
    core.workflowEntrypoint
  );
  const bundle = await buildSimBundle({ cwd: app, dirs: ['workflows'] });
  assert.equal(
    bundle.workflowIds.attributeUpgradeWorkflow,
    seed.run.workflowName
  );
  const handler = await loadFlowHandler(bundle.flowBundlePath);
  const clock = createVirtualClock(
    Math.max(...seed.events.map((event) => event.createdAt.getTime())) + 1000
  );
  uninstallClock = clock.install();
  const world = createSimWorld({ clock, preconditionGuard: true });
  world.store.seedFromLog(seed.events);
  assert.deepEqual(world.store.allEvents(seed.run.runId), seed.events);
  world.registerHandler(WORKFLOW_QUEUE_PREFIX, handler);
  world.setScenarioApi(() => {
    throw new Error('No scripted interleaving is used during resume.');
  });
  core.setWorld(world);

  await world.asExternal(() =>
    core.resumeHook(`${seed.token}:finish`, 'continue')
  );
  const drain = await driveQueue({
    world,
    limits: { ...DEFAULT_LIMITS, maxWallMs: 15000 },
    wallStart: performance.now(),
  });
  assert(!drain.exceeded, drain.exceeded);
  const run = world.store
    .allRuns()
    .find((item) => item.runId === seed.run.runId);
  assert.equal(run?.status, 'completed', `Unexpected status: ${run?.status}`);
  const events = world.store.allEvents(seed.run.runId);
  assert.deepEqual(
    events.slice(0, seed.events.length),
    deserialize(bytes).events
  );
  assert.equal(
    hash(await readFile(join(here, 'history.bin'))),
    provenance.historySha256
  );
  const newStep = events.find(
    (event) =>
      event.eventType === 'step_created' &&
      event.eventData.stepName.endsWith('//recordAfterRestart')
  );
  assert(newStep, 'The follow-up step must actually execute.');
  const hydrate = (data) =>
    codec.hydrateData(data, codec.observabilityRevivers);
  const output = await hydrate(run.output);
  const input = await hydrate(newStep.eventData.input);
  const savedDecisionInput = await hydrate(savedDecision.eventData.input);
  const savedDecisionResult = await hydrate(savedResult.eventData.result);
  console.log(
    JSON.stringify(
      {
        runId: run.runId,
        status: run.status,
        output,
        savedDecisionInput,
        newStepInput: input,
        savedEventsUnchanged: true,
      },
      null,
      2
    )
  );
  assert.deepEqual(input.args, [output.winner, output.recorded, 'continue']);
  assert.deepEqual(savedDecisionInput.args, [output.recorded]);
  assert.equal(savedDecisionResult, output.recorded);
  assert.equal(
    output.winner,
    output.recorded,
    'Replay changed the decision passed to a new step, while reusing the previous step result.'
  );
  console.log('PASS: replay preserved the recorded decision.');
} finally {
  uninstallClock?.();
  await rm(app, { recursive: true, force: true });
}
