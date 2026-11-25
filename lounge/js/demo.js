// Demo data. Rooms, tasks and steps are agent-sourced text (rendered with textContent);
// inside block reasons, `backticks` mark the bold part.

const L = (model, skin, hair, hs, outfit, extra) => ({ model, skin, hair, hs, outfit, ...extra });
const I = (task, where, steps, minutes, tokens, extra) => ({ task, where, steps, minutes, tokens, ...extra });

export const DEMO_CAST = [
  ['deploy-app', 'queue', L('queued', 2, 0, 'short', 'shirt'),
    I('Ship version 2.3 of the orders app', 'orders-app', ['Arrived 3 min ago', 'Waiting for the doorman: 6 of 6 rooms active'], 3, '0')],
  ['docs-readme', 'queue', L('queued', 4, 2, 'bob', 'dress'),
    I('Rewrite the public API README', 'public-api', ['Arrived 1 min ago'], 1, '0')],
  ['lint-fix', 'queue', L('queued', 1, 3, 'hat', 'jacket', { tie: '#3a66b8' }),
    I('Fix the 48 lint warnings in the frontend', 'web-app', ['Just arrived'], 0, '0')],
  ['q3-report', 'sleep', L('sonnet', 0, 3, 'short', 'jacket', { beard: true }),
    I('Generate the third-quarter report', 'reports', ['Generated 4 of 5 charts', 'Stopped: local commits not pushed yet (2 commits)', 'Leaves on its own once the pending item is resolved'], 312, '96k')],
  ['nf-bug', 'work', L('opus', 0, 1, 'long', 'qipao'),
    I('Fix the rounding bug in invoice totals', 'backend · fix/invoice-rounding', ['Read InvoiceTotals.java and Rounding.java', 'Reproduced the bug in a test (expected failure)', 'Editing the rounding rule', 'Running the invoice module suite'], 34, '182k')],
  ['api-pix', 'work', L('opus', 2, 0, 'spiky', 'jacket'),
    I('Instant-payment charge endpoint', 'backend · feat/pix-charge', ['Designed the endpoint contract', 'Built the payment provider client with retry', 'Writing integration tests'], 51, '240k')],
  ['refactor-auth', 'work', L('sonnet', 4, 4, 'bun', 'shirt', { glasses: true }),
    I('Split social login from password login', 'backend · refactor/auth', ['Mapped 14 uses of AuthService', 'Extracted SocialLoginService', 'Fixing the broken tests (3 of 9)'], 27, '120k')],
  ['e2e-tests', 'work', L('sonnet', 3, 0, 'short', 'shirt', { accent: '#f0c050' }),
    I('Cover the checkout flow with an end-to-end test', 'web-app · test/checkout-e2e', ['Started the local environment', 'Recorded the happy path', 'Writing the declined-card case'], 19, '64k')],
  ['nf-bug-haiku', 'slot', L('haiku', 1, 2, 'short', 'shirt'),
    I('Subagent of room nf-bug: read and summarize files', 'backend', ['Reading 12 files from the invoice module', 'Summary goes to room nf-bug'], 2, '18k'), 'haiku'],
  ['api-pix-haiku', 'slot', L('haiku', 4, 5, 'bob', 'dress'),
    I('Subagent of room api-pix: read the payment provider docs', 'provider docs', ['Reading 3 pages of documentation', 'Summary goes to room api-pix'], 1, '9k'), 'haiku'],
  ['new-room', 'coffee', L('sonnet', 1, 1, 'short', 'jacket', { tie: '#1f6b45' }),
    I('Find out why the sales report is slow', 'reports', ['Got the request from reception', 'Drafting the plan: measure before changing anything'], 2, '11k')],
  ['pr-checkout', 'whisky', L('opus', 0, 6, 'long', 'dress'),
    I('New one-page checkout', 'web-app · feat/checkout-1p', ['Opened the PR', 'CI green, 2 approvals', 'Waiting for merge'], 96, '410k')],
  ['weekly-digest', 'ready', L('sonnet', 3, 6, 'bob', 'dress'),
    I('Summarize the week of merged changes', 'docs · chore/weekly-digest', ['Collected 23 merged changes', 'Wrote the digest draft', 'Last message: "The draft is in docs/digest.md. Want me to open a PR?"'], 14, '42k')],
  ['ci-pipeline', 'smoke', L('sonnet', 1, 0, 'short', 'jacket'),
    I('Speed up the CI pipeline', 'infra · ci/gradle-cache', ['Turned on the Gradle cache', 'Triggered CI to measure', 'Waiting for CI to finish (~8 min)'], 41, '88k')],
  ['pr-login', 'smoke', L('opus', 3, 5, 'bob', 'qipao'),
    I('New login screen', 'web-app · feat/login', ['Opened the PR', 'Waiting for the review bot'], 63, '201k')],
  ['db-migration', 'blocked', L('opus', 2, 1, 'short', 'shirt', { glasses: true }),
    I('Migrate the customers table to the new schema', 'backend · chore/customers-migration', ['Wrote the migration', 'Ran it on a local copy: ok', 'Stopped before running it on staging'], 22, '97k', {
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
    I('Find out why the sales dashboard disagrees with the ERP', 'data', ['Compared 3 months of totals', 'Found 2 hypotheses', 'Asking Fable for advice before choosing'], 38, '150k')],
  ['fable', 'boss', L('fable', 0, 3, 'short', 'jacket', { beard: true, accent: '#efe6d6', tie: '#7a1c16' }),
    I('Advisor: any room consults it before a big decision', 'all rooms', ['Answered 6 consultations today', 'Now with explore-bi'], 0, '—')],
  ['docs-site', 'dance', L('sonnet', 4, 4, 'long', 'dress'),
    I('New documentation site', 'docs · feat/site', ['PR merged 2 min ago', 'Leaving soon (nothing pending)'], 120, '330k')],
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

export const NEW_ROOM_NAMES = ['slow-search', 'upload-bug', 'dark-theme', 'redis-cache', 'welcome-email', 'csv-export'];
export const NEW_ROOM_INFO = () => I('New request that came in through reception', 'to be decided', ['Just arrived'], 0, '0');

export const STEPS = {
  blocked: 'Got blocked and went to call you',
  merged: 'PR merged!',
  admitted: 'Doorman let it in: went for coffee',
  answered: text => `You answered: ${text}`,
};

export const NPCS = [
  { kind: 'maitre', look: { tux: true, skin: 1, hair: 3, hs: 'short', outfit: 'jacket' }, x: 246, y: 284 },
  { kind: 'barman', look: { tux: true, skin: 2, hair: 0, hs: 'short', outfit: 'jacket', tie: '#d9a441' }, x: 416, y: 198 },
  { kind: 'dealer', look: { tux: true, skin: 0, hair: 2, hs: 'bun', outfit: 'jacket' }, x: 235, y: 236 },
  { kind: 'sax', look: { tux: true, skin: 3, hair: 0, hs: 'hat', outfit: 'jacket' }, x: 146, y: 286 },
  { kind: 'waiter', look: { tux: true, skin: 4, hair: 1, hs: 'short', outfit: 'jacket' }, x: 130, y: 266, dir: 1 },
  { kind: 'bouncer', look: { tux: true, skin: 3, hair: 0, hs: 'short', outfit: 'jacket', shades: true }, x: 76, y: 304 },
];

export const createNpcs = () => NPCS.map(n => ({ ...n, look: { ...n.look } }));
