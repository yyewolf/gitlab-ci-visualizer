import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { Job } from "../types";

export type JobNodeData = {
  job: Job;
  isSelected: boolean;
  isHighlighted: boolean; // hovered
  isAncestor: boolean;    // in the upstream path of the hovered job
  isDimmed: boolean;      // unrelated to current hover
  isInstant: boolean;     // no incoming edges, starts immediately
  activeHandles: { top: boolean; bottom: boolean; left: boolean; right: boolean; topSrc: boolean; bottomTgt: boolean };
};

const whenDot: Record<string, string> = {
  on_success: "bg-emerald-500",
  always: "bg-blue-500",
  manual: "bg-amber-500",
  delayed: "bg-amber-400",
  on_failure: "bg-orange-500",
  never: "bg-zinc-500",
};

const whenLabel: Record<string, string> = {
  on_success: "auto",
  always: "always",
  manual: "manual",
  delayed: "delayed",
  on_failure: "on fail",
  never: "never",
};

function JobNode({ data }: NodeProps) {
  const { job, isSelected, isHighlighted, isAncestor, isDimmed, isInstant, activeHandles } =
    data as JobNodeData;

  const dot = job.enabled ? whenDot[job.when] ?? "bg-emerald-500" : "bg-zinc-600";

  let ring: string;
  let shadow = "";
  if (isHighlighted) {
    ring = "ring-2 ring-blue-400";
    shadow = "shadow-[0_0_14px_rgba(96,165,250,0.45)]";
  } else if (isAncestor) {
    ring = "ring-2 ring-amber-400";
    shadow = "shadow-[0_0_10px_rgba(251,191,36,0.35)]";
  } else if (isSelected) {
    ring = "ring-2 ring-blue-500";
  } else {
    ring = "ring-1 ring-zinc-700 hover:ring-zinc-500";
  }

  const dimClass = isDimmed ? "opacity-20" : job.enabled ? "" : "opacity-50";
  const showTooltip = isHighlighted && isInstant && job.enabled;

  return (
    // overflow-visible so the instant tooltip can escape the node box
    <div className="relative overflow-visible">
      {/* Fixed size (w-52 × h-24 ≈ NODE_W × NODE_H) so nodes never overlap;
          overflow-hidden clips any content that doesn't fit. */}
      <div
        className={`bg-zinc-900 rounded-lg px-3 py-2 w-52 h-24 flex flex-col overflow-hidden cursor-pointer transition-all ${ring} ${shadow} ${dimClass}`}
      >
        {activeHandles.top && (
          <Handle type="target" id="top" position={Position.Top}
            className="!bg-zinc-600 !w-2 !h-2 !border-0" />
        )}
        {activeHandles.topSrc && (
          <Handle type="source" id="topSrc" position={Position.Top}
            className="!bg-zinc-600 !w-2 !h-2 !border-0" />
        )}
        {activeHandles.left && (
          <Handle
            type="target"
            id="left"
            position={Position.Left}
            className="!bg-zinc-600 !w-2 !h-2 !border-0"
          />
        )}

        {/* header */}
        <div className="flex items-start gap-2">
          <span className={`mt-1 flex-shrink-0 w-2 h-2 rounded-full ${dot}`} />
          <span
            className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-100 leading-tight"
            title={job.name}
          >
            {job.name}
          </span>
          {isInstant && (
            <span className="ml-auto flex-shrink-0 text-[10px] text-sky-500" title="Starts immediately, no prerequisites">
              ⚡
            </span>
          )}
        </div>

        {/* badges row */}
        <div className="flex flex-wrap gap-1 mt-1.5 ml-4">
          {job.when !== "on_success" && (
            <Badge color="zinc">{whenLabel[job.when] ?? job.when}</Badge>
          )}
          {job.allow_failure && <Badge color="amber">allow fail</Badge>}
          {job.artifacts && <Badge color="sky">artifacts</Badge>}
          {job.parallel_count != null && job.parallel_count > 0 && (
            <Badge color="violet">
              {job.matrix_instances?.length
                ? `matrix×${job.matrix_instances.length}`
                : `×${job.parallel_count}`}
            </Badge>
          )}
          {job.resource_group && <Badge color="orange">group</Badge>}
          {job.environment && <Badge color="teal">env</Badge>}
          {job.tags && job.tags.length > 0 && (
            <Badge color="zinc">{job.tags[0]}</Badge>
          )}
          {job.interruptible && <Badge color="fuchsia">interruptible</Badge>}
          {job.retry != null && job.retry > 0 && <Badge color="rose">retry:{job.retry}</Badge>}
          {job.release && <Badge color="emerald">release</Badge>}
          {job.coverage && <Badge color="indigo">coverage</Badge>}
          {job.pages && <Badge color="cyan">pages</Badge>}
          {job.trigger && <Badge color="orange">trigger →</Badge>}
        </div>

        {/* image */}
        {job.image && (
          <p className="text-[10px] text-zinc-500 ml-4 mt-0.5 truncate">{job.image}</p>
        )}

        {activeHandles.right && (
          <Handle type="source" id="right" position={Position.Right}
            className="!bg-zinc-600 !w-2 !h-2 !border-0" />
        )}
        {activeHandles.bottom && (
          <Handle type="source" id="bottom" position={Position.Bottom}
            className="!bg-zinc-600 !w-2 !h-2 !border-0" />
        )}
        {activeHandles.bottomTgt && (
          <Handle type="target" id="bottomTgt" position={Position.Bottom}
            className="!bg-zinc-600 !w-2 !h-2 !border-0" />
        )}
      </div>

      {/* instant tooltip, shown below the node when hovered */}
      {showTooltip && (
        <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 z-50 pointer-events-none">
          <div className="bg-sky-950 border border-sky-800 rounded px-2.5 py-1.5 text-[11px] text-sky-300 whitespace-nowrap shadow-lg">
            ⚡ Scheduled instantly
          </div>
          {/* arrow */}
          <div className="absolute -top-1.5 left-1/2 -translate-x-1/2 w-2.5 h-2.5 bg-sky-950 border-l border-t border-sky-800 rotate-45" />
        </div>
      )}
    </div>
  );
}

function Badge({ children, color }: { children: React.ReactNode; color: string }) {
  const colors: Record<string, string> = {
    zinc: "bg-zinc-700 text-zinc-300",
    sky: "bg-sky-900 text-sky-300",
    amber: "bg-amber-900 text-amber-300",
    violet: "bg-violet-900 text-violet-300",
    orange: "bg-orange-900 text-orange-300",
    teal: "bg-teal-900 text-teal-300",
    fuchsia: "bg-fuchsia-900 text-fuchsia-300",
    rose: "bg-rose-900 text-rose-300",
    emerald: "bg-emerald-900 text-emerald-300",
    indigo: "bg-indigo-900 text-indigo-300",
    cyan: "bg-cyan-900 text-cyan-300",
  };
  return (
    <span className={`text-[9px] px-1 py-0.5 rounded ${colors[color] ?? colors.zinc}`}>
      {children}
    </span>
  );
}

export default memo(JobNode);
