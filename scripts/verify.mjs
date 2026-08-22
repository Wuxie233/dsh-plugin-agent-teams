#!/usr/bin/env node
/**
 * Offline smoke verification for dsh-agent-teams.
 *
 * Runs the pure team-logic rules, the on-disk persistence flow, and the
 * browser workbench fold (events -> workbench projection) against throwaway
 * temp state. Requires a prior `pnpm build` (lib/ present). Does not touch
 * any running DSH instance or profile.
 *
 * Usage: node scripts/verify.mjs
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CAPTAIN_KEY,
  appendMailbox,
  createMessage,
  createTeamDir,
  findTeamByCaptain,
  findTeamByParticipant,
  readMailbox,
  readTeam,
  removeTeamDir,
  sanitizeKey,
  transitionError,
  unsatisfiedDependencies,
  withTeamLock,
} from '../lib/state.js'
import { activityPanelExpandedForSession, relatedTaskIds, taskStages } from '../lib/client/activity-model.js'
import {
  agentTeamsCardDefinition,
  parseAgentTeamsCreateArgs,
} from '../lib/client/agent-teams-card-definition.js'
import { parseAgentTeamsToolMeta } from '../lib/card-meta.js'
import { ACTIVITY_LIST_TIMEOUT_MS, withTimeout } from '../lib/timeout.js'
import { bargeCaptainReport, deliverCaptainReport, parseDeliveryMode, resolveMemberSpawnBrief } from '../lib/tools.js'
import {
  assignedWorkBlock,
  deliverToMember,
  installMemberSelectionRuntime,
  MEMBER_DENIED_TOOLS,
  resolveMemberLlmSelection,
  memberActivity,
  memberDispatchPrompt,
  memberPersona,
  retireMember,
  spawnMember,
} from '../lib/members.js'
import { lastMatchingStallNotice, lastTurnEndKind, shouldNotifyMemberStall, stallCaptainMessage } from '../lib/stall.js'
import { assembleTeamSnapshot } from '../lib/snapshot.js'
import {
  FEEDBACK_LABEL,
  FEEDBACK_REPO,
  buildIssueBody,
  executeTeamReportIssue,
  reportIssueReporter,
} from '../lib/report-issue.js'

let failures = 0
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`)
  } else {
    failures += 1
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('dsh-agent-teams offline verification')

// The bundle patch's `name` is the specifier Node resolves when a profile
// loads this plugin, so it must equal the published package name. A mismatch
// only surfaces after someone installs the package (the row fails to load),
// never in local link-installed development — hence this pre-publish gate.
console.log('1/8 packaging contract')
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const patchText = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const patchName = patchText
  .split('\n')
  .filter(line => !/^\s*#/.test(line))
  .find(line => /^\s*name:\s*\S/.test(line))
  ?.match(/^\s*name:\s*(.+?)\s*$/)?.[1]
  ?.replace(/^(['"])(.*)\1$/, '$2')
check(
  'cordis.patch.yml name matches the published package name',
  patchName === pkg.name,
  `patch has ${JSON.stringify(patchName)}, package.json has ${JSON.stringify(pkg.name)}`,
)
check(
  'files[] ships the bundle patch and lib',
  ['lib', 'cordis.patch.yml'].every(entry => pkg.files?.includes(entry)),
  `files = ${JSON.stringify(pkg.files)}`,
)
check(
  'scoped package publishes publicly',
  !pkg.name.startsWith('@') || pkg.publishConfig?.access === 'public',
  'scoped packages default to restricted without publishConfig.access = "public"',
)
// The browser half registers itself with __ModuleLoader__ under an id the host
// resolves by package name. A stale id here fails only in the browser — the
// host half loads fine, so every server-side check still passes.
const clientBundle = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const registeredId = clientBundle.match(/__ModuleLoader__\.load\(\{\s*id:\s*"([^"]*)"/)?.[1]
check(
  'client bundle registers under the package name',
  registeredId === pkg.name,
  `bundle registers ${JSON.stringify(registeredId)}, package.json has ${JSON.stringify(pkg.name)}`,
)

console.log('2/8 pure rules')
check("sanitizeKey('My Team!') -> 'my-team'", sanitizeKey('My Team!') === 'my-team')
// #15: an ASCII-only whitelist folded every non-Latin name onto one constant,
// so distinct members shared a mailbox file and the second one was rejected as
// a duplicate. Keys must stay distinct for distinct names, in any script.
check("CJK names survive folding", sanitizeKey('研究员') === '研究员')
check(
  'distinct non-Latin names stay distinct',
  sanitizeKey('研究员') !== sanitizeKey('工程师')
    && sanitizeKey('データ分析') !== sanitizeKey('Данные'),
)
check(
  'names with no letters or digits get distinct keys, not a shared constant',
  sanitizeKey('!!!') !== sanitizeKey('🐳') && sanitizeKey('🐳') !== '',
)
check('folding is deterministic', sanitizeKey('🐳') === sanitizeKey('🐳'))
check(
  'long names stay inside the filesystem name limit',
  Buffer.byteLength(`${sanitizeKey('研'.repeat(300))}.jsonl`) < 255,
)
check(
  'long names sharing a prefix stay distinct',
  sanitizeKey(`${'研'.repeat(60)}a`) !== sanitizeKey(`${'研'.repeat(60)}b`),
)
check(
  'keys stay a single safe path segment',
  !/[\\/:*?"<>|]/.test(sanitizeKey('a/b\\c:d*e?f"g<h>i|j')) && !sanitizeKey('../../etc').includes('.'),
)
check('pending -> claimed allowed', transitionError('pending', 'claimed') === undefined)
check('pending -> in_progress denied', transitionError('pending', 'in_progress') !== undefined)
check('claimed -> completed allowed', transitionError('claimed', 'completed') === undefined)
check('in_progress -> completed allowed', transitionError('in_progress', 'completed') === undefined)
check('completed -> in_progress denied', transitionError('completed', 'in_progress') !== undefined)
check('same status is a no-op', transitionError('failed', 'failed') === undefined)

console.log('3/8 dependency gating')
const tasks = [
  { id: 't1', status: 'completed' },
  { id: 't2', status: 'pending' },
  { id: 't3', status: 'failed' },
]
check('all-done deps satisfied', unsatisfiedDependencies(tasks, ['t1']).length === 0)
check('pending dep blocks', unsatisfiedDependencies(tasks, ['t2']).length === 1)
check('failed dep blocks too', unsatisfiedDependencies(tasks, ['t3']).length === 1)

console.log('4/8 on-disk team flow (temp dir)')
const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-agent-teams-verify-'))
try {
  const team = {
    name: 'Verify Team',
    id: sanitizeKey('Verify Team'),
    description: 'smoke',
    captainSessionId: 'sess-captain',
    createdAt: Date.now(),
    members: [
      { id: 'sess-member', name: 'alice', joinedAt: Date.now(), status: 'idle' },
      { id: 'sess-removed', name: 'former', joinedAt: Date.now(), status: 'removed' },
    ],
    tasks: [],
    taskSeq: 0,
  }
  await createTeamDir(stateRoot, team)

  const reread = await readTeam(stateRoot, team.id)
  check('team.json round-trips', reread?.id === team.id && reread.captainSessionId === 'sess-captain')

  await writeFile(join(stateRoot, team.id, 'team.json'), `\uFEFF${JSON.stringify(team, null, 2)}`, 'utf8')
  check('team.json accepts a UTF-8 BOM', (await readTeam(stateRoot, team.id))?.id === team.id)

  const found = await findTeamByCaptain(stateRoot, 'sess-captain')
  check('findTeamByCaptain finds the team', found?.id === team.id)
  check('findTeamByCaptain ignores other captains', await findTeamByCaptain(stateRoot, 'sess-other') === undefined)
  check('findTeamByParticipant finds the captain', (await findTeamByParticipant(stateRoot, 'sess-captain'))?.id === team.id)
  check('findTeamByParticipant finds an active member', (await findTeamByParticipant(stateRoot, 'sess-member'))?.id === team.id)
  check('findTeamByParticipant rejects a removed member', await findTeamByParticipant(stateRoot, 'sess-removed') === undefined)

  const escapedContent = String.raw`save to notes\foo.md`
  const message = createMessage('alice', CAPTAIN_KEY, escapedContent)
  await withTeamLock(team.id, async () => {
    await appendMailbox(stateRoot, team.id, CAPTAIN_KEY, message)
  })
  const second = createMessage('bob', CAPTAIN_KEY, 'valid after BOM')
  const mailboxFile = join(stateRoot, team.id, 'inbox', `${CAPTAIN_KEY}.jsonl`)
  await writeFile(
    mailboxFile,
    `\uFEFF${JSON.stringify(second)}\n${String.raw`{"broken":"notes\q.md"}`}\n{}\n`,
    { encoding: 'utf8', flag: 'a' },
  )
  const malformedLines = []
  const inbox = await readMailbox(
    stateRoot,
    team.id,
    CAPTAIN_KEY,
    (lineNumber) => malformedLines.push(lineNumber),
  )
  check('mailbox append/read preserves backslashes', inbox[0]?.content === escapedContent)
  check('mailbox accepts BOM-prefixed JSONL records', inbox[1]?.content === second.content)
  check('mailbox skips malformed JSON and malformed shapes', inbox.length === 2 && malformedLines.join(',') === '3,4')
  check('missing mailbox reads empty', (await readMailbox(stateRoot, team.id, 'nobody')).length === 0)

  const duplicateCaptain = { ...team, id: 'duplicate-captain', members: [] }
  await createTeamDir(stateRoot, duplicateCaptain)
  let duplicateCaptainRejected = false
  try {
    await findTeamByCaptain(stateRoot, 'sess-captain')
  } catch {
    duplicateCaptainRejected = true
  }
  check('multiple teams for one captain fail as ambiguous', duplicateCaptainRejected)
  await removeTeamDir(stateRoot, duplicateCaptain.id)

  const duplicateMember = { ...team, id: 'duplicate-member', captainSessionId: 'sess-other-captain' }
  await createTeamDir(stateRoot, duplicateMember)
  let duplicateMemberRejected = false
  try {
    await findTeamByParticipant(stateRoot, 'sess-member')
  } catch {
    duplicateMemberRejected = true
  }
  check('multiple teams for one member fail as ambiguous', duplicateMemberRejected)
  await removeTeamDir(stateRoot, duplicateMember.id)

  const invalidId = 'invalid-shape'
  await mkdir(join(stateRoot, invalidId), { recursive: true })
  await writeFile(join(stateRoot, invalidId, 'team.json'), '{}', 'utf8')
  let invalidShapeRejected = false
  try {
    await readTeam(stateRoot, invalidId)
  } catch {
    invalidShapeRejected = true
  }
  check('invalid team.json shape is rejected at the durable boundary', invalidShapeRejected)
  await removeTeamDir(stateRoot, invalidId)

  await removeTeamDir(stateRoot, team.id)
  check('removeTeamDir removes the team', await readTeam(stateRoot, team.id) === undefined)

  // Archive keeps the team data for post-delete review.
  const archiveTeam = { ...team, id: sanitizeKey('Archive Team') }
  await createTeamDir(stateRoot, archiveTeam)
  const { archiveTeamDir, readArchivedTeam, listArchivedTeamIds } = await import('../lib/state.js')
  await archiveTeamDir(stateRoot, archiveTeam.id)
  check('archive moves the team out of live scan', await readTeam(stateRoot, archiveTeam.id) === undefined)
  check('archive keeps team.json readable', (await readArchivedTeam(stateRoot, archiveTeam.id))?.id === archiveTeam.id)
  check('archive lists the team id', (await listArchivedTeamIds(stateRoot)).includes(archiveTeam.id))
  check('archive dir skips live readTeam', await readTeam(stateRoot, 'archive') === undefined)
} finally {
  await rm(stateRoot, { recursive: true, force: true })
}

console.log('5/8 host visual-state functions (activity panel)')
const { taskVisualState, taskDepthsById } = await import('../lib/state.js')
const vtasks = [
  { id: 't1', subject: 'a', status: 'completed', assignee: 'alice', dependencies: [], createdAt: 0, updatedAt: 0 },
  { id: 't2', subject: 'b', status: 'pending', assignee: 'bob', dependencies: ['t1'], createdAt: 0, updatedAt: 0 },
  { id: 't3', subject: 'c', status: 'in_progress', assignee: 'bob', dependencies: ['t2'], createdAt: 0, updatedAt: 0 },
  { id: 't4', subject: 'd', status: 'pending', assignee: 'alice', dependencies: ['t9'], createdAt: 0, updatedAt: 0 },
]
check('completed -> completed visual state', taskVisualState('completed', [], vtasks) === 'completed')
check('in_progress -> running visual state', taskVisualState('in_progress', [], vtasks) === 'running')
check('pending with completed dep -> open', taskVisualState('pending', ['t1'], vtasks) === 'open')
check('pending with open dep -> blocked', taskVisualState('pending', ['t2'], vtasks) === 'blocked')
check('missing dependency is ignored (not blocked)', taskVisualState('pending', ['t9'], vtasks) === 'open')
const depths = taskDepthsById(vtasks)
check('t1 depth 0', depths.get('t1') === 0)
check('t2 depth 1 (longest path)', depths.get('t2') === 1)
check('t3 depth 2', depths.get('t3') === 2)
check('missing dep contributes no depth', depths.get('t4') === 0)

const activityRoot = await mkdtemp(join(tmpdir(), 'dsh-agent-teams-activity-'))
try {
  const activityTeam = {
    name: 'Activity Team',
    id: sanitizeKey('Activity Team'),
    captainSessionId: 'sess-captain',
    createdAt: 0,
    members: [
      { id: 'sess-backend', name: 'backend', role: 'backend', joinedAt: 0, status: 'idle' },
      { id: 'sess-frontend', name: 'frontend', role: 'frontend', joinedAt: 0, status: 'idle' },
      { id: '', name: 'unspawned', role: 'qa', joinedAt: 0, status: 'idle' },
    ],
    tasks: [
      { id: 't1', subject: 'done', status: 'completed', assignee: 'backend', dependencies: [], createdAt: 0, updatedAt: 0 },
      { id: 't2', subject: 'done', status: 'completed', assignee: 'frontend', dependencies: [], createdAt: 0, updatedAt: 0 },
    ],
    taskSeq: 2,
  }
  await createTeamDir(activityRoot, activityTeam)
  const stoppedConversationCtx = {
    agents: {
      get: (id) => {
        if (id === 'sess-backend') return { status: 'idle' }
        if (id === 'sess-frontend') return { status: 'idle' }
        return undefined
      },
    },
    subagents: {
      listChildren: async () => [
        { kind: 'child', id: 'sess-backend', activity: 'running' },
        { kind: 'child', id: 'sess-frontend', activity: 'running' },
      ],
    },
    logger: { warn: () => {} },
  }
  const stoppedLive = await memberActivity(stoppedConversationCtx, 'sess-captain')
  check(
    'loaded-but-stopped member is inactive, not store-running',
    stoppedLive.get('sess-backend') === 'inactive' && stoppedLive.get('sess-frontend') === 'inactive',
    `got backend=${stoppedLive.get('sess-backend')} frontend=${stoppedLive.get('sess-frontend')}`,
  )
  const stoppedSnapshot = await assembleTeamSnapshot(
    stoppedConversationCtx,
    activityRoot,
    'workspace',
    activityTeam,
  )
  check(
    'panel does not mark a stopped conversation as working',
    stoppedSnapshot.members.every((member) => member.name === 'unspawned' || member.activity !== 'working')
      && stoppedSnapshot.members.find((member) => member.name === 'backend')?.activity === 'idle',
    JSON.stringify(stoppedSnapshot.members.map((member) => `${member.name}:${member.activity}`)),
  )

  const mixedCtx = {
    agents: {
      get: (id) => {
        if (id === 'sess-backend') return { status: 'running' }
        if (id === 'sess-frontend') return { status: 'idle' }
        return undefined
      },
    },
    subagents: {
      listChildren: async () => [
        { kind: 'child', id: 'sess-backend', activity: 'running' },
        { kind: 'child', id: 'sess-frontend', activity: 'running' },
        { kind: 'child', id: 'sess-cold', activity: 'inactive' },
      ],
    },
    logger: { warn: () => {} },
  }
  const mixedLive = await memberActivity(mixedCtx, 'sess-captain')
  check(
    'only an agent with an active driver reports running',
    mixedLive.get('sess-backend') === 'running'
      && mixedLive.get('sess-frontend') === 'inactive'
      && mixedLive.get('sess-cold') === 'inactive',
    `got backend=${mixedLive.get('sess-backend')} frontend=${mixedLive.get('sess-frontend')} cold=${mixedLive.get('sess-cold')}`,
  )

  const missingAgentCtx = {
    agents: { get: () => undefined },
    logger: { warn: () => {} },
  }
  const claimedTeam = {
    ...activityTeam,
    tasks: [
      { id: 't1', subject: 'claimed work', status: 'claimed', assignee: 'backend', dependencies: [], createdAt: 0, updatedAt: 0 },
    ],
    taskSeq: 1,
  }
  const claimedSnapshot = await assembleTeamSnapshot(stoppedConversationCtx, activityRoot, 'workspace', claimedTeam)
  check(
    'claimed tasks count as current work in the activity snapshot',
    claimedSnapshot.members.find((member) => member.name === 'backend')?.currentTask === 't1',
    JSON.stringify(claimedSnapshot.members.find((member) => member.name === 'backend')),
  )

  const missingSnapshot = await assembleTeamSnapshot(missingAgentCtx, activityRoot, 'workspace', activityTeam)
  check(
    'snapshot roster comes from disk even when no live agent is loaded',
    missingSnapshot.members.length === 3
      && missingSnapshot.members.every((member) => member.activity !== 'working'),
    JSON.stringify(missingSnapshot.members.map((member) => `${member.name}:${member.activity}`)),
  )
} finally {
  await rm(activityRoot, { recursive: true, force: true })
}

console.log('6/8 client relationship projections')
const projectionTasks = [
  { id: 't4', dependencies: ['t2'], depth: 2 },
  { id: 't1', dependencies: [], depth: 0 },
  { id: 't3', dependencies: ['t1'], depth: 1 },
  { id: 't2', dependencies: ['t1'], depth: 1 },
  { id: 't5', dependencies: [], depth: Number.NaN },
]
const stages = taskStages(projectionTasks)
check('task stages sort by depth', stages.map(stage => stage.depth).join(',') === '0,1,2')
check('task stages sort ids naturally', stages[1]?.tasks.map(task => task.id).join(',') === 't2,t3')
check('non-finite depth falls back to stage 0', stages[0]?.tasks.some(task => task.id === 't5') === true)
const chain = relatedTaskIds('t2', projectionTasks)
check('relationship chain includes upstream dependency', chain.has('t1'))
check('relationship chain includes focused task', chain.has('t2'))
check('relationship chain includes downstream dependent', chain.has('t4'))
check('relationship chain excludes sibling branch', !chain.has('t3'))
const cyclic = [
  { id: 'a', dependencies: ['b'], depth: 0 },
  { id: 'b', dependencies: ['a'], depth: 1 },
]
check('relationship traversal is cycle-safe', relatedTaskIds('a', cyclic).size === 2)
check(
  'expanded activity panel belongs only to its current session',
  activityPanelExpandedForSession(true, 'session-a', 'session-a')
    && !activityPanelExpandedForSession(true, 'session-a', 'session-b')
    && !activityPanelExpandedForSession(true, 'session-a', undefined),
)
check(
  'agent team cards derive a stable id from the standard create tool call',
  JSON.stringify(parseAgentTeamsCreateArgs('{"name":" Repo Review 2W! "}'))
    === JSON.stringify({ teamId: 'repo-review-2w', name: 'Repo Review 2W!' }),
)
check('malformed create tool arguments do not create a card', parseAgentTeamsCreateArgs('{bad') === undefined)
check(
  'create meta round-trips for the card fold',
  parseAgentTeamsToolMeta({
    kind: 'create',
    teamId: 'session-rehome',
    teamName: 'session-rehome',
    captainSessionId: 'sess-captain',
    members: [],
  })?.kind === 'create',
)

{
  const callId = 'call-create'
  const startEvent = {
    type: 'tool/call',
    seq: 1,
    data: { callId, name: 'agent_teams_create', arguments: '{"name":"session-rehome"}' },
  }
  const createResult = {
    type: 'tool/result',
    seq: 2,
    data: {
      meta: {
        kind: 'create',
        teamId: 'session-rehome',
        teamName: 'session-rehome',
        captainSessionId: 'sess-captain',
        members: [],
      },
      message: {
        source: { kind: 'tool', callId },
        content: [{ type: 'text', text: 'Team "session-rehome" created (id session-rehome) under /tmp. You are the captain.' }],
      },
    },
  }
  const addResult = {
    type: 'tool/result',
    seq: 3,
    data: {
      meta: {
        kind: 'add-member',
        teamId: 'session-rehome',
        member: { id: 'sess-core', name: 'core-engineer', role: 'engineer' },
      },
      message: { source: { kind: 'tool', callId: 'call-add' }, content: [{ type: 'text', text: 'added' }] },
    },
  }
  const startMatch = agentTeamsCardDefinition.match(startEvent)
  const addMatch = agentTeamsCardDefinition.match(addResult)
  check('card start id is the team id, not the create call id', startMatch?.id === 'session-rehome' && startMatch.role === 'start')
  check('add_member result joins the same team context', addMatch?.id === 'session-rehome' && addMatch.role === 'update')
  let state = agentTeamsCardDefinition.start({}, { event: startEvent })
  state = agentTeamsCardDefinition.update({ state }, { event: createResult })
  state = agentTeamsCardDefinition.update({ state }, { event: addResult })
  const node = agentTeamsCardDefinition.buildViewNode({
    start: { event: startEvent, location: { kind: 'session' } },
    state,
    key: 'k',
    id: 'session-rehome',
  })
  check(
    'folded card shows the added member without a state-route poll',
    node?.data?.members?.length === 1
      && node.data.members[0]?.name === 'core-engineer'
      && node.data.captainSessionId === 'sess-captain',
    JSON.stringify(node?.data),
  )
  const historicCreate = {
    type: 'tool/result',
    seq: 2,
    data: {
      message: {
        source: { kind: 'tool', callId },
        content: [{ type: 'text', text: 'Team "session-rehome" created (id session-rehome) under /tmp. You are the captain.' }],
      },
    },
  }
  check(
    'historic create results still pair by rendered team id',
    agentTeamsCardDefinition.match(historicCreate)?.id === 'session-rehome',
  )
}

{
  const started = Date.now()
  let timedOut = false
  try {
    await withTimeout(new Promise(() => {}), 20, 'timed out')
  } catch (error) {
    timedOut = error instanceof Error && error.message === 'timed out'
  }
  check('withTimeout rejects a hung wait', timedOut && Date.now() - started < 500)
  check('activity listing timeout is bounded', ACTIVITY_LIST_TIMEOUT_MS === 1500)
}

const captainDeliveries = []
const captainCancels = []
const captainBarged = bargeCaptainReport(
  {
    cancel: (cause, options) => captainCancels.push({ cause, options }),
    followup: message => captainDeliveries.push(message),
  },
  'alice',
  'finished t1',
)
check(
  'explicit barge still interrupts the live captain',
  captainBarged
    && captainCancels.length === 1
    && captainCancels[0]?.cause?.kind === 'parent'
    && captainCancels[0]?.options?.keepInbox === true
    && captainDeliveries.length === 1
    && captainDeliveries[0]?.content[0]?.type === 'text'
    && captainDeliveries[0]?.content[0]?.text === 'AgentTeams message from member alice:\n\nfinished t1',
)
const queuedCaptainCancels = []
const queuedCaptainDeliveries = []
const captainQueued = deliverCaptainReport(
  {
    cancel: (cause, options) => queuedCaptainCancels.push({ cause, options }),
    followup: message => queuedCaptainDeliveries.push(message),
  },
  'alice',
  'finished t1',
  'queue',
)
const defaultCaptainCancels = []
const defaultCaptainDeliveries = []
const captainDefault = deliverCaptainReport(
  {
    cancel: (cause, options) => defaultCaptainCancels.push({ cause, options }),
    followup: message => defaultCaptainDeliveries.push(message),
  },
  'alice',
  'finished t1',
)
check(
  'default captain delivery barges into the live captain',
  captainDefault && defaultCaptainCancels.length === 1 && defaultCaptainDeliveries.length === 1,
)
check(
  'explicit queue captain delivery does not cancel the current turn',
  captainQueued && queuedCaptainCancels.length === 0 && queuedCaptainDeliveries.length === 1,
)
check(
  'failed live captain delivery falls back to the durable mailbox',
  bargeCaptainReport({
    cancel: () => {},
    followup: () => { throw new Error('offline') },
  }, 'alice', 'finished t1') === false,
)
check('parseDeliveryMode defaults to barge', parseDeliveryMode(undefined) === 'barge' && parseDeliveryMode('barge') === 'barge')
check('parseDeliveryMode accepts queue', parseDeliveryMode('queue') === 'queue')
let badMode = false
try { parseDeliveryMode('steer') } catch (error) { badMode = String(error).includes('queue') }
check('parseDeliveryMode rejects unknown modes', badMode)

const memberFollowups = []
const memberInterrupts = []
const memberAccepted = await deliverToMember(
  {
    subagents: {
      interrupt: (id, authority) => memberInterrupts.push({ id, authority }),
      followup: async (_captain, id, content) => {
        memberFollowups.push({ id, content })
        return 'msg-1'
      },
    },
    logger: { warn: () => {} },
  },
  { id: 'captain' },
  'sess-backend',
  'continue t2',
  new AbortController().signal,
)
check(
  'default member delivery interrupts the current turn before followup',
  memberAccepted
    && memberInterrupts.length === 1
    && memberInterrupts[0]?.id === 'sess-backend'
    && memberFollowups.length === 1
    && memberFollowups[0]?.id === 'sess-backend',
)
const queuedFollowups = []
const queuedInterrupts = []
const queuedAccepted = await deliverToMember(
  {
    subagents: {
      interrupt: (id, authority) => queuedInterrupts.push({ id, authority }),
      followup: async (_captain, id, content) => {
        queuedFollowups.push({ id, content })
        return 'msg-q'
      },
    },
    logger: { warn: () => {} },
  },
  { id: 'captain' },
  'sess-backend',
  'continue t2 later',
  new AbortController().signal,
  'queue',
)
check(
  'explicit queue member delivery does not interrupt',
  queuedAccepted
    && queuedInterrupts.length === 0
    && queuedFollowups.length === 1
    && queuedFollowups[0]?.id === 'sess-backend',
)
const bargedFollowups = []
const bargedInterrupts = []
const bargedAccepted = await deliverToMember(
  {
    subagents: {
      interrupt: (id, authority) => bargedInterrupts.push({ id, authority }),
      followup: async (_captain, id, content) => {
        bargedFollowups.push({ id, content })
        return 'msg-2'
      },
    },
    logger: { warn: () => {} },
  },
  { id: 'captain' },
  'sess-backend',
  'stop and do t2',
  new AbortController().signal,
  'barge',
)
check(
  'barge member delivery interrupts the current turn before followup',
  bargedAccepted
    && bargedInterrupts.length === 1
    && bargedInterrupts[0]?.id === 'sess-backend'
    && bargedFollowups.length === 1
    && bargedFollowups[0]?.id === 'sess-backend',
)
check(
  'spawn brief falls back when prompt is missing',
  resolveMemberSpawnBrief({ task_subject: 'Build identity', task_description: 'Write the identity module.' }) === 'Write the identity module.'
    && resolveMemberSpawnBrief({ prompt: 'Do t1 now', task_subject: 'Build identity' }) === 'Do t1 now',
)
let emptyBriefRejected = false
try { resolveMemberSpawnBrief({ task_subject: '   ' }) } catch (error) { emptyBriefRejected = String(error).includes('spawn brief') }
check('empty spawn brief is rejected', emptyBriefRejected)

const firstTask = {
  id: 't1',
  subject: 'Build identity',
  description: 'Write the identity module.',
  status: 'claimed',
  assignee: 'identity-builder',
  dependencies: [],
  createdAt: 0,
  updatedAt: 0,
}
const dispatch = memberDispatchPrompt(
  { name: 'firefox-majors', id: 'firefox-majors', captainSessionId: 'sess-captain', createdAt: 0, members: [], tasks: [firstTask], taskSeq: 1 },
  firstTask,
  'Implement t1 now. Do not check in ready.',
)
check(
  'spawn prompt is the first claimed task, not a greeting',
  dispatch.includes('task t1: Build identity')
    && dispatch.includes('Implement t1 now')
    && dispatch.includes('Do not send a ready check-in')
    && dispatch.includes('Your assigned work (claimed or in_progress)')
    && dispatch.includes('t1 [claimed] Build identity')
    && !dispatch.includes('Wait for the captain'),
  dispatch,
)
const persona = memberPersona(
  { name: 'shelf', id: 'shelf', captainSessionId: 'c', createdAt: 0, members: [], tasks: [], taskSeq: 0 },
  { id: 'sess-catalog', name: 'catalog-engineer', role: 'engineer', joinedAt: 0, status: 'idle' },
  '.agent-teams',
)
check(
  'member persona treats the first user message as the first task',
  persona.includes('first user message is already the first assigned task')
    && persona.includes('complete a claimed task directly')
    && persona.includes('Never say you are waiting for assignment'),
)
const pinnedPersona = memberPersona(
  { name: 'shelf', id: 'shelf', captainSessionId: 'c', createdAt: 0, members: [], tasks: [], taskSeq: 0 },
  { id: 'sess-catalog', name: 'catalog-engineer', role: 'engineer', joinedAt: 0, status: 'idle' },
  '.agent-teams',
  [],
  '/tmp/example-project',
)
check(
  'persona names the workspace root and forbids sibling search',
  pinnedPersona.includes('Workspace root: /tmp/example-project')
    && pinnedPersona.includes('Do not search, read, or write sibling repositories'),
)
check(
  'assignedWorkBlock lists claimed tasks',
  assignedWorkBlock(
    { name: 't', id: 't', captainSessionId: 'c', createdAt: 0, members: [], tasks: [firstTask], taskSeq: 1 },
    'identity-builder',
  ).includes('t1 [claimed] Build identity'),
)
check(
  'lastTurnEndKind reads newest turn/end',
  lastTurnEndKind([
    { type: 'turn/start' },
    { type: 'turn/end', data: { reason: { kind: 'completed' } } },
    { type: 'turn/end', data: { reason: { kind: 'interrupted' } } },
  ]) === 'interrupted',
)
check(
  'interrupted idle member with open work notifies the captain',
  shouldNotifyMemberStall({
    memberStatus: 'idle',
    activity: 'idle',
    lastTurnEndKind: 'interrupted',
    openTaskIds: ['t1'],
    pendingInbox: false,
  }).notify === true
    && stallCaptainMessage('backend', ['t1']).includes('Plugin stall notice')
    && stallCaptainMessage('backend', ['t1']).includes('still owns t1'),
)
check(
  'pending inbox or completed turn does not notify',
  shouldNotifyMemberStall({
    memberStatus: 'idle',
    activity: 'idle',
    lastTurnEndKind: 'interrupted',
    openTaskIds: ['t1'],
    pendingInbox: true,
  }).notify === false
    && shouldNotifyMemberStall({
      memberStatus: 'idle',
      activity: 'idle',
      lastTurnEndKind: 'completed',
      openTaskIds: ['t1'],
      pendingInbox: false,
    }).notify === false,
)
const stallText = stallCaptainMessage('backend', ['t1'])
check(
  'duplicate stall for the same open tasks is suppressed',
  shouldNotifyMemberStall({
    memberStatus: 'idle',
    activity: 'idle',
    lastTurnEndKind: 'interrupted',
    openTaskIds: ['t1'],
    pendingInbox: false,
    lastStallNotice: stallText,
  }).notify === false
    && lastMatchingStallNotice([{ from: 'backend', content: stallText }], 'backend', ['t1']) === stallText,
)

const retired = []
retireMember(
  {
    agents: {
      get: (id) => id === 'sess-backend'
        ? { cancel: (cause, options) => retired.push({ cause, options }) }
        : undefined,
    },
    logger: { warn: () => {} },
  },
  'sess-backend',
)
check(
  'retiring a deleted-team member cancels the turn and drops the queued inbox',
  retired.length === 1 && retired[0]?.cause?.kind === 'parent' && retired[0]?.options === undefined,
)

console.log('7/8 member model selection and continuation restore')
const captain = {
  id: 'captain-session',
  options: { provider: 'birth-provider', model: 'birth-model' },
  session: {
    requestHeader: () => ({
      config: {
        provider: 'captain-provider',
        model: 'captain-model',
        reasoningEffort: 'max',
      },
    }),
  },
}
const resolvedCalls = []
const selectionContext = {
  llm: {
    resolveCallConfig: async (config) => {
      resolvedCalls.push(config)
      return config
    },
  },
}
const inheritedSelection = await resolveMemberLlmSelection(selectionContext, captain, {})
check(
  'ordinary member snapshots the captain current route and effort',
  inheritedSelection.provider === 'captain-provider'
    && inheritedSelection.model === 'captain-model'
    && inheritedSelection.reasoningEffort === 'max',
)
const overriddenSelection = await resolveMemberLlmSelection(selectionContext, captain, {
  provider: 'other-provider',
  model: 'other-model',
})
check(
  'explicit cross-provider route keeps and validates captain effort',
  overriddenSelection.provider === 'other-provider'
    && overriddenSelection.model === 'other-model'
    && resolvedCalls.at(-1)?.reasoningEffort === 'max',
)
const defaultedSelection = await resolveMemberLlmSelection(selectionContext, captain, {
  defaultModel: 'configured-member-model',
})
check(
  'plugin memberModel overrides only the model on the current provider',
  defaultedSelection.provider === 'captain-provider'
    && defaultedSelection.model === 'configured-member-model',
)
let providerWithoutModelRejected = false
try {
  await resolveMemberLlmSelection(selectionContext, captain, { provider: 'other-provider' })
} catch {
  providerWithoutModelRejected = true
}
check('explicit provider without model is rejected', providerWithoutModelRejected)

let startSpec
const spawnMemberRecord = {
  id: '',
  name: 'backend',
  role: 'engineer',
  provider: overriddenSelection.provider,
  model: overriddenSelection.model,
  reasoningEffort: overriddenSelection.reasoningEffort,
  joinedAt: Date.now(),
  status: 'idle',
}
const spawnTeam = {
  name: 'Spawn Verify',
  id: 'spawn-verify',
  captainSessionId: captain.id,
  createdAt: Date.now(),
  members: [],
  tasks: [],
  taskSeq: 0,
}
await spawnMember(
  {
    subagents: {
      getProvider: () => ({
        prepareContinuable: () => undefined,
        capabilities: { persona: true, toolFilter: true },
      }),
      list: () => ['spawn'],
      startContinuable: async (spec) => {
        startSpec = spec
        return { childId: 'spawned-member', messageId: 'welcome-message' }
      },
    },
  },
  { provider: 'spawn', maxDepth: 1 },
  {
    withPending: async (_parentId, _label, _selection, operation) => operation(),
  },
  overriddenSelection,
  captain,
  spawnTeam,
  spawnMemberRecord,
  '.agent-teams',
  new AbortController().signal,
  firstTask,
  'Implement t1 now.',
)
check(
  '#20: spawn receives the resolved per-member provider and model',
  startSpec?.request?.agentOptions?.provider === 'other-provider'
    && startSpec?.request?.agentOptions?.model === 'other-model'
    && spawnMemberRecord.id === 'spawned-member',
)
check(
  'spawn prompt carries the first task brief',
  String(startSpec?.request?.prompt?.[0]?.text ?? '').includes('task t1: Build identity')
    && String(startSpec?.request?.prompt?.[0]?.text ?? '').includes('Implement t1 now.'),
)
check(
  'spawn denies the captain-only report tool',
  startSpec?.request?.toolFilter?.deny?.includes('agent_teams_report_issue') === true,
)

function descriptorEvent(label, agentProvider = 'descriptor-provider', agentModel = 'descriptor-model') {
  return {
    type: 'subagent/descriptor',
    data: {
      version: 2,
      mode: 'continuable',
      provider: 'spawn',
      label,
      agentProvider,
      agentModel,
    },
  }
}

function fakeChildContext({ label, parentSessionId, cwd, agentProvider, agentModel }) {
  const listeners = new Map()
  return {
    listeners,
    context: {
      agent: {
        session: {
          header: { parentSession: parentSessionId, cwd, seedLength: 0 },
          events: [descriptorEvent(label, agentProvider, agentModel)],
        },
      },
      on(name, listener) {
        listeners.set(name, listener)
        return () => listeners.delete(name)
      },
    },
  }
}

async function routedConfig(child) {
  const assemble = child.listeners.get('system-prompt/assemble')
  const request = child.listeners.get('agent/request')
  await assemble({}, {}, async () => ({ variables: {} }))
  return request({}, async () => ({
    provider: 'unselected-provider',
    model: 'unselected-model',
    reasoningEffort: 'low',
  }))
}

let setupMemberSelection
const selectionRuntime = installMemberSelectionRuntime({
  subagents: {
    registerContinuableSetup: (setup) => {
      setupMemberSelection = setup
      return () => undefined
    },
  },
}, '.agent-teams')
const freshChild = fakeChildContext({
  label: 'agent-teams:fresh-team:backend',
  parentSessionId: 'captain-session',
  cwd: process.cwd(),
})
let disposeFresh
await selectionRuntime.withPending(
  'captain-session',
  'agent-teams:fresh-team:backend',
  overriddenSelection,
  async () => {
    disposeFresh = setupMemberSelection(freshChild.context)
  },
)
const freshRoute = await routedConfig(freshChild)
check(
  'fresh child request receives the resolved reasoning effort',
  freshRoute.provider === 'other-provider'
    && freshRoute.model === 'other-model'
    && freshRoute.reasoningEffort === 'max',
)
disposeFresh()

const restoreWorkspace = await mkdtemp(join(tmpdir(), 'dsh-agent-teams-selection-'))
try {
  const restoreStateRoot = join(restoreWorkspace, '.agent-teams')
  await createTeamDir(restoreStateRoot, {
    name: 'Restore Team',
    id: 'restore-team',
    captainSessionId: 'captain-session',
    createdAt: Date.now(),
    members: [{
      id: 'cold-member',
      name: 'reviewer',
      provider: 'cold-provider',
      model: 'cold-model',
      reasoningEffort: 'high',
      joinedAt: Date.now(),
      status: 'idle',
    }],
    tasks: [],
    taskSeq: 0,
  })
  const coldChild = fakeChildContext({
    label: 'agent-teams:restore-team:reviewer',
    parentSessionId: 'captain-session',
    cwd: restoreWorkspace,
    agentProvider: 'cold-provider',
    agentModel: 'cold-model',
  })
  const disposeCold = setupMemberSelection(coldChild.context)
  const coldRoute = await routedConfig(coldChild)
  check(
    'cold-resumed child restores provider, model, and reasoning from team.json',
    coldRoute.provider === 'cold-provider'
      && coldRoute.model === 'cold-model'
      && coldRoute.reasoningEffort === 'high',
  )
  disposeCold()
} finally {
  await rm(restoreWorkspace, { recursive: true, force: true })
}

console.log('8/8 plugin self-iteration reports')
const REPORT = {
  title: 'design_flaw: Scout cannot read context files',
  body: 'Context plugin returns a local file path but Scout agents cannot read it.',
  kind: 'design_flaw',
  severity: 'high',
}
const ISSUE_URL = 'https://github.com/Wuxie233/dsh-plugin-agent-teams/issues/42'
const reportBody = buildIssueBody(REPORT, 'high', 'team `alpha`')
check('report body includes kind and severity', reportBody.includes('`design_flaw`') && reportBody.includes('`high`'))
check('report body includes problem text', reportBody.includes(REPORT.body))
check('report body skips empty optional sections', !reportBody.includes('Where this surfaced') && !reportBody.includes('Reproduction'))
check(
  'report body includes optional sections when provided',
  buildIssueBody({ ...REPORT, trigger: 'during review', repro: 'claim then status', proposal: 'return inline' }, 'medium', 'a standalone session')
    .includes('Where this surfaced')
    && buildIssueBody({ ...REPORT, trigger: 'during review' }, 'medium', 'a standalone session').includes('during review'),
)
check('report body attributes the captain team', reportBody.includes('agent_teams_report_issue') && reportBody.includes('team `alpha`'))
check(
  'standalone sessions may file feedback',
  reportIssueReporter(undefined, 'solo-sess') === 'a standalone session',
)
check(
  'captains may file feedback',
  reportIssueReporter({ captainSessionId: 'lead-sess', name: 'my-team' }, 'lead-sess') === 'team `my-team`',
)
let memberReportRejected = false
try {
  reportIssueReporter({ captainSessionId: 'lead-sess', name: 'my-team' }, 'sess-alice')
} catch (error) {
  memberReportRejected = String(error).includes('captain')
}
check('members cannot file feedback', memberReportRejected)
check(
  'report tool is hidden from members',
  MEMBER_DENIED_TOOLS.includes('agent_teams_report_issue'),
)

function makeMockRun(issueExitCode = 0) {
  const calls = []
  const run = async (args) => {
    calls.push(args)
    if (args.includes('create')) {
      return {
        exitCode: issueExitCode,
        stdout: issueExitCode === 0 ? ISSUE_URL : '',
        stderr: issueExitCode !== 0 ? 'label not found' : '',
      }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  return [run, () => calls]
}

const [happyRun, happyCalls] = makeMockRun()
const filed = await executeTeamReportIssue(REPORT, 'a standalone session', happyRun)
check('standalone report returns the issue URL', filed.url === ISSUE_URL && filed.labelled === true)
check('reports always target the fork tracker', happyCalls().some(args => args.includes(FEEDBACK_REPO) && args.includes('create')))
check('reports apply the collection label', happyCalls().find(args => args.includes('create'))?.includes(FEEDBACK_LABEL) === true)
check('reports apply the kind label', happyCalls().find(args => args.includes('create'))?.includes('design-flaw') === true)
check('reports apply the severity label', happyCalls().find(args => args.includes('create'))?.includes('severity:high') === true)
check(
  'omitted severity defaults to medium',
  (await executeTeamReportIssue({ ...REPORT, severity: undefined }, 'a standalone session', makeMockRun()[0])).labels.includes('severity:medium'),
)
check('label creation is attempted three times', happyCalls().filter(args => args.includes('POST')).length === 3)

const fallbackCalls = []
let createCount = 0
const fallbackRun = async (args) => {
  fallbackCalls.push(args)
  if (args.includes('create')) {
    createCount += 1
    if (createCount === 1) return { exitCode: 1, stdout: '', stderr: 'label not found' }
    return { exitCode: 0, stdout: ISSUE_URL, stderr: '' }
  }
  return { exitCode: 0, stdout: '', stderr: '' }
}
const unlabeled = await executeTeamReportIssue(REPORT, 'a standalone session', fallbackRun)
check('label failure retries without labels', unlabeled.labelled === false && unlabeled.url === ISSUE_URL)
check('second create has no --label args', fallbackCalls.filter(args => args.includes('create'))[1]?.includes('--label') !== true)

let bothCreatesFailed = false
try {
  await executeTeamReportIssue(REPORT, 'a standalone session', async (args) => (
    args.includes('create')
      ? { exitCode: 1, stdout: '', stderr: 'network error' }
      : { exitCode: 0, stdout: '', stderr: '' }
  ))
} catch (error) {
  bothCreatesFailed = String(error).includes('Could not file the issue')
}
check('both create attempts failing is loud', bothCreatesFailed)

let emptyTitleRejected = false
try {
  await executeTeamReportIssue({ ...REPORT, title: '  ' }, 'a standalone session', makeMockRun()[0])
} catch (error) {
  emptyTitleRejected = String(error).includes('title is required')
}
check('empty title is rejected', emptyTitleRejected)

let emptyBodyRejected = false
try {
  await executeTeamReportIssue({ ...REPORT, body: '  ' }, 'a standalone session', makeMockRun()[0])
} catch (error) {
  emptyBodyRejected = String(error).includes('body is required')
}
check('empty body is rejected', emptyBodyRejected)

// ── member worktree spawn ────────────────────────────────────────────────────
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const wtRoot = mkdtempSync(join(tmpdir(), 'agent-teams-wt-'))
try {
  execFileSync('git', ['-C', wtRoot, 'init', '-q'])
  execFileSync('git', ['-C', wtRoot, 'config', 'user.email', 'verify@local'])
  execFileSync('git', ['-C', wtRoot, 'config', 'user.name', 'verify'])
  await writeFile(join(wtRoot, 'a.txt'), 'a\n')
  execFileSync('git', ['-C', wtRoot, 'add', '.'])
  execFileSync('git', ['-C', wtRoot, 'commit', '-qm', 'init'])
  execFileSync('git', ['-C', wtRoot, 'worktree', 'add', '-q', '-b', 'lane-x', join(wtRoot, '.dsh-wt', 'lane-x')])
  const worktreePath = join(wtRoot, '.dsh-wt', 'lane-x')

  const wtCaptain = { id: 'wt-captain', session: { header: { cwd: wtRoot, id: 'wt-captain' } } }
  const wtTeam = { name: 'WT Verify', id: 'wt-verify', captainSessionId: 'wt-captain', createdAt: Date.now(), members: [], tasks: [], taskSeq: 0 }
  let wtSpec
  let wtInterrupted = false
  const wtMember = { id: '', name: 'lane-x', role: 'engineer', joinedAt: Date.now(), status: 'idle' }
  await spawnMember(
    {
      subagents: {
        getProvider: () => ({ prepareContinuable: () => undefined, capabilities: { persona: true, toolFilter: true } }),
        list: () => ['spawn'],
        startContinuable: async (spec) => {
          wtSpec = spec
          return { childId: 'wt-member', messageId: 'm1' }
        },
        interrupt: () => { wtInterrupted = true },
      },
      agents: { get: () => ({ session: { header: { cwd: worktreePath } } }) },
    },
    { provider: 'spawn', maxDepth: 1 },
    { withPending: async (_p, _l, _s, op) => op() },
    { provider: 'mock', model: 'mock' },
    wtCaptain,
    wtTeam,
    wtMember,
    '.agent-teams',
    new AbortController().signal,
    firstTask,
    'Implement t1 now.',
    worktreePath,
  )
  check(
    'worktree spawn passes cwd and records it on the member',
    wtSpec?.cwd === worktreePath && wtMember.worktree === worktreePath && wtMember.id === 'wt-member' && wtInterrupted === false,
  )
  const pointer = JSON.parse(readFileSync(join(worktreePath, '.agent-teams', 'captain-pointer.json'), 'utf8'))
  check(
    'captain pointer names the captain workspace and team',
    pointer.captainWorkspace === wtRoot && pointer.teamId === 'wt-verify',
  )

  const cwdDir = join(wtRoot, 'app')
  await mkdir(cwdDir, { recursive: true })
  let cwdSpec
  const cwdMember = { id: '', name: 'app-eng', role: 'engineer', joinedAt: Date.now(), status: 'idle' }
  await spawnMember(
    {
      subagents: {
        getProvider: () => ({ prepareContinuable: () => undefined, capabilities: { persona: true, toolFilter: true } }),
        list: () => ['spawn'],
        startContinuable: async (spec) => {
          cwdSpec = spec
          return { childId: 'cwd-member', messageId: 'm-cwd' }
        },
        interrupt: () => {},
      },
      agents: { get: () => ({ session: { header: { cwd: cwdDir } } }) },
    },
    { provider: 'spawn', maxDepth: 1 },
    { withPending: async (_p, _l, _s, op) => op() },
    { provider: 'mock', model: 'mock' },
    wtCaptain,
    wtTeam,
    cwdMember,
    '.agent-teams',
    new AbortController().signal,
    firstTask,
    'Implement t1 now.',
    undefined,
    cwdDir,
  )
  check('non-worktree cwd is passed through', cwdSpec?.cwd === cwdDir && cwdMember.id === 'cwd-member' && cwdMember.worktree === undefined)
  const cwdPointer = JSON.parse(readFileSync(join(cwdDir, '.agent-teams', 'captain-pointer.json'), 'utf8'))
  check(
    'cwd that differs from the captain workspace writes a captain pointer',
    cwdPointer.captainWorkspace === wtRoot && cwdPointer.teamId === 'wt-verify',
  )

  let relativeCwdRefused = false
  try {
    await spawnMember(
      {
        subagents: {
          getProvider: () => ({ prepareContinuable: () => undefined, capabilities: { persona: true, toolFilter: true } }),
          list: () => ['spawn'],
          startContinuable: async () => { throw new Error('must not spawn') },
        },
        agents: { get: () => ({ session: { header: { cwd: wtRoot } } }) },
      },
      { provider: 'spawn', maxDepth: 1 },
      { withPending: async (_p, _l, _s, op) => op() },
      { provider: 'mock', model: 'mock' },
      wtCaptain,
      wtTeam,
      { id: '', name: 'rel-cwd', role: 'engineer', joinedAt: Date.now(), status: 'idle' },
      '.agent-teams',
      new AbortController().signal,
      firstTask,
      'Implement t1 now.',
      undefined,
      'relative/path',
    )
  } catch (error) {
    relativeCwdRefused = String(error).includes('absolute path')
  }
  check('relative cwd path is rejected', relativeCwdRefused)

  const refuseSpawn = (runtimeConfig, memberDraft, worktreeArg) => spawnMember(
    {
      subagents: {
        getProvider: () => ({ prepareContinuable: () => undefined, capabilities: { persona: true, toolFilter: true } }),
        list: () => ['spawn'],
        startContinuable: async () => { throw new Error('must not spawn') },
      },
      agents: { get: () => ({ session: { header: { cwd: wtRoot } } }) },
    },
    runtimeConfig,
    { withPending: async (_p, _l, _s, op) => op() },
    { provider: 'mock', model: 'mock' },
    wtCaptain,
    wtTeam,
    memberDraft,
    '.agent-teams',
    new AbortController().signal,
    firstTask,
    'Implement t1 now.',
    worktreeArg,
  )

  let readOnlyRefused = false
  try {
    await refuseSpawn(
      { provider: 'spawn', maxDepth: 1, readOnlyRoles: ['reviewer'] },
      { id: '', name: 'rv', role: 'reviewer', joinedAt: Date.now(), status: 'idle' },
      worktreePath,
    )
  } catch (error) {
    readOnlyRefused = String(error).includes('read-only role')
  }
  check('read-only role refuses a worktree', readOnlyRefused)

  let relativeRefused = false
  try {
    await refuseSpawn(
      { provider: 'spawn', maxDepth: 1 },
      { id: '', name: 'rel', role: 'engineer', joinedAt: Date.now(), status: 'idle' },
      'relative/path',
    )
  } catch (error) {
    relativeRefused = String(error).includes('absolute path')
  }
  check('relative worktree path is rejected', relativeRefused)

  let seamMissLoud = false
  try {
    await spawnMember(
      {
        subagents: {
          getProvider: () => ({ prepareContinuable: () => undefined, capabilities: { persona: true, toolFilter: true } }),
          list: () => ['spawn'],
          startContinuable: async () => ({ childId: 'silent-member', messageId: 'm2' }),
          interrupt: () => {},
        },
        agents: { get: () => ({ session: { header: { cwd: wtRoot } } }) },
      },
      { provider: 'spawn', maxDepth: 1 },
      { withPending: async (_p, _l, _s, op) => op() },
      { provider: 'mock', model: 'mock' },
      wtCaptain,
      wtTeam,
      { id: '', name: 'silent', role: 'engineer', joinedAt: Date.now(), status: 'idle' },
      '.agent-teams',
      new AbortController().signal,
      firstTask,
      'Implement t1 now.',
      worktreePath,
    )
  } catch (error) {
    seamMissLoud = String(error).includes('child-cwd seam')
  }
  check('unpatched runtime seam fails loud and interrupts the member', seamMissLoud)
} finally {
  rmSync(wtRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

console.log('source: conversation cards do not poll the snapshot route')
{
  const root = dirname(fileURLToPath(import.meta.url))
  const card = await readFile(join(root, '../src/client/AgentTeamsCard.tsx'), 'utf8')
  check('AgentTeamsCard does not fetch /plugins/dsh-agent-teams/state', !card.includes('/plugins/dsh-agent-teams/state'))
  check('AgentTeamsCard does not start a setInterval poll', !card.includes('setInterval'))
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('\nall checks passed')
