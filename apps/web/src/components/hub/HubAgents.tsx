/**
 * Hub Agents: subagents and delegated tasks this thread spawned (`hubAgents.logic.ts`), live
 * first. Built from the title-bar lineage control's pieces (`ThreadRelationshipIcon`,
 * `AgentElapsed`, `SubagentTooltipContent`) so a helper reads the same in both places.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  OrchestrationProjectShell,
  OrchestrationV2ThreadShell,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { formatModelSlugName, resolveSelectableModel } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";
import { BotIcon, CornerLeftUpIcon } from "lucide-react";
import { useState } from "react";

import { AgentElapsed } from "~/components/chat/AgentElapsed";
import { RunningSubagentActivity } from "~/components/chat/RunningSubagentActivity";
import { getTriggerDisplayModelName } from "~/components/chat/providerIconUtils";
import { SubagentTooltipContent } from "~/components/chat/SubagentTooltipContent";
import {
  ThreadRelationshipIcon,
  threadRelationshipStatusLabel,
} from "~/components/chat/ThreadRelationshipIcon";
import { ThreadHoverCardPopup } from "~/components/ThreadHoverCard";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { buildThreadRouteParams } from "~/threadRoutes";

import { hubAgentKindLabel, type HubAgent } from "./hubAgents.logic";
import { HubDisclosure, HubSection } from "./HubPrimitives";

const MAX_ROWS = 5;

const AGENTS_DESCRIPTION =
  "Helper agents this thread spawned: provider subagents and delegated tasks. Running ones first with what they are doing and a timer; finished ones dimmed with their final duration. Click one to open its thread.";

export function hubAgentModelLabel(
  model: string | null,
  provider: ServerProvider | undefined,
): string | null {
  const trimmed = model?.trim();
  if (!trimmed) return null;
  const slug = provider
    ? resolveSelectableModel(provider.driver, trimmed, provider.models)
    : trimmed;
  const providerModel = provider?.models.find((candidate) => candidate.slug === slug);
  return providerModel
    ? getTriggerDisplayModelName(providerModel, provider?.driver)
    : formatModelSlugName(trimmed);
}

type HubProject = Pick<OrchestrationProjectShell, "id" | "title" | "workspaceRoot">;

interface ThreadContext {
  readonly environmentId: EnvironmentId;
  readonly providers: readonly ServerProvider[];
  readonly thread: OrchestrationV2ThreadShell | undefined;
  readonly threadsById: ReadonlyMap<ThreadId, OrchestrationV2ThreadShell>;
  readonly projects: readonly HubProject[];
}

function AgentRow({
  agent,
  context,
  onOpen,
}: {
  agent: HubAgent;
  context: ThreadContext;
  onOpen: (threadId: ThreadId) => void;
}) {
  const child = agent.childThreadId ? context.threadsById.get(agent.childThreadId) : undefined;
  const provider = context.providers.find((entry) => entry.instanceId === agent.providerInstanceId);
  const driver = agent.driver ?? provider?.driver;
  const modelLabel = hubAgentModelLabel(agent.model, provider);
  const statusLabel = threadRelationshipStatusLabel(agent.status);
  const childThreadId = agent.childThreadId;
  const subtitle = [
    hubAgentKindLabel(agent.kind),
    modelLabel,
    agent.live ? (agent.progress?.trim() ?? null) : null,
  ]
    .filter((part): part is string => !!part)
    .join(" · ");
  return (
    <Tooltip>
      <TooltipTrigger
        delay={200}
        render={
          <button
            aria-label={`${agent.title} ${statusLabel}`}
            className={cn(
              "group flex h-11 w-full items-center gap-2.5 rounded-lg px-1.5 text-left",
              childThreadId ? "hover:bg-accent/70" : "cursor-default",
              agent.live ? null : "opacity-75",
            )}
            data-hub-agent={agent.id}
            data-hub-agent-status={agent.status}
            disabled={!childThreadId}
            onClick={childThreadId ? () => onOpen(childThreadId) : undefined}
            type="button"
          />
        }
      >
        <ThreadRelationshipIcon
          driver={driver}
          provider={provider}
          fallbackIcon={BotIcon}
          status={agent.status}
        />
        <span className="flex min-w-0 flex-1 flex-col">
          <span
            className={cn(
              "truncate text-xs",
              agent.live ? "font-medium text-foreground" : "text-foreground/80",
            )}
          >
            {agent.title}
          </span>
          {subtitle ? (
            <span className="flex min-w-0 items-baseline gap-1 overflow-hidden text-2xs text-muted-foreground">
              {agent.status === "running" ? (
                <RunningSubagentActivity
                  environmentId={context.environmentId}
                  childThreadId={agent.childThreadId}
                  status={agent.status}
                  startedAt={agent.startedAt}
                  updatedAt={agent.updatedAt}
                  progress={agent.progress}
                  showAction={!agent.progress?.trim()}
                />
              ) : null}
              <span className="min-w-0 truncate">{subtitle}</span>
            </span>
          ) : null}
        </span>
        <span className="flex shrink-0 flex-col items-end gap-0.5">
          {agent.startedAt ? (
            <span
              className={cn(
                "text-2xs tabular-nums",
                agent.live ? "text-foreground/80" : "text-muted-foreground/70",
              )}
            >
              <AgentElapsed agent={agent} />
            </span>
          ) : null}
          <span
            className={cn(
              "text-3xs",
              agent.status === "failed"
                ? "text-destructive-foreground"
                : agent.live
                  ? "text-info-foreground"
                  : "text-muted-foreground/70",
            )}
          >
            {statusLabel}
          </span>
        </span>
      </TooltipTrigger>
      <ThreadHoverCardPopup side="left">
        <SubagentTooltipContent
          title={agent.title}
          model={agent.model}
          providerInstanceId={agent.providerInstanceId}
          origin={agent.kind === "delegated" ? "app_owned" : "provider_native"}
          provider={provider}
          providers={context.providers}
          driver={driver}
          elapsed={agent.startedAt ? <AgentElapsed agent={agent} /> : undefined}
          status={agent.status}
          result={agent.result}
          progress={agent.progress}
          parentThread={context.thread}
          childThread={child}
          parentProject={context.projects.find(
            (project) => project.id === context.thread?.projectId,
          )}
          childProject={context.projects.find((project) => project.id === child?.projectId)}
        />
      </ThreadHoverCardPopup>
    </Tooltip>
  );
}

export function HubAgents({
  agents,
  environmentId,
  providers,
  thread,
  threadsById,
  projects,
  parent,
}: {
  agents: readonly HubAgent[];
  environmentId: EnvironmentId;
  providers: readonly ServerProvider[];
  thread: OrchestrationV2ThreadShell | undefined;
  threadsById: ReadonlyMap<ThreadId, OrchestrationV2ThreadShell>;
  projects: readonly HubProject[];
  /** Set when this thread is itself a subagent: one row back up to the thread that spawned it. */
  parent: { readonly id: ThreadId; readonly title: string } | null;
}) {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  if (agents.length === 0 && parent === null) return null;
  const live = agents.filter((agent) => agent.live).length;
  // Live agents are never folded away; the cap only trims finished ones.
  const cap = Math.max(MAX_ROWS, live);
  const shown = expanded ? agents : agents.slice(0, cap);
  const hidden = agents.length - shown.length;
  const openThread = (threadId: ThreadId) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
    });
  };
  const context: ThreadContext = { environmentId, providers, thread, threadsById, projects };
  return (
    <HubSection
      title="Agents"
      icon={<BotIcon />}
      description={AGENTS_DESCRIPTION}
      count={agents.length === 0 ? undefined : live > 0 ? live : agents.length}
      countLabel={live > 0 ? `${live} running` : `${agents.length} finished`}
      countTone={live > 0 ? "primary" : "neutral"}
      action={
        agents.length > 0 ? (
          <span className="text-2xs tabular-nums text-muted-foreground">
            {live > 0 ? `${live} running` : "All finished"}
          </span>
        ) : undefined
      }
    >
      {parent ? (
        <Tooltip>
          <TooltipTrigger
            delay={200}
            render={
              <button
                className="flex h-8 w-full items-center gap-2.5 rounded-lg px-1.5 text-left text-xs text-muted-foreground hover:bg-accent/70 hover:text-foreground"
                onClick={() => openThread(parent.id)}
                type="button"
              />
            }
          >
            <CornerLeftUpIcon className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">Spawned by {parent.title}</span>
          </TooltipTrigger>
          <TooltipPopup side="left">Open the thread that started this one</TooltipPopup>
        </Tooltip>
      ) : null}
      {shown.map((agent) => (
        <AgentRow key={agent.id} agent={agent} context={context} onOpen={openThread} />
      ))}
      {hidden > 0 || expanded ? (
        <HubDisclosure onToggle={() => setExpanded((it) => !it)} open={expanded}>
          {expanded ? "Show less" : `${hidden} more`}
        </HubDisclosure>
      ) : null}
    </HubSection>
  );
}
