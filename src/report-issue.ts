/**
 * Captain-owned plugin feedback: file one GitHub issue per observed
 * AgentTeams defect so a later session can triage the fork.
 * @module dsh-agent-teams/report-issue
 */

import { spawn } from 'node:child_process'
import type { Readable } from 'node:stream'

/** Feedback category for a reported plugin defect. */
export type IssueKind = 'bug' | 'design_flaw' | 'inefficiency' | 'missing_capability'

/** Impact level used to triage which reports are worth iterating on. */
export type IssueSeverity = 'critical' | 'high' | 'medium' | 'low'

/** Canonical repository that owns AgentTeams fork feedback. */
export const FEEDBACK_REPO = 'Wuxie233/dsh-plugin-agent-teams'

/** Marker label applied to every report so collection runs can filter reliably. */
export const FEEDBACK_LABEL = 'agent-teams-feedback'

/** Arguments accepted by the agent_teams_report_issue tool. */
export interface TeamReportIssueArgs {
  title: string
  body: string
  kind: IssueKind
  severity?: IssueSeverity
  trigger?: string
  repro?: string
  proposal?: string
}

/** Captured subprocess result used by the injectable runner. */
export interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

/** Injectable subprocess runner — replaced with a stub in tests. */
export type RunFn = (args: string[]) => Promise<CommandResult>

const KIND_LABEL: Record<IssueKind, string> = {
  bug: 'bug',
  design_flaw: 'design-flaw',
  inefficiency: 'inefficiency',
  missing_capability: 'missing-capability',
}

const KIND_COLOR: Record<IssueKind, string> = {
  bug: 'd73a4a',
  design_flaw: 'd93f0b',
  inefficiency: 'fbca04',
  missing_capability: 'a2eeef',
}

const SEVERITY_COLOR: Record<IssueSeverity, string> = {
  critical: 'b60205',
  high: 'e99695',
  medium: 'fef2c0',
  low: 'c2e0c6',
}

/** Collect one readable stream into a buffer list. */
function collect(stream: Readable | null, chunks: Buffer[]): void {
  stream?.on('data', (chunk: Buffer | string) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  })
}

/**
 * Run a subprocess and capture stdout/stderr. Used only to talk to `gh`.
 * @param args - argv, first element is the executable.
 * @returns the process result, including spawn failures as exitCode 1.
 */
export function runCommand(args: string[]): Promise<CommandResult> {
  const [command, ...commandArgs] = args
  if (command === undefined) return Promise.resolve({ exitCode: 1, stdout: '', stderr: 'No command provided' })

  return new Promise((resolve) => {
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let settled = false
    const finish = (result: CommandResult) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    const child = spawn(command, commandArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
    collect(child.stdout, stdout)
    collect(child.stderr, stderr)
    child.on('error', (error) => {
      finish({
        exitCode: 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: error.message,
      })
    })
    child.on('close', (code) => {
      finish({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    })
  })
}

/** Create a GitHub label, ignoring the 422 that means it already exists. */
async function ensureLabel(repo: string, name: string, color: string, description: string, run: RunFn): Promise<void> {
  await run([
    'gh', 'api', `repos/${repo}/labels`,
    '--method', 'POST',
    '-f', `name=${name}`,
    '-f', `color=${color}`,
    '-f', `description=${description}`,
  ])
}

/**
 * Render the issue body: fixed sections so collection runs can skim consistently.
 * @param args - reporter-supplied fields.
 * @param severity - resolved severity, including the default.
 * @param reportedBy - human-readable origin (`team \`name\`` or standalone).
 * @returns markdown body for `gh issue create`.
 */
export function buildIssueBody(args: TeamReportIssueArgs, severity: IssueSeverity, reportedBy: string): string {
  const lines = [
    `**Kind:** \`${args.kind}\` — **Severity:** \`${severity}\``,
    '',
    '## Problem',
    args.body.trim(),
  ]
  if (args.trigger?.trim()) lines.push('', '## Where this surfaced', args.trigger.trim())
  if (args.repro?.trim()) lines.push('', '## Reproduction', args.repro.trim())
  if (args.proposal?.trim()) lines.push('', '## Suggested direction', args.proposal.trim())
  lines.push(
    '',
    '---',
    `Reported by \`agent_teams_report_issue\` from ${reportedBy}. Not yet triaged — confirm the defect against source before acting on it.`,
  )
  return lines.join('\n')
}

/**
 * Decide whether this caller may file feedback and how to attribute it.
 * Members are rejected; captains and sessions with no team are allowed.
 * @param team - the caller's active team, if any.
 * @param callerId - the calling agent's session id.
 * @returns attribution written into the issue footer.
 */
export function reportIssueReporter(
  team: { captainSessionId: string; name: string } | undefined,
  callerId: string,
): string {
  if (team !== undefined && team.captainSessionId !== callerId) {
    throw new Error(
      'Only the team captain can file plugin feedback. Send the finding to the captain with agent_teams_send_message instead.',
    )
  }
  return team === undefined ? 'a standalone session' : `team \`${team.name}\``
}

/** Structured result returned to the calling captain. */
export interface ReportIssueResult {
  url: string
  repo: string
  labels: string[]
  labelled: boolean
}

/**
 * File one AgentTeams defect report as a GitHub issue on the fork tracker.
 * Callers must already have passed the captain-or-standalone authorization check.
 * @param args - validated tool arguments.
 * @param reportedBy - attribution string written into the issue footer.
 * @param run - subprocess runner, injectable in tests.
 * @returns the created issue URL and whether labels stuck.
 */
export async function executeTeamReportIssue(
  args: TeamReportIssueArgs,
  reportedBy: string,
  run: RunFn = runCommand,
): Promise<ReportIssueResult> {
  const title = args.title.trim()
  if (title === '') throw new Error('An issue title is required.')
  if (args.body.trim() === '') throw new Error('An issue body is required.')

  const severity = args.severity ?? 'medium'
  const kindLabel = KIND_LABEL[args.kind]
  const severityLabel = `severity:${severity}`
  const body = buildIssueBody(args, severity, reportedBy)
  const labels = [FEEDBACK_LABEL, kindLabel, severityLabel]

  // Best effort: a missing label would otherwise fail the whole report.
  await Promise.all([
    ensureLabel(FEEDBACK_REPO, FEEDBACK_LABEL, '5319e7', 'AgentTeams self-iteration feedback', run),
    ensureLabel(FEEDBACK_REPO, kindLabel, KIND_COLOR[args.kind], `AgentTeams feedback kind: ${args.kind}`, run),
    ensureLabel(FEEDBACK_REPO, severityLabel, SEVERITY_COLOR[severity], `AgentTeams feedback severity: ${severity}`, run),
  ])

  const base = ['gh', 'issue', 'create', '--repo', FEEDBACK_REPO, '--title', title, '--body', body]
  const labelled = await run([
    ...base,
    '--label', FEEDBACK_LABEL,
    '--label', kindLabel,
    '--label', severityLabel,
  ])
  if (labelled.exitCode === 0) {
    return { url: labelled.stdout.trim(), repo: FEEDBACK_REPO, labels, labelled: true }
  }

  const plain = await run(base)
  if (plain.exitCode !== 0) {
    const reason = (plain.stderr || labelled.stderr || 'unknown error').trim()
    throw new Error(`Could not file the issue on ${FEEDBACK_REPO}: ${reason}`)
  }
  return { url: plain.stdout.trim(), repo: FEEDBACK_REPO, labels, labelled: false }
}
