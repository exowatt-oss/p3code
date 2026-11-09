import {
  type DraftId,
  deriveEffectiveComposerModelState,
  readEffectiveComposerModelState,
  useComposerDraftModelState,
  useComposerDraftStore,
} from "../../composerDraftStore";
import {
  type ModelSelection,
  type ProjectId,
  ProviderDriverKind,
  type ScopedThreadRef,
  type ServerProvider,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import {
  NO_PROVIDER_MODEL_SELECTION,
  providerInstanceEntriesFor,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { type UnifiedSettings } from "@t3tools/contracts/settings";
import { getComposerPromptInjectionState, getComposerProviderState } from "./composerProviderState";
import { resolveComposerProviderSelection } from "../ChatView.logic";

const NO_PROVIDER_MODELS: ServerProvider["models"] = [];

/**
 * The provider instances the composer offers, which one is selected, and the model and options
 * the draft resolves to on it. The draft store is read first so every derivation follows the only
 * hook here; in the composer body they would straddle its later hooks and lose their cache.
 */
export function useComposerProviderModel(
  input: Omit<Parameters<typeof resolveComposerProviderSelection>[0], "entries"> & {
    readonly providerStatuses: ReadonlyArray<ServerProvider>;
    readonly settings: UnifiedSettings;
    readonly activeProjectId: ProjectId | null;
    readonly threadRef: ScopedThreadRef | DraftId;
    readonly threadModelSelection: ModelSelection | null | undefined;
    readonly projectModelSelection: ModelSelection | null | undefined;
    readonly promptInjectionState: ReturnType<typeof getComposerPromptInjectionState>;
  },
) {
  const {
    providerStatuses,
    settings,
    activeProjectId,
    threadRef,
    threadModelSelection,
    projectModelSelection,
    promptInjectionState,
    candidateInstanceIds,
    lockedProvider,
    lockedInstanceId,
  } = input;
  const draftModelState = useComposerDraftModelState(threadRef);
  const providerInstanceEntries: ReadonlyArray<ProviderInstanceEntry> = providerInstanceEntriesFor(
    providerStatuses,
    settings,
    activeProjectId,
  );
  const selection = resolveComposerProviderSelection({
    entries: providerInstanceEntries,
    candidateInstanceIds,
    lockedProvider,
    lockedInstanceId,
  });
  const selectedInstanceId =
    selection.selectedProviderEntry?.instanceId ?? NO_PROVIDER_MODEL_SELECTION.instanceId;
  const selectedProvider: ProviderDriverKind =
    selection.selectedProviderEntry?.driverKind ?? selection.requestedDriverKind;
  const modelState = deriveEffectiveComposerModelState({
    draft: draftModelState,
    providers: providerStatuses,
    selectedProvider,
    selectedInstanceId,
    requestedInstanceId: selection.requestedInstanceId,
    threadModelSelection,
    projectModelSelection,
    settings,
  });
  const selectedProviderModels = selection.selectedProviderEntry?.models ?? NO_PROVIDER_MODELS;
  const composerProviderState = getComposerProviderState({
    provider: selectedProvider,
    model: modelState.selectedModel,
    models: selectedProviderModels,
    promptInjectionState,
    modelOptions: modelState.modelOptions?.[selectedInstanceId],
    planModeEnabled: settings.planModeEnabled,
  });
  // exowatt: read the model state from the draft store at send time so a model picked moments
  // before sending is the one dispatched (the render-time values can lag one commit behind).
  const readCurrentModelDispatchState = (prompt: string) => {
    const latestDraft = useComposerDraftStore.getState().getComposerDraft(threadRef);
    const latestInstanceId = latestDraft?.activeProvider ?? selectedInstanceId;
    const latestProviderEntry =
      providerInstanceEntries.find(
        (entry) => entry.instanceId === latestInstanceId && entry.enabled && entry.isAvailable,
      ) ?? selection.selectedProviderEntry;
    const latestProvider = latestProviderEntry?.driverKind ?? selectedProvider;
    const latestProviderModels = latestProviderEntry?.models ?? selectedProviderModels;
    const latestModelState = readEffectiveComposerModelState({
      threadRef,
      providers: providerStatuses,
      selectedProvider: latestProvider,
      selectedInstanceId: latestInstanceId,
      requestedInstanceId: selection.requestedInstanceId,
      threadModelSelection,
      projectModelSelection,
      settings,
    });
    const latestProviderState = getComposerProviderState({
      provider: latestProvider,
      model: latestModelState.selectedModel,
      models: latestProviderModels,
      promptInjectionState: getComposerPromptInjectionState(prompt),
      modelOptions: latestModelState.modelOptions?.[latestInstanceId],
      planModeEnabled: settings.planModeEnabled,
    });
    return {
      selectedPromptEffort: latestProviderState.promptEffort,
      selectedModelSelection: createModelSelection(
        latestInstanceId,
        latestModelState.selectedModel,
        latestProviderState.modelOptionsForDispatch,
      ),
      selectedProvider: latestProvider,
      selectedModel: latestModelState.selectedModel,
      selectedProviderModels: latestProviderModels,
    };
  };
  return {
    providerInstanceEntries,
    ...selection,
    selectedInstanceId,
    selectedProvider,
    selectedProviderModels,
    composerModelOptions: modelState.modelOptions,
    selectedModel: modelState.selectedModel,
    composerProviderState,
    readCurrentModelDispatchState,
  };
}
