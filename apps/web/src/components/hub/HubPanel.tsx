/**
 * Hub right-panel surface: the thread's agents, tasks, outputs, sources and connectors, derived
 * on the client from v2 state (no server artifact index, so only loaded history counts). Pins,
 * hides and manual entries live in a server overlay (`useThreadHubOverlay`) shared across clients.
 */
import type { OrchestrationV2ThreadShell, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import {
  BookOpenIcon,
  BoxesIcon,
  CopyIcon,
  FileDiffIcon,
  FolderOutputIcon,
  MoreHorizontalIcon,
  PlusIcon,
  WrenchIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { useOpenLink } from "~/browser/useOpenLink";
import { useThreadHubOverlay } from "~/hooks/useThreadHubOverlay";
import {
  buildHubModel,
  deriveHubArtifacts,
  hubArtifactKey,
  hubArtifactsMarkdown,
  type HubArtifact,
  type HubPathRoots,
  type HubTurnFilter,
} from "~/lib/hubArtifacts";
import {
  applyHubOverlay,
  hubManualUpsert,
  type HubManualType,
  type HubSectionId,
} from "~/lib/hubOverlay";
import { randomUUID } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import { useEnvironmentProviders } from "~/state/environments";
import {
  useProjects,
  useThreadProjection,
  useThreadShell,
  useThreadShells,
  useThreadVisibleTurnItems,
} from "~/state/entities";
import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";

import { HUB_ADD_INVALID_MESSAGE, HubAddForm } from "./HubAddForm";
import { HubAgents } from "./HubAgents";
import { HubArtifactRow, type HubRowOverlayActions } from "./HubArtifactRow";
import { deriveHubAgents, type HubChildThread } from "./hubAgents.logic";
import { HubConnectors } from "./HubConnectors";
import { hubHarnessForDriver } from "./hubConnectors.logic";
import {
  HubDisclosure,
  HubGroupLabel,
  HubIconAction,
  HubIconTile,
  HubSection,
} from "./HubPrimitives";
import { HubTasks } from "./HubTasks";
import { jumpToTranscriptRow } from "./transcriptJump";

export interface HubPanelProps {
  threadRef: ScopedThreadRef;
  /** Opens a workspace path in the file surface. */
  onOpenFile: (relativePath: string) => void;
  /** Opens the Diff surface, where code edits are read; absent outside Git. */
  onOpenDiff?: (() => void) | undefined;
  /** Roots long absolute paths are displayed relative to. */
  pathRoots: HubPathRoots;
}

/**
 * Read lists are the only list that can run long. Capping keeps the DOM small
 * without dragging a virtualizer into a side panel; the markdown export is the
 * way out for the full set.
 */
const MAX_FILE_READ_ROWS = 200;
/** Code edits fold behind one disclosure above this many: Diff is where they are read. */
const CODE_ROWS_BEFORE_COLLAPSE = 4;

const EMPTY_ITEMS: never[] = [];

function notify(title: string, type: "success" | "error" = "success") {
  toastManager.add(stackedThreadToast({ type, title }));
}

async function copyText(value: string, what: string) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
    await navigator.clipboard.writeText(value);
    notify(`Copied ${what}`);
  } catch {
    notify(`Failed to copy ${what}`, "error");
  }
}

function childThreadOf(
  shell: ReturnType<typeof useThreadShells>[number],
): HubChildThread & { readonly source: OrchestrationV2ThreadShell } {
  return {
    id: shell.id,
    title: shell.title,
    providerInstanceId: shell.providerInstanceId,
    modelSelection: shell.modelSelection,
    lineage: shell.lineage,
    creationSource: shell.source.creationSource,
    createdAt: shell.createdAt,
    updatedAt: shell.updatedAt,
    archivedAt: shell.archivedAt,
    latestRun: shell.latestRun,
    source: shell.source,
  };
}

export function HubPanel({ threadRef, onOpenFile, onOpenDiff, pathRoots }: HubPanelProps) {
  const [turnFilter, setTurnFilter] = useState<HubTurnFilter>("all");
  const [fileReadsOpen, setFileReadsOpen] = useState(false);
  const [codeOpen, setCodeOpen] = useState(false);
  const [hiddenOpen, setHiddenOpen] = useState<Record<HubSectionId, boolean>>({
    outputs: false,
    sources: false,
  });
  const [adding, setAdding] = useState<HubSectionId | null>(null);
  const openLink = useOpenLink(threadRef);
  const openHubByDefault = useRightPanelStore((state) => state.openHubByDefault);
  const overlay = useThreadHubOverlay(threadRef);

  const shell = useThreadShell(threadRef);
  const projection = useThreadProjection(threadRef)?.projection ?? null;
  const visibleItems = useThreadVisibleTurnItems(threadRef);
  const allShells = useThreadShells();
  const providers = useEnvironmentProviders().get(threadRef.environmentId) ?? EMPTY_ITEMS;
  const allProjects = useProjects();
  const projects = allProjects.filter(
    (project) => project.environmentId === threadRef.environmentId,
  );

  // The thread's own items: a fork's inherited history belongs to its parent.
  const items =
    visibleItems.length === 0
      ? EMPTY_ITEMS
      : visibleItems.filter((row) => row.visibility !== "inherited").map((row) => row.item);
  const latestRunId = shell?.latestRun?.runId ?? null;
  const pullRequests = shell?.pullRequests;

  const derived = deriveHubArtifacts({ items, pullRequests: pullRequests ?? [] });
  const overlaid = applyHubOverlay(derived, overlay.entries);
  const model = buildHubModel(overlaid.visible, {
    turnFilter,
    latestRunId,
    hidden: overlaid.hidden,
  });

  const environmentShells = allShells
    .filter((candidate) => candidate.environmentId === threadRef.environmentId)
    .map(childThreadOf);
  const threadsById = new Map(
    environmentShells.map((thread) => [thread.id, thread.source] as const),
  );
  const agents = deriveHubAgents({
    threadId: threadRef.threadId,
    subagents: projection?.subagents ?? [],
    childThreads: environmentShells,
  });
  const parent = (() => {
    const lineage = shell?.lineage;
    if (!lineage?.parentThreadId || lineage.relationshipToParent !== "subagent") return null;
    const parentThreadId: ThreadId = lineage.parentThreadId;
    return {
      id: parentThreadId,
      title: threadsById.get(parentThreadId)?.title ?? "parent thread",
    };
  })();

  const runUserMessageIds = new Map(
    (projection?.runs ?? []).map((run) => [run.id, run.userMessageId] as const),
  );
  const instanceId = shell?.providerInstanceId ?? projection?.thread.providerInstanceId;
  const provider = providers.find((entry) => entry.instanceId === instanceId);
  const harness = hubHarnessForDriver(provider?.driver ?? instanceId);

  const openUrl = (url: string | undefined) => {
    if (!url) return;
    void openLink(url).catch(() => notify("Failed to open link", "error"));
  };
  const copy = (value: string, what: string) => void copyText(value, what);

  const jumpAction = (artifact: HubArtifact) => () => {
    const fallback = artifact.lastRunId ? runUserMessageIds.get(artifact.lastRunId) : undefined;
    if (!jumpToTranscriptRow(artifact.lastItemId, [fallback])) {
      notify(
        artifact.lastItemId
          ? "That step is not on screen. Scroll the chat to it and try again."
          : "This came from the thread's links, not a chat step.",
        "error",
      );
    }
  };

  // Overlay writes: the new state comes back through the subscription, so a
  // failure is the only thing to report here.
  const overlayAction = (write: () => Promise<boolean>, failure: string) => () => {
    void write().then((ok) => {
      if (!ok) notify(failure, "error");
    });
  };
  const rowOverlay = (artifact: HubArtifact, hidden: boolean): HubRowOverlayActions | undefined => {
    if (!overlay.available) return undefined;
    const remove = artifact.manual
      ? overlayAction(() => overlay.remove(artifact), "Failed to remove it")
      : undefined;
    if (hidden) {
      return {
        onUnhide: overlayAction(() => overlay.setHidden(artifact, false), "Failed to unhide it"),
        onRemove: remove,
      };
    }
    return {
      onTogglePin: overlayAction(
        () => overlay.setPinned(artifact, !artifact.pinned),
        artifact.pinned ? "Failed to unpin it" : "Failed to pin it",
      ),
      // A hand-added row is removed rather than hidden: hiding is for the
      // rows the thread derives, which would otherwise come straight back.
      onHide: artifact.manual
        ? undefined
        : overlayAction(() => overlay.setHidden(artifact, true), "Failed to hide it"),
      onRemove: remove,
    };
  };

  const renderRow = (artifact: HubArtifact, hidden = false) => (
    <HubArtifactRow
      key={hubArtifactKey(artifact)}
      artifact={artifact}
      copyText={copy}
      dimmed={hidden}
      onJump={artifact.lastItemId || artifact.lastRunId ? jumpAction(artifact) : undefined}
      onOpenFile={onOpenFile}
      openUrl={openUrl}
      overlay={rowOverlay(artifact, hidden)}
      pathRoots={pathRoots}
    />
  );

  const addManual = async (section: HubSectionId, type: HubManualType, value: string) => {
    const input = hubManualUpsert({
      threadId: threadRef.threadId,
      section,
      type,
      value,
      newId: randomUUID,
    });
    if (input === null) return HUB_ADD_INVALID_MESSAGE[type];
    // Adding what was hidden brings it back.
    return (await overlay.add({ ...input, hidden: false })) ? null : "Could not save it.";
  };
  const startAdding = (section: HubSectionId) => {
    setAdding(section);
    if (turnFilter === "current") setTurnFilter("all");
  };

  const copyMarkdown = () => {
    void copyText(
      hubArtifactsMarkdown(model, {
        threadTitle: shell?.title,
        turnFilter,
        agents: agents.map((agent) => ({ title: agent.title, status: agent.status })),
      }),
      "Hub as markdown",
    );
  };

  const { outputs, sources } = model;
  const showOutputs = outputs.total > 0 || outputs.hidden.length > 0 || adding === "outputs";
  const showSources = sources.total > 0 || sources.hidden.length > 0 || adding === "sources";
  const empty = !showOutputs && !showSources;
  const historyImported = projection?.thread.historyOrigin === "v1_import";
  // Group labels only earn their row when a card holds more than one kind.
  const outputGroups =
    outputs.files.length +
    [
      outputs.pinned,
      outputs.codeFiles,
      outputs.pullRequests,
      outputs.commits,
      outputs.links,
      outputs.previews,
      outputs.attachments,
      outputs.notes,
    ].filter((it) => it.length > 0).length;
  const sourceGroups = [
    sources.pinned,
    sources.links,
    sources.searches,
    sources.mcpServers,
    sources.skills,
    sources.fileReads,
    sources.notes,
  ].filter((it) => it.length > 0).length;
  const outputLabel = (label: string) =>
    outputGroups > 1 ? <HubGroupLabel>{label}</HubGroupLabel> : null;
  const sourceLabel = (label: string) =>
    sourceGroups > 1 ? <HubGroupLabel>{label}</HubGroupLabel> : null;
  const collapseCode = outputs.codeFiles.length > CODE_ROWS_BEFORE_COLLAPSE;

  const group = (label: ReactNode, artifacts: readonly HubArtifact[], key?: string) =>
    artifacts.length === 0 ? null : (
      <div key={key ?? (typeof label === "string" ? label : "")} className="flex flex-col gap-0.5">
        {label}
        {artifacts.map((artifact) => renderRow(artifact))}
      </div>
    );
  // Pinned always says so: it is why those rows sit above their kind.
  const pinnedGroup = (artifacts: readonly HubArtifact[]) =>
    group(<HubGroupLabel>Pinned</HubGroupLabel>, artifacts, "pinned");
  const hiddenGroup = (section: HubSectionId, artifacts: readonly HubArtifact[]) => {
    if (artifacts.length === 0) return null;
    const open = hiddenOpen[section];
    return (
      <div className="flex flex-col gap-0.5">
        <HubDisclosure
          onToggle={() => setHiddenOpen((current) => ({ ...current, [section]: !open }))}
          open={open}
        >
          {open ? `${artifacts.length} hidden` : `Show ${artifacts.length} hidden`}
        </HubDisclosure>
        {open ? artifacts.map((artifact) => renderRow(artifact, true)) : null}
      </div>
    );
  };
  const addForm = (section: HubSectionId) =>
    adding === section ? (
      <HubAddForm
        onCancel={() => setAdding(null)}
        onSubmit={(type, value) => addManual(section, type, value)}
        section={section}
      />
    ) : null;
  const addAction = (section: HubSectionId) =>
    overlay.available ? (
      <HubIconAction
        label={section === "outputs" ? "Add output" : "Add source"}
        onClick={() => startAdding(section)}
      >
        <PlusIcon className="size-3.5" />
      </HubIconAction>
    ) : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col" data-hub-panel>
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <ToggleGroup
          aria-label="Turn filter"
          className="shrink-0"
          onValueChange={(value) => {
            const next = value[0];
            if (next === "all" || next === "current") setTurnFilter(next);
          }}
          value={[turnFilter]}
          variant="segmented"
        >
          <Toggle aria-label="All turns" value="all">
            <span className="px-1 text-2xs">All turns</span>
          </Toggle>
          <Toggle aria-label="This turn" disabled={latestRunId === null} value="current">
            <span className="px-1 text-2xs">This turn</span>
          </Toggle>
        </ToggleGroup>
        <span className="flex-1" />
        <Menu>
          <MenuTrigger
            render={
              <Button aria-label="Hub actions" size="icon-xs" variant="ghost-muted">
                <MoreHorizontalIcon className="size-4" />
              </Button>
            }
          />
          <MenuPopup align="end">
            {overlay.available ? (
              <>
                <MenuItem onClick={() => startAdding("outputs")}>
                  <FolderOutputIcon />
                  Add output…
                </MenuItem>
                <MenuItem onClick={() => startAdding("sources")}>
                  <BookOpenIcon />
                  Add source…
                </MenuItem>
                <MenuSeparator />
              </>
            ) : null}
            <MenuItem onClick={copyMarkdown}>
              <CopyIcon />
              Copy as markdown
            </MenuItem>
            <MenuSeparator />
            <MenuCheckboxItem
              checked={openHubByDefault}
              onCheckedChange={(checked) =>
                useRightPanelStore.getState().setOpenHubByDefault(checked)
              }
              variant="switch"
            >
              Open Hub on new threads
            </MenuCheckboxItem>
          </MenuPopup>
        </Menu>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col px-3 pt-2 pb-6">
          <HubAgents
            agents={agents}
            environmentId={threadRef.environmentId}
            parent={parent}
            projects={projects}
            providers={providers}
            thread={shell?.source}
            threadsById={threadsById}
          />
          <HubTasks latestRunId={latestRunId} plans={projection?.plans ?? EMPTY_ITEMS} />

          {empty ? (
            <div className="flex flex-col items-center gap-3 px-6 py-8 text-center not-first:border-t not-first:border-border/60">
              <HubIconTile size="section">
                <BoxesIcon />
              </HubIconTile>
              <div className="flex flex-col gap-1">
                <p className="text-sm font-medium text-foreground">
                  {turnFilter === "current" && model.totalAllTurns > 0
                    ? "Nothing from this turn yet"
                    : "Nothing here yet"}
                </p>
                <p className="max-w-64 text-xs leading-relaxed text-muted-foreground">
                  {turnFilter === "current" && model.totalAllTurns > 0
                    ? "Switch to All turns to see everything this thread has produced."
                    : historyImported
                      ? "This thread was imported from an older P3 build, which kept only its messages. New work here collects as it happens."
                      : "Files the agent writes, pull requests, commits, previews, and the pages and tools it consults collect here."}
                </p>
              </div>
              {overlay.available ? (
                <div className="flex gap-1.5">
                  <Button onClick={() => startAdding("outputs")} size="micro" variant="outline">
                    <PlusIcon />
                    Add output
                  </Button>
                  <Button onClick={() => startAdding("sources")} size="micro" variant="outline">
                    <PlusIcon />
                    Add source
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}

          {showOutputs ? (
            <HubSection
              title="Outputs"
              icon={<FolderOutputIcon />}
              description="What this thread made: files it wrote, pull requests, commits, links, previews, attachments, and what you added."
              count={outputs.total}
              action={addAction("outputs")}
            >
              {addForm("outputs")}
              {pinnedGroup(outputs.pinned)}
              {group(outputLabel("Pull requests"), outputs.pullRequests, "pull-requests")}
              {group(outputLabel("Commits"), outputs.commits, "commits")}
              {outputs.files.map((fileGroup) =>
                group(outputLabel(fileGroup.label), fileGroup.artifacts, fileGroup.id),
              )}
              {outputs.codeFiles.length > 0 ? (
                <div className="flex flex-col gap-0.5">
                  <div className="flex items-center">
                    <span className="min-w-0 flex-1">
                      {collapseCode ? (
                        <HubDisclosure onToggle={() => setCodeOpen((it) => !it)} open={codeOpen}>
                          {outputs.codeFiles.length} code files edited
                        </HubDisclosure>
                      ) : (
                        outputLabel("Code")
                      )}
                    </span>
                    {onOpenDiff ? (
                      <Button
                        className="shrink-0"
                        onClick={onOpenDiff}
                        size="micro"
                        variant="ghost-muted"
                      >
                        <FileDiffIcon />
                        Diff
                      </Button>
                    ) : null}
                  </div>
                  {!collapseCode || codeOpen
                    ? outputs.codeFiles.map((artifact) => renderRow(artifact))
                    : null}
                </div>
              ) : null}
              {group(outputLabel("Links"), outputs.links, "links")}
              {group(outputLabel("Previews"), outputs.previews, "previews")}
              {group(outputLabel("Attachments"), outputs.attachments, "attachments")}
              {group(outputLabel("Notes"), outputs.notes, "notes")}
              {hiddenGroup("outputs", outputs.hidden)}
            </HubSection>
          ) : null}

          {showSources ? (
            <HubSection
              title="Sources"
              icon={<BookOpenIcon />}
              description="What the agent looked at to get there: pages, searches, MCP tools, skills, files it read, and what you added."
              count={sources.total}
              action={addAction("sources")}
            >
              {addForm("sources")}
              {pinnedGroup(sources.pinned)}
              {group(sourceLabel("Pages"), sources.links, "pages")}
              {group(sourceLabel("Searches"), sources.searches, "searches")}
              {sources.mcpServers.length > 0 ? (
                <div className="flex flex-col gap-0.5">
                  {sourceLabel("MCP tools")}
                  {sources.mcpServers.map((mcpGroup) => (
                    <div key={mcpGroup.server} className="flex gap-2.5 px-1 py-1.5">
                      <HubIconTile>
                        <WrenchIcon />
                      </HubIconTile>
                      <div className="flex min-w-0 flex-1 flex-col gap-1.5 pt-0.5">
                        <div className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                            {mcpGroup.server}
                          </span>
                          {mcpGroup.count > 1 ? (
                            <span className="text-3xs tabular-nums text-muted-foreground/60">
                              ×{mcpGroup.count}
                            </span>
                          ) : null}
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {mcpGroup.tools.map((entry) => (
                            <Tooltip key={entry.artifact.key}>
                              <TooltipTrigger
                                render={
                                  <button
                                    className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-3xs text-muted-foreground hover:bg-accent hover:text-foreground"
                                    onClick={jumpAction(entry.artifact)}
                                    type="button"
                                  >
                                    {entry.tool}
                                    {entry.count > 1 ? (
                                      <span className="ml-1 tabular-nums opacity-70">
                                        ×{entry.count}
                                      </span>
                                    ) : null}
                                  </button>
                                }
                              />
                              <TooltipPopup side="top">
                                {mcpGroup.server} · {entry.tool}: jump to where it ran
                              </TooltipPopup>
                            </Tooltip>
                          ))}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
              {group(sourceLabel("Skills"), sources.skills, "skills")}
              {sources.fileReads.length > 0 ? (
                <div className="flex flex-col gap-0.5">
                  <HubDisclosure
                    onToggle={() => setFileReadsOpen((it) => !it)}
                    open={fileReadsOpen}
                  >
                    {sources.fileReads.length} {sources.fileReads.length === 1 ? "file" : "files"}{" "}
                    read
                  </HubDisclosure>
                  {fileReadsOpen ? (
                    <>
                      {sources.fileReads
                        .slice(0, MAX_FILE_READ_ROWS)
                        .map((artifact) => renderRow(artifact))}
                      {sources.fileReads.length > MAX_FILE_READ_ROWS ? (
                        <p className="px-2 py-1 text-2xs text-muted-foreground/70">
                          Showing the {MAX_FILE_READ_ROWS} most recent of {sources.fileReads.length}
                          . Copy as markdown for the full list.
                        </p>
                      ) : null}
                    </>
                  ) : null}
                </div>
              ) : null}
              {group(sourceLabel("Notes"), sources.notes, "notes")}
              {hiddenGroup("sources", sources.hidden)}
            </HubSection>
          ) : null}

          <HubConnectors environmentId={threadRef.environmentId} harness={harness} items={items} />
        </div>
      </ScrollArea>
    </div>
  );
}
