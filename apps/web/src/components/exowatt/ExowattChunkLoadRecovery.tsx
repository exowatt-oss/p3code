import { Button } from "../ui/button";

const CHUNK_LOAD_ERROR_PATTERNS = [
  /ChunkLoadError/i,
  /Loading chunk [\w-]+ failed/i,
  /Failed to fetch dynamically imported module/i,
  /Importing a module script failed/i,
  /error loading dynamically imported module/i,
];

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const cause = "cause" in error ? error.cause : undefined;
    return `${error.name}\n${error.message}\n${error.stack ?? ""}\n${errorText(cause)}`;
  }
  return typeof error === "string" ? error : "";
}

export function isChunkLoadError(error: unknown): boolean {
  const text = errorText(error);
  return CHUNK_LOAD_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

export async function restartAfterChunkLoadFailure(input: {
  readonly restartApplication?: () => Promise<void>;
  readonly reload: () => void;
}): Promise<void> {
  if (!input.restartApplication) {
    input.reload();
    return;
  }

  try {
    await input.restartApplication();
  } catch {
    input.reload();
  }
}

export function ExowattChunkLoadRecovery() {
  const restart = () => {
    const restartApplication = window.desktopBridge?.restartApplication;
    void restartAfterChunkLoadFailure({
      ...(restartApplication ? { restartApplication } : {}),
      reload: () => window.location.reload(),
    });
  };

  return (
    <div
      role="alert"
      className="fixed inset-x-0 top-0 z-50 flex items-center justify-center gap-3 border-b border-border bg-background/95 px-4 py-3 text-sm text-foreground shadow-lg backdrop-blur"
    >
      <span>P3 was updated. Restart to continue.</span>
      <Button size="sm" onClick={restart}>
        Restart P3
      </Button>
    </div>
  );
}
