import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { Job } from "../types";

export type ArtifactJobNodeData = {
  job: Job;
  isProducer: boolean;
  inFlow: boolean;
  isSelected: boolean;
  isHighlighted: boolean;
  isAncestor: boolean;
  isDimmed: boolean;
  activeHandles: { top: boolean; bottom: boolean; left: boolean; right: boolean; topSrc: boolean; bottomTgt: boolean };
};

function ArtifactJobNode({ data }: NodeProps) {
  const { job, isProducer, isSelected, isHighlighted, isAncestor, isDimmed, activeHandles } =
    data as ArtifactJobNodeData;

  let ring: string;
  let shadow = "";
  if (isHighlighted) {
    ring = "ring-2 ring-amber-400";
    shadow = "shadow-[0_0_14px_rgba(251,191,36,0.45)]";
  } else if (isAncestor) {
    ring = "ring-2 ring-amber-500";
    shadow = "shadow-[0_0_10px_rgba(245,158,11,0.35)]";
  } else if (isSelected) {
    ring = "ring-2 ring-blue-500";
  } else if (isProducer) {
    ring = "ring-1 ring-amber-800 hover:ring-amber-600";
  } else {
    ring = "ring-1 ring-zinc-700 hover:ring-zinc-500";
  }

  const dimClass = isDimmed ? "opacity-15" : job.enabled ? "" : "opacity-40";
  const summary = isProducer ? artifactSummary(job) : null;

  return (
    <div className="relative">
      <div
        className={`bg-zinc-900 rounded-lg px-3 py-2 w-52 cursor-pointer transition-all ${ring} ${shadow} ${dimClass}`}
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
          <Handle type="target" id="left" position={Position.Left}
            className="!bg-zinc-600 !w-2 !h-2 !border-0" />
        )}

        <div className="flex items-start gap-2">
          <span className={`mt-1 flex-shrink-0 w-2 h-2 rounded-full ${job.enabled ? "bg-emerald-500" : "bg-zinc-600"}`} />
          <span className="text-xs font-medium text-zinc-100 leading-tight break-all">
            {job.name}
          </span>
          {isProducer && (
            <span
              className="ml-auto flex-shrink-0 text-[10px] text-amber-500"
              title="Produces artifacts"
            >
              ▤
            </span>
          )}
        </div>

        {summary && (
          <p className="text-[9px] text-amber-700 ml-4 mt-0.5 truncate">{summary}</p>
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
    </div>
  );
}

function artifactSummary(job: Job): string {
  const a = job.artifacts;
  if (!a) return "";
  const parts: string[] = [];
  if (a.paths?.length) {
    parts.push(a.paths.length === 1 ? a.paths[0] : `${a.paths.length} paths`);
  }
  if (a.reports) {
    const types = Object.keys(a.reports);
    if (types.length <= 2) parts.push(...types.map((t) => `${t} report`));
    else parts.push(`${types.length} reports`);
  }
  return parts.join(" · ");
}

export default memo(ArtifactJobNode);
