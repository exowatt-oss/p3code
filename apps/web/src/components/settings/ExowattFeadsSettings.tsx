/**
 * Settings › Sharing & access › feads: token, server, default board and a Test button. The token
 * is write-only here: it goes to the server's secret store, and the status stream only says
 * whether one is set and who it resolves to.
 */
import { EXOWATT_FEADS_DEFAULT_BASE_URL, type ExowattFeadsStatus } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { LoaderIcon } from "lucide-react";
import { useState } from "react";

import { useCommitOnBlur } from "../../hooks/useCommitOnBlur";
import { useExowattFeadsStatus } from "../../hooks/useExowattFeads";
import { exowattFeadsEnvironment } from "../../state/exowattFeads";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

type TestOutcome =
  | { readonly kind: "ok"; readonly actor: string }
  | { readonly kind: "failed"; readonly error: string };

function describeCommandFailure(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  if (typeof error === "object" && error !== null && "reason" in error) {
    const reason = (error as { readonly reason?: unknown }).reason;
    if (typeof reason === "string" && reason.length > 0) return reason;
  }
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "The server refused the change.";
}

function describeTestError(error: string): string {
  switch (error) {
    case "not_configured":
      return "Add a token first.";
    case "not_identified":
      return "feads does not recognise this token.";
    default:
      return error.startsWith("http_")
        ? `feads answered ${error.slice(5)}.`
        : `Could not reach feads (${error}).`;
  }
}

function tokenStatusText(status: ExowattFeadsStatus): string {
  switch (status.tokenSource) {
    case "none":
      return "Not connected.";
    case "environment":
      return status.actor
        ? `Set by P3_FEADS_TOKEN on the server; feads knows it as ${status.actor}.`
        : "Set by P3_FEADS_TOKEN on the server; change it there.";
    case "settings":
      return status.actor
        ? `Stored on this server; feads knows it as ${status.actor}.`
        : "Stored on this server. Test the connection to see who feads thinks you are.";
  }
}

function TokenRow({
  status,
  disabled,
  onSave,
  onForget,
  busy,
  error,
}: {
  readonly status: ExowattFeadsStatus | null;
  readonly disabled: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onSave: (token: string) => void;
  readonly onForget: () => void;
}) {
  const [draft, setDraft] = useState("");
  const managedByEnvironment = status?.tokenSource === "environment";
  const canSave = !disabled && !busy && !managedByEnvironment && draft.trim().length > 0;
  const submit = () => {
    if (!canSave) return;
    const token = draft.trim();
    setDraft("");
    onSave(token);
  };
  return (
    <SettingsRow
      {...searchableSetting("feads-token")}
      description="The agent token feads issued you (starts with fdsa_). It is kept in this server's secret store and never sent back to the app."
      status={
        <span className={error ? "text-destructive-foreground" : undefined}>
          {error ?? (status ? tokenStatusText(status) : "Waiting for the server…")}
        </span>
      }
      control={
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <Input
            type="password"
            autoComplete="off"
            spellCheck={false}
            size="sm"
            font="mono"
            className="w-full sm:w-56"
            aria-label="feads agent token"
            placeholder={
              managedByEnvironment
                ? "Managed by P3_FEADS_TOKEN"
                : status?.configured
                  ? "Replace token…"
                  : "fdsa_…"
            }
            disabled={disabled || busy || managedByEnvironment}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submit();
              }
            }}
          />
          <Button size="sm" variant="outline" disabled={!canSave} onClick={submit}>
            {busy ? <LoaderIcon className="size-3.5 animate-spin" /> : null}
            Save
          </Button>
          {status?.tokenSource === "settings" ? (
            <Button
              size="sm"
              variant="ghost-muted"
              disabled={disabled || busy}
              onClick={onForget}
              aria-label="Forget the stored feads token"
            >
              Forget
            </Button>
          ) : null}
        </div>
      }
    />
  );
}

function ServerRow({
  status,
  disabled,
  onCommit,
}: {
  readonly status: ExowattFeadsStatus | null;
  readonly disabled: boolean;
  readonly onCommit: (baseUrl: string) => void;
}) {
  const value = status?.baseUrl ?? EXOWATT_FEADS_DEFAULT_BASE_URL;
  const field = useCommitOnBlur(value, onCommit);
  return (
    <SettingsRow
      {...searchableSetting("feads-server")}
      description="Where feads is hosted. Leave the default unless you run your own."
      resetAction={
        !disabled && value !== EXOWATT_FEADS_DEFAULT_BASE_URL ? (
          <SettingResetButton
            label="feads server"
            onClick={() => onCommit(EXOWATT_FEADS_DEFAULT_BASE_URL)}
          />
        ) : null
      }
      control={
        <Input
          {...field}
          type="url"
          inputMode="url"
          spellCheck={false}
          size="sm"
          font="mono"
          className="w-full sm:w-72"
          aria-label="feads server URL"
          placeholder={EXOWATT_FEADS_DEFAULT_BASE_URL}
          disabled={disabled}
        />
      }
    />
  );
}

function DefaultBoardRow({
  status,
  disabled,
  onCommit,
}: {
  readonly status: ExowattFeadsStatus | null;
  readonly disabled: boolean;
  readonly onCommit: (board: string) => void;
}) {
  const field = useCommitOnBlur(status?.defaultBoard ?? "", onCommit);
  return (
    <SettingsRow
      {...searchableSetting("feads-default-board")}
      description="Optional. The board id P3 Code opens and files into by default, for example forca. Empty lets feads route on its own."
      control={
        <Input
          {...field}
          spellCheck={false}
          size="sm"
          font="mono"
          className="w-full sm:w-40"
          aria-label="feads default board"
          placeholder="none"
          disabled={disabled}
        />
      }
    />
  );
}

function ConnectionRow({
  status,
  disabled,
  outcome,
  testing,
  onTest,
}: {
  readonly status: ExowattFeadsStatus | null;
  readonly disabled: boolean;
  readonly outcome: TestOutcome | null;
  readonly testing: boolean;
  readonly onTest: () => void;
}) {
  const statusText = (() => {
    if (testing) return "Asking feads…";
    if (outcome?.kind === "ok") return `feads knows this token as ${outcome.actor}.`;
    if (outcome?.kind === "failed") return describeTestError(outcome.error);
    if (status?.lastError) return describeTestError(status.lastError);
    return null;
  })();
  return (
    <SettingsRow
      {...searchableSetting("feads-connection")}
      description="Ask feads which actor this token belongs to."
      status={
        statusText ? (
          <span
            className={
              outcome?.kind === "failed" || (!outcome && status?.lastError)
                ? "text-destructive-foreground"
                : undefined
            }
          >
            {statusText}
          </span>
        ) : undefined
      }
      control={
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || testing || !status?.configured}
          onClick={onTest}
        >
          {testing ? <LoaderIcon className="size-3.5 animate-spin" /> : null}
          Test
        </Button>
      }
    />
  );
}

export function ExowattFeadsSettingsSection() {
  const { environmentId, status, error: subscriptionError } = useExowattFeadsStatus();
  const configure = useAtomCommand(exowattFeadsEnvironment.configure, { reportFailure: false });
  const clear = useAtomCommand(exowattFeadsEnvironment.clear, { reportFailure: false });
  const test = useAtomCommand(exowattFeadsEnvironment.test, { reportFailure: false });

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<TestOutcome | null>(null);

  // No server, or a server that predates this integration: everything is read-only.
  const disabled = environmentId === null || subscriptionError !== null;

  const runTest = async () => {
    if (environmentId === null) return;
    setTesting(true);
    const result = await test({ environmentId, input: {} });
    setTesting(false);
    if (result._tag === "Success") {
      setOutcome(
        result.value.ok && result.value.actor
          ? { kind: "ok", actor: result.value.actor }
          : { kind: "failed", error: result.value.error ?? "unknown" },
      );
    } else if (result._tag === "Failure") {
      setOutcome({ kind: "failed", error: describeCommandFailure(result.cause) });
    }
  };

  const applyConfigure = async (
    input: Parameters<typeof configure>[0]["input"],
    options?: { readonly testAfter?: boolean },
  ) => {
    if (environmentId === null) return;
    setSaving(true);
    setFormError(null);
    const result = await configure({ environmentId, input });
    setSaving(false);
    if (result._tag === "Failure") {
      setFormError(describeCommandFailure(result.cause));
      return;
    }
    setOutcome(null);
    if (options?.testAfter) await runTest();
  };

  const forget = async () => {
    if (environmentId === null) return;
    setSaving(true);
    setFormError(null);
    const result = await clear({ environmentId, input: {} });
    setSaving(false);
    setOutcome(null);
    if (result._tag === "Failure") setFormError(describeCommandFailure(result.cause));
  };

  return (
    <SettingsSection id="feads" title="feads">
      {subscriptionError !== null ? (
        <p className="px-3 text-sm leading-normal text-muted-foreground/80 sm:px-4">
          This server does not have the feads integration yet. Update it to connect.
        </p>
      ) : null}
      <TokenRow
        status={status}
        disabled={disabled}
        busy={saving}
        error={formError}
        onSave={(token) => void applyConfigure({ token }, { testAfter: true })}
        onForget={() => void forget()}
      />
      <ServerRow
        status={status}
        disabled={disabled || saving}
        onCommit={(baseUrl) => void applyConfigure({ baseUrl })}
      />
      <DefaultBoardRow
        status={status}
        disabled={disabled || saving}
        onCommit={(board) => void applyConfigure({ defaultBoard: board })}
      />
      <ConnectionRow
        status={status}
        disabled={disabled || saving}
        outcome={outcome}
        testing={testing}
        onTest={() => void runTest()}
      />
    </SettingsSection>
  );
}
