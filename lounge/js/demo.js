// Demo data. Rooms, tasks and steps are agent-sourced text (rendered with textContent);
// inside block reasons, `backticks` mark the bold part. The projects are made up.

import { FLOOR } from './places.js';

// The demo has no server, so it keeps its own floor list, as the server would send it.
const DEMO_FLOORS = [
  { project: 'webshop', floor: 1, theme: 'hall', locked: false },
  { project: 'api', floor: 2, theme: 'casino', locked: false },
  { project: 'mobile', floor: 3, theme: 'deco', locked: false },
  { project: 'docs', floor: 4, theme: 'tiki', locked: false },
  { project: 'scratch', floor: 5, theme: 'hall', locked: true },
];
export const demoFloors = () => DEMO_FLOORS.map(f => ({ ...f }));

const L = (model, skin, hair, hs, outfit, extra) => ({ model, skin, hair, hs, outfit, ...extra });
const I = (task, where, steps, minutes, tokens, extra) => ({ task, where, steps, minutes, tokens, ...extra });

export const DEMO_CAST = [
  ['deploy-app', 'queue', L('queued', 2, 0, 'short', 'shirt'),
    I('Ship version 2.3 of the shop', 'webshop', ['Arrived 3 min ago', 'Waiting for the doorman: 6 of 6 rooms active'], 3, '0', { project: 'webshop' })],
  ['docs-readme', 'queue', L('queued', 4, 2, 'bob', 'dress'),
    I('Rewrite the public API README', 'docs', ['Arrived 1 min ago'], 1, '0', { project: 'docs' })],
  ['lint-fix', 'queue', L('queued', 1, 3, 'hat', 'jacket', { tie: '#3a66b8' }),
    I('Fix the 48 lint warnings in the frontend', 'webshop', ['Just arrived'], 0, '0', { project: 'webshop' })],
  ['q3-report', 'sleep', L('sonnet', 0, 3, 'short', 'jacket', { beard: true }),
    I('Generate the third-quarter report', 'scratch', ['Generated 4 of 5 charts', 'Stopped: the last month of numbers is not in yet', 'Leaves on its own once the pending item is resolved'], 312, '96k', { project: 'scratch' })],
  ['nf-bug', 'work', L('opus', 0, 1, 'long', 'qipao'),
    I('Fix the rounding bug in invoice totals', 'api · fix/invoice-rounding', ['Read InvoiceTotals.java and Rounding.java', 'Reproduced the bug in a test (expected failure)', 'Editing the rounding rule', 'Running the invoice module suite'], 34, '182k', { project: 'api' })],
  ['api-pix', 'work', L('opus', 2, 0, 'spiky', 'jacket'),
    I('Instant-payment charge endpoint', 'api · feat/pix-charge', ['Designed the endpoint contract', 'Built the payment provider client with retry', 'Writing integration tests'], 51, '240k', { project: 'api' })],
  ['refactor-auth', 'work', L('sonnet', 4, 4, 'bun', 'shirt', { glasses: true }),
    I('Split social login from password login', 'mobile · refactor/auth', ['Mapped 14 uses of AuthService', 'Extracted SocialLoginService', 'Fixing the broken tests (3 of 9)'], 27, '120k', { project: 'mobile' })],
  ['e2e-tests', 'work', L('sonnet', 3, 0, 'short', 'shirt', { accent: '#f0c050' }),
    I('Cover the checkout flow with an end-to-end test', 'webshop · test/checkout-e2e', ['Started the local environment', 'Recorded the happy path', 'Writing the declined-card case'], 19, '64k', { project: 'webshop' })],
  ['nf-bug-haiku', 'slot', L('haiku', 1, 2, 'short', 'shirt'),
    I('Subagent of room nf-bug: read and summarize files', 'api', ['Reading 12 files from the invoice module', 'Summary goes to room nf-bug'], 2, '18k', { project: 'api' }), 'haiku'],
  ['api-pix-haiku', 'slot', L('haiku', 4, 5, 'bob', 'dress'),
    I('Subagent of room api-pix: read the payment provider docs', 'api', ['Reading 3 pages of documentation', 'Summary goes to room api-pix'], 1, '9k', { project: 'api' }), 'haiku'],
  ['new-room', 'coffee', L('sonnet', 1, 1, 'short', 'jacket', { tie: '#1f6b45' }),
    I('Find out why the app starts slowly', 'mobile', ['Got the request from reception', 'Drafting the plan: measure before changing anything'], 2, '11k', { project: 'mobile' })],
  ['pr-checkout', 'whisky', L('opus', 0, 6, 'long', 'dress'),
    I('New one-page checkout', 'webshop · feat/checkout-1p', ['Opened the PR', 'CI green, 2 approvals', 'Waiting for merge'], 96, '410k', { project: 'webshop' })],
  ['weekly-digest', 'ready', L('sonnet', 3, 6, 'bob', 'dress'),
    I('Summarize the week of merged changes', 'docs · chore/weekly-digest', ['Collected 23 merged changes', 'Wrote the digest draft', 'Last message: "The draft is in docs/digest.md. Want me to open a PR?"'], 14, '42k', { project: 'docs' })],
  ['ci-pipeline', 'smoke', L('sonnet', 1, 0, 'short', 'jacket'),
    I('Speed up the CI pipeline', 'api · ci/gradle-cache', ['Turned on the Gradle cache', 'Triggered CI to measure', 'Waiting for CI to finish (~8 min)'], 41, '88k', { project: 'api' })],
  ['pr-login', 'smoke', L('opus', 3, 5, 'bob', 'qipao'),
    I('New login screen', 'webshop · feat/login', ['Opened the PR', 'Waiting for the review bot'], 63, '201k', { project: 'webshop' })],
  ['db-migration', 'blocked', L('opus', 2, 1, 'short', 'shirt', { glasses: true }),
    I('Migrate the customers table to the new schema', 'api · chore/customers-migration', ['Wrote the migration', 'Ran it on a local copy: ok', 'Stopped before running it on staging'], 22, '97k', {
      project: 'api',
      block: {
        reason: 'The migration drops the `legacy_id` column from 2 tables (1.2M rows). It cannot be undone without a backup, so I need your ok.',
        options: [
          { text: 'Run it on staging now', detail: 'Fastest; no way back if it goes wrong.' },
          { text: 'Back up the column, then run it', detail: 'Takes ~6 min longer; can be undone.', recommended: true },
          { text: 'Pause and write the rollback plan first', detail: 'Safest; delays delivery by ~30 min.' },
        ],
      },
    })],
  ['explore-bi', 'visitor', L('sonnet', 0, 2, 'bun', 'shirt'),
    I('Find out why the sales dashboard disagrees with the orders', 'webshop', ['Compared 3 months of totals', 'Found 2 hypotheses', 'Asking Fable for advice before choosing'], 38, '150k', { project: 'webshop' })],
  ['fable', 'boss', L('fable', 0, 3, 'short', 'jacket', { beard: true, accent: '#efe6d6', tie: '#7a1c16' }),
    I('Advisor: any room consults it before a big decision', 'all rooms', ['Answered 6 consultations today', 'Now with explore-bi'], 0, '—', { project: 'webshop' })],
  ['docs-site', 'dance', L('sonnet', 4, 4, 'long', 'dress'),
    I('New documentation site', 'docs · feat/site', ['PR merged 2 min ago', 'Leaving soon (nothing pending)'], 120, '330k', { project: 'docs' })],
];

export const BLOCKS = [
  {
    reason: 'The integration tests need the payment provider sandbox token, and it is not in `.env`.',
    options: [
      { text: 'Use the provider mock for now', detail: 'Moves on now; the real test comes later.', recommended: true },
      { text: 'I will give you the token', detail: 'You paste it into the local .env.' },
      { text: 'Skip these tests and mark them pending', detail: 'Ships without that coverage.' },
    ],
  },
  {
    reason: 'Two tests also fail on `dev`, before my change. I do not know whether to fix or ignore them.',
    options: [
      { text: 'Ignore them and open a separate issue', detail: 'Keeps the room in scope.', recommended: true },
      { text: 'Fix them in this PR too', detail: 'The PR gets bigger.' },
      { text: 'Ask Fable first', detail: 'One more opinion before deciding.' },
    ],
  },
  {
    reason: 'The change touches `3 modules` and outgrew the agreed size. Should I split it?',
    options: [
      { text: 'Split into 2 PRs', detail: 'Easier to review.', recommended: true },
      { text: 'Keep a single PR', detail: 'Ships in one go.' },
      { text: 'Stop and show me the plan', detail: 'You decide the cut.' },
    ],
  },
];

// New rooms and their projects, in the order the demo's "new room" sends them.
export const NEW_ROOMS = [['slow-search', 'webshop'], ['upload-bug', 'api'], ['dark-theme', 'mobile'], ['redis-cache', 'api'], ['welcome-email', 'scratch'], ['csv-export', 'docs']];
export const NEW_ROOM_INFO = project => I('New request that came in through reception', project, ['Just arrived'], 0, '0', { project });

export const STEPS = {
  blocked: 'Got blocked and took the lift down to ring the bell',
  merged: 'PR merged!',
  admitted: 'Doorman let it in: went up for coffee',
  answered: text => `You answered: ${text}`,
};

export const NPCS = [
  { ...FLOOR.npcs.maitre, kind: 'maitre', look: { tux: true, skin: 1, hair: 3, hs: 'short', outfit: 'jacket' } },
  { ...FLOOR.npcs.barman, kind: 'barman', look: { tux: true, skin: 2, hair: 0, hs: 'short', outfit: 'jacket', tie: '#d9a441' } },
  { ...FLOOR.npcs.dealer, kind: 'dealer', look: { tux: true, skin: 0, hair: 2, hs: 'bun', outfit: 'jacket' } },
  { ...FLOOR.npcs.sax, kind: 'sax', look: { tux: true, skin: 3, hair: 0, hs: 'hat', outfit: 'jacket' } },
  { ...FLOOR.npcs.waiter, kind: 'waiter', look: { tux: true, skin: 4, hair: 1, hs: 'short', outfit: 'jacket' } },
  { ...FLOOR.npcs.bouncer, kind: 'bouncer', look: { tux: true, skin: 3, hair: 0, hs: 'short', outfit: 'jacket', shades: true } },
];

export const createNpcs = () => NPCS.map(n => ({ ...n, look: { ...n.look } }));
