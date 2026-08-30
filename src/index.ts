/**
 * AgentTeams for DeepSeek Harness.
 *
 * A host-plane plugin with two independently mountable surfaces:
 * - `registerTools` (default true): `agent_teams_*` tools plus the systemPrompt
 *   usage section. A Team agent preset mounts this so only that preset's
 *   sessions see the tools.
 * - `registerWeb` (default true): `/plugins/dsh-agent-teams/state` and artwork
 *   routes for the Web activity panel. A host-plane mount keeps the panel
 *   without exposing tools to Native sessions by setting `registerTools: false`.
 *
 * Both flags default true so a single-row install still behaves as before.
 * Dual-mount (host panel + Team-preset tools) must flip the unused surface
 * off. A second Web mount now skips an already-owned route instead of
 * throwing, so a stale or mis-flagged remount cannot kill session.create.
 *
 * `inject` stays unconditional (`tools`, `llm`, `subagents`, `systemPrompt`,
 * `agents`) so existing host mounts keep activating against the same service
 * set even when `registerTools` is false. Web server / workspace registry
 * stay lazy via `ctx.get` so a webless or tools-only mount never blocks boot.
 *
 * @module dsh-agent-teams
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Declaration merge only: makes ctx.llm, ctx.subagents and ctx.systemPrompt visible.
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { registerAgentTeamsTools, type ToolsConfig } from './tools.ts'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectArchivedTeamsActivity, collectTeamsActivity } from './snapshot.ts'
import { SNAPSHOT_ROUTE_TIMEOUT_MS, withTimeout } from './timeout.ts'
import { isDuplicateRouteError } from './duplicate-route.ts'

export { isDuplicateRouteError } from './duplicate-route.ts'

/**
 * Structural slice of the web server service, compatible with both the
 * published `dsh-host-webserver@0.0.1-rc.1` (`ctx.httpServer` /
 * `HttpServerService`) and the renamed `webServer` / `WebServer` in later
 * builds: the beta transition renames the service without changing the route
 * registration shape.
 */
interface WebRouteHost {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** Web-server service key candidates, newest first. */
const WEB_SERVER_KEYS = ['webServer', 'httpServer'] as const
/** Workspace registry service key candidates, newest first. */
const WORKSPACE_KEYS = ['workspaceRegistry', 'workspace'] as const

export const name = 'agent-teams'
export const inject = ['tools', 'llm', 'subagents', 'systemPrompt', 'agents']

/** Plugin configuration. */
export interface Config {
  /**
   * State directory name under the captain's workspace; team state lives at
   * `<workspace>/<stateDir>/<teamId>/` (default `.agent-teams`).
   */
  stateDir?: string
  /** `ctx.subagents` provider used to spawn members; must support continuable children and personas (default `spawn`). */
  memberProvider?: string
  /** Optional model override applied to every member. */
  memberModel?: string
  /** Member delegation depth cap (default `1`; `0` forbids delegation entirely). */
  memberMaxDepth?: number
  /** Optional live-member cap; omit for no cap. */
  maxMembers?: number
  /** Role tokens whose members deny write/edit/bash on spawn (matched case-insensitively by substring). */
  readOnlyRoles?: string[]
  /** Prompt-section order for the usage policy (default `117`, after delegation policy). */
  promptSectionOrder?: number
  /**
   * When true, register `agent_teams_*` tools and the systemPrompt usage
   * section (default true). Host-plane mounts that only want the Web activity
   * panel should set this to false so Native sessions do not see the tools.
   */
  registerTools?: boolean
  /**
   * When true, register `/plugins/dsh-agent-teams/state` and artwork routes
   * (default true). A Team agent preset that already shares the host Web panel
   * should set this to false to avoid double-registering HTTP routes.
   */
  registerWeb?: boolean
}

export const Config: z<Config> = z.object({
  stateDir: z.string().default('.agent-teams'),
  memberProvider: z.string().default('spawn'),
  memberModel: z.string(),
  memberMaxDepth: z.natural().default(1),
  maxMembers: z.natural().min(1),
  readOnlyRoles: z.array(z.string()).default(['scout', 'reviewer', 'planner', 'diagnostician']),
  promptSectionOrder: z.natural().default(117),
  registerTools: z.boolean().default(true),
  registerWeb: z.boolean().default(true),
})

/** The model-facing usage policy: when and how to drive AgentTeams. */
function usageSectionText(toolNames: string): string {
  return `When the user asks to run something with AgentTeams (e.g. "use AgentTeams to do X"), you are the captain of a multi-agent team. Follow this protocol:
1. Call agent_teams_create with a team name and the goal as description. You become the captain and may lead one team at a time.
2. Call agent_teams_add_member once per role, with that member's first task_subject and prompt (or brief/instructions/task_description if prompt cannot be emitted). The spawn brief is the first claimed task, not a greeting. Do not create_task for a member that does not exist yet. Members are durable subagents. By default each member snapshots your current provider, model, and reasoning effort. Never ask the user to choose these per member; only pass provider/model when the user explicitly requests a different route for that role. Default writers share the captain workspace with exclusive path ownership. If this session sits on an umbrella workspace, pass cwd as the absolute repo path so the member stays inside it. Only when two writers must edit the same files in parallel, or the change must stay abortable, create a git worktree first and pass that absolute path as worktree; a member's worktree is frozen at spawn. Read-only roles refuse worktrees. Merge member trees back in dependency order; you resolve conflicts.
3. After members exist, create later tasks with agent_teams_create_task. Dependencies must already exist. Use only task ids returned by earlier calls (t1, t2, …). Never invent task-1. assignee must name a live member, or omit it. Create in topological order: frontier first, then dependents after those calls return.
4. After the first spawn brief, do not send a blank "please continue" or "start now" reminder. Yield. Wait for a member report or a plugin stall notice. Only then send a new instruction, extra context, or a plan change with agent_teams_send_message. Default delivery barges in so that new instruction starts immediately. Pass mode=queue only when the current turn must finish first. One task per message keeps turns focused.
5. Progress comes from member reports and stall notices, not from polling transcripts because files are still unchanged. agent_teams_status is for a snapshot after a notice, collecting completed outputs, or a stall — not a wait loop. If a member reports a blocker, reassign the task or adjust the plan.
6. Present the team's results to the user, then agent_teams_delete the team unless the user wants to keep working with it.

Tools: ${toolNames}`
}

export function apply(ctx: Context, config: Config): void {
  const resolved: ToolsConfig = {
    stateDir: config.stateDir ?? '.agent-teams',
    memberProvider: config.memberProvider ?? 'spawn',
    memberModel: config.memberModel,
    memberMaxDepth: config.memberMaxDepth ?? 1,
    maxMembers: config.maxMembers,
    readOnlyRoles: config.readOnlyRoles ?? ['scout', 'reviewer', 'planner', 'diagnostician'],
  }
  const registerTools = config.registerTools ?? true
  const registerWeb = config.registerWeb ?? true

  // Provider registration is a sibling plugin's effect (`subagent-spawn` /
  // `subagent-fork` rows), which can land after this mount under the Loader's
  // concurrent activation — so capability validation happens at the first
  // member spawn (`spawnMember`), the earliest point the provider list is
  // settled, rather than here.

  if (registerTools) {
    const toolNames = [
      'agent_teams_create',
      'agent_teams_add_member',
      'agent_teams_remove_member',
      'agent_teams_create_task',
      'agent_teams_claim_task',
      'agent_teams_update_task',
      'agent_teams_send_message',
      'agent_teams_status',
      'agent_teams_delete',
      // agent_teams_report_issue stays off this shared list: members share
      // the usage section and must not be invited to hunt plugin defects.
    ].join(', ')
    ctx.systemPrompt.section({
      name: 'agent-teams:usage',
      order: config.promptSectionOrder ?? 117,
      text: usageSectionText(toolNames),
    })

    registerAgentTeamsTools(ctx, resolved)
  }

  if (!registerWeb) return

  // The activity panel data/artwork routes need the Web server and the
  // workspace registry, which headless profiles do not mount; under
  // concurrent activation they may also bind after this plugin. Register the
  // routes lazily: try now, then on each service binding event. In a webless
  // profile the plugin stays tool-only and never blocks boot.
  let webRegistered = false
  const registerWebSurface = (): void => {
    if (webRegistered) return
    const webServer = (ctx.get(WEB_SERVER_KEYS[0]) ?? ctx.get(WEB_SERVER_KEYS[1])) as WebRouteHost | undefined
    const workspaceRegistry = (ctx.get(WORKSPACE_KEYS[0]) ?? ctx.get(WORKSPACE_KEYS[1])) as WorkspaceRegistry | undefined
    if (webServer === undefined || workspaceRegistry === undefined) return
    webRegistered = true

    const registerQuietly = (
      route: Parameters<WebRouteHost['register']>[0],
      label: string,
    ): void => {
      ctx.effect(() => {
        try {
          return webServer.register(route)
        } catch (error) {
          if (isDuplicateRouteError(error)) {
            ctx.logger.warn(`agent-teams: ${route.path} already registered, skipping`)
            return () => {}
          }
          throw error
        }
      }, label)
    }

    // Activity panel data route: the browser floater polls this for team
    // snapshots (disk truth + live subagent activity). Mirrors the Claude
    // Code desktop watcher's server-side snapshot pattern.
    registerQuietly({
    kind: 'exact',
    path: '/plugins/dsh-agent-teams/state',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      const roots = workspaceRegistry.list().map((workspace) => ({
        workspace: workspace.title,
        stateRoot: join(workspace.path, resolved.stateDir),
      }))
      try {
        // ?archived=1 serves teams moved to archive/ (post-delete review).
        const snapshots = await withTimeout(
          url.searchParams.get('archived') === '1'
            ? collectArchivedTeamsActivity(ctx, roots)
            : collectTeamsActivity(ctx, roots),
          SNAPSHOT_ROUTE_TIMEOUT_MS,
          `agent-teams snapshot timed out after ${SNAPSHOT_ROUTE_TIMEOUT_MS}ms`,
        )
        const body = JSON.stringify({ teams: snapshots })
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(body)
      } catch (error: unknown) {
        ctx.logger.warn(`agent-teams: snapshot route failed: ${String(error)}`)
        res.writeHead(503, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(JSON.stringify({ error: 'snapshot-unavailable' }))
      }
    },
  }, 'agent-teams: activity route')

  // Whale mascot artwork: serve the packaged role/action images to the
  // activity panel. An explicit allowlist guards the route (no path
  // traversal); the images ship with the bundle (files: assets/).
  const artDir = fileURLToPath(new URL('../assets/agent-teams/', import.meta.url))
  const ART_ALLOWLIST = new Set([
    'team-lead.png', 'researcher.png', 'engineer.png', 'designer.png',
    'qa-engineer.png', 'security-reviewer.png', 'data-analyst.png',
    'docs-coordinator.png', 'action-working.png', 'action-thinking.png',
    'action-reporting.png', 'action-celebrating.png', 'action-sleeping.png',
    'action-sending.png',
  ])
    registerQuietly({
      kind: 'prefix',
      path: '/plugins/dsh-agent-teams/assets',
    handler: async (req, res) => {
      let name: string
      try {
        name = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname.split('/').pop() ?? '')
      } catch {
        // Malformed percent-encoding: treat as an unknown asset, not a 400.
        res.writeHead(404)
        res.end()
        return
      }
      if (!ART_ALLOWLIST.has(name)) {
        res.writeHead(404)
        res.end()
        return
      }
      try {
        const data = await readFile(join(artDir, name))
        res.writeHead(200, {
          'content-type': 'image/png',
          'cache-control': 'public, max-age=86400',
        })
        res.end(data)
      } catch (error: unknown) {
        ctx.logger.warn(`agent-teams: artwork read failed for ${name}: ${String(error)}`)
        res.writeHead(404)
        res.end()
      }
      },
    }, 'agent-teams: artwork route')
  }

  registerWebSurface()
  ctx.on('internal/service', (name) => {
    if (WEB_SERVER_KEYS.includes(name as (typeof WEB_SERVER_KEYS)[number])
      || WORKSPACE_KEYS.includes(name as (typeof WORKSPACE_KEYS)[number])) {
      registerWebSurface()
    }
  })
}
