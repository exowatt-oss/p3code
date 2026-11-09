import {
  AlarmClockIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotDashedIcon,
  ClockIcon,
  MessageCircleQuestionIcon,
  MessageSquareIcon,
  ShieldQuestionIcon,
  UserRoundIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

/** Status takes the single leading glyph; otherwise the harness identifies the row. */
export function ExowattSidebarCompactLead(props: {
  readonly status: {
    readonly label: string;
    readonly icon:
      | "working"
      | "waiting"
      | "approval"
      | "input"
      | "request"
      | "failed"
      | "woke"
      | "done"
      | null;
    readonly className: string;
  } | null;
  readonly harness: ReactNode;
  readonly planReady: boolean;
}) {
  const { status } = props;
  if (props.planReady) {
    return (
      <span
        role="img"
        aria-label="Plan Ready"
        className="inline-flex shrink-0 text-warning-foreground"
      >
        <MessageCircleQuestionIcon aria-hidden className="size-3.5" />
      </span>
    );
  }
  if (status === null) {
    return (
      <span className="inline-flex shrink-0">
        {props.harness ?? <MessageSquareIcon aria-hidden className="size-3.5" />}
      </span>
    );
  }
  const Icon =
    status.icon === "working"
      ? CircleDashedIcon
      : status.icon === "waiting"
        ? CircleDotDashedIcon
        : status.icon === "approval"
          ? ShieldQuestionIcon
          : status.icon === "input"
            ? MessageCircleQuestionIcon
            : status.icon === "request"
              ? UserRoundIcon
              : status.icon === "failed"
                ? CircleAlertIcon
                : status.icon === "woke"
                  ? AlarmClockIcon
                  : status.icon === "done"
                    ? CircleCheckIcon
                    : ClockIcon;
  return (
    <span
      role="img"
      aria-label={status.label}
      className={cn("inline-flex shrink-0", status.className)}
    >
      <Icon aria-hidden className="size-3.5" />
    </span>
  );
}
