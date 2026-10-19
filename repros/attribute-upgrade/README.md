# `setAttributes()` replay after #4861

Reproduction for the upgrade case in [#4848](https://github.com/vercel/workflow/pull/4848).

The [workflow](fixtures/legacy/workflows/race.ts) races `setAttributes()` against a cancellation hook, records the winner in a step, then waits for a finish hook. After resuming, it passes the winner and the saved decision to a new step. Those values should agree.

A run captured before [#4861](https://github.com/vercel/workflow/pull/4861) saved `prepared`. Resuming the same workflow and history on main (`eb9acbc8`) completes successfully with this output:

```json
{
  "winner": "cancelled",
  "recorded": "prepared",
  "signal": "continue"
}
```

Both values reach `recordAfterRestart()`. The script exits 1 when they disagree, even though the workflow completed.

The two old histories came from Postgres with deliberate database locks. The script replays them using the real runtime and an in-memory World, so you don't need Postgres to run it. The second capture already works on main and becomes inconsistent if it is listed in `WORKFLOW_LEGACY_ATTRIBUTE_RUN_IDS`.

## Reproduce

You need Node 24, pnpm 11.24.0, and Rust with the `wasm32-unknown-unknown` target to build the SWC plugin. From the root of this branch's checkout (`eb9acbc8` plus this directory):

```sh
pnpm install --frozen-lockfile
pnpm exec turbo run build --filter=@workflow/world-sim... --filter=workflow...

export WORKFLOW_LOG_ORDER_DRAWS=1  # pin the default
unset WORKFLOW_LEGACY_ATTRIBUTE_RUN_IDS
R=repros/attribute-upgrade/replay.mjs

node $R "$PWD" legacy            # exit 1: cancelled/prepared
node $R "$PWD" legacy-cancelled  # exit 0: cancelled/cancelled
node $R "$PWD" post-fix          # exit 0: cancelled/cancelled
```

Each invocation starts from a fresh copy of the saved history and checks that the original events stay unchanged.

## Compare runtimes

The first argument is the built checkout to test. Build the old runtime (`a04ecaa6`) and #4848 (`aa1c46cc`) in separate checkouts with the same install and build commands, then run these from the reproduction checkout in the same shell:

```sh
OLD=/path/to/a04ecaa6-checkout
PR=/path/to/aa1c46cc-checkout

node $R "$OLD" legacy            # exit 0: prepared/prepared
node $R "$OLD" legacy-cancelled  # exit 1: prepared/cancelled
node $R "$PR" legacy             # exit 1: cancelled/prepared (not listed)

export WORKFLOW_LEGACY_ATTRIBUTE_RUN_IDS=wrun_01M4YQ5T772WK1WC4RD6WYFXGB  # list legacy
node $R "$PR" legacy             # exit 0: prepared/prepared
node $R "$PR" legacy-cancelled   # exit 0: cancelled/cancelled (not listed)
node $R "$PR" post-fix           # exit 0: cancelled/cancelled

export WORKFLOW_LEGACY_ATTRIBUTE_RUN_IDS=wrun_01M4YQ4M0MY362BNWG9WNN6B9E  # list legacy-cancelled
node $R "$PR" legacy-cancelled   # exit 1: prepared/cancelled
```

Each cell below is the replayed winner / saved decision with the default `WORKFLOW_LOG_ORDER_DRAWS` setting. Bold cells disagree.

| Run | Old runtime (`a04ecaa6`) | Main (`eb9acbc8`) | #4848, not listed | #4848, listed |
| --- | --- | --- | --- | --- |
| [`legacy`](fixtures/legacy) | `prepared/prepared` | **`cancelled/prepared`** | **`cancelled/prepared`** | `prepared/prepared` |
| [`legacy-cancelled`](fixtures/legacy-cancelled) | **`prepared/cancelled`** | `cancelled/cancelled` | `cancelled/cancelled` | **`prepared/cancelled`** |

Both old runs have the same workflow, SDK version and event order, but saved different winners. #4848 helps `legacy` and breaks `legacy-cancelled` if that run is listed. To check a run, replay separate copies with and without it listed and compare the step arguments against the saved inputs. Here, compare the first argument in `newStepInput` with `savedDecisionInput`. Only list a run if those arguments disagree when unlisted and agree when listed.

With `WORKFLOW_LOG_ORDER_DRAWS=0`, every tested runtime computes `cancelled` for both old histories. `legacy` stays inconsistent even when listed. Repeat any replay command with `WORKFLOW_LOG_ORDER_DRAWS=0` to check this.

The newer [`post-fix`](fixtures/post-fix) control stays `cancelled/cancelled` on main and on #4848 with `legacy` listed.

## Capture details

Both old histories used `a04ecaa6`, core 5.2.1, Node 24.11.0, PostgreSQL 17.10, Node VM and the default replay setting. I staged the timing with `SHARE` locks on `workflow_hooks` and `workflow_runs`, delaying the attribute update until `resumeHook` stored the cancellation. The run-table lock was held for about 16 ms. The SDK then saved its decision and waited for the finish hook. The exported events are unchanged.

`legacy` used one queue worker; `legacy-cancelled` used ten. The Postgres World default is 50. Of three ten-worker captures, two saved `prepared` and one saved `cancelled`. Without locks, 80 attempts on a simpler workflow without `getConflict()` never reached this ordering. I haven't established how often an application would encounter it.

Separately, three `prepared` histories captured with one worker showed the same mismatch on main after restarting the app and Postgres, using a restored database for each runtime. That comparison used `7882c814`, whose runtime code matches `eb9acbc8`. The capture and Postgres restart scripts are not included here.

The `post-fix` control was recorded in the simulator at `7882c814`. It uses a simpler workflow without `getConflict()` and virtual-clock timestamps, not a Postgres capture.

Versions, settings, lock evidence and file hashes are in the [legacy](fixtures/legacy/provenance.json) and [legacy-cancelled](fixtures/legacy-cancelled/provenance.json) provenance files. Each fixture also has a readable copy of its binary history. The old World predates #4757's time-zone fix, so its timestamps have a uniform UTC offset; event order and spacing are unchanged.
