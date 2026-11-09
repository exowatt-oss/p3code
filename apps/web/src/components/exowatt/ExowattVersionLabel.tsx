export interface ExowattVersionLabelPresentation {
  readonly compactLabel: string;
  readonly t3VersionLabel: string;
  readonly p3VersionLabel: string;
  readonly copyText: string;
}

const normalizeVersion = (version: string): string => version.trim().replace(/^v/u, "");

const fullVersionLabel = (product: "t3code" | "P3 Code", version: string): string =>
  version === "dev" ? `${product} dev` : `${product} v${version}`;

export function formatExowattVersionLabel(
  appVersion: string,
  isDevelopment: boolean,
  gitSha = "",
): ExowattVersionLabelPresentation {
  const normalizedAppVersion = normalizeVersion(appVersion) || "dev";
  const upstreamVersion = /^(\d+\.\d+\.\d+)/u.exec(normalizedAppVersion)?.[1] ?? "dev";
  const p3Version = isDevelopment ? "dev" : normalizedAppVersion;
  const compactP3Version = p3Version.startsWith(`${upstreamVersion}-`)
    ? p3Version.slice(upstreamVersion.length + 1)
    : p3Version;
  // Show the current checkout commit on development builds for identification.
  const shortSha = isDevelopment ? gitSha.trim().slice(0, 7) : "";
  const shaSuffix = shortSha ? `·${shortSha}` : "";
  const t3VersionLabel = fullVersionLabel("t3code", upstreamVersion);
  const p3VersionLabel = `${fullVersionLabel("P3 Code", p3Version)}${shortSha ? ` @ ${shortSha}` : ""}`;

  return {
    compactLabel: `T3 ${upstreamVersion} · P3 ${compactP3Version}${shaSuffix}`,
    t3VersionLabel,
    p3VersionLabel,
    copyText: `${t3VersionLabel}\n${p3VersionLabel}`,
  };
}

export function ExowattDevBuildPill() {
  return (
    <span
      className="inline-flex h-4 shrink-0 items-center rounded-full border border-primary/40 bg-primary/15 px-1.5 text-4xs font-semibold uppercase leading-none tracking-wider text-primary"
      data-exowatt-dev-pill
    >
      Dev
    </span>
  );
}
