import { memo } from "react";
import type { NodeProps } from "@xyflow/react";

export type StageBandData = {
  label: string;
  count: number;
  index: number;
  isLast: boolean;
};

// A full-height background band spanning one stage column. The left edge draws
// the vertical boundary between stages; the stage name sits in a header at the
// top. Rendered behind job nodes and non-interactive (clicks pass through).
function StageBandNode({ data }: NodeProps) {
  const { label, count, index, isLast } = data as StageBandData;

  // Alternating tint helps the eye separate adjacent columns.
  const tint = index % 2 === 0 ? "bg-zinc-50/[0.015]" : "bg-zinc-50/[0.04]";

  return (
    <div
      className={`pointer-events-none h-full w-full border-l border-zinc-700/60 ${
        isLast ? "border-r" : ""
      } ${tint}`}
    >
      <div className="flex h-8 items-center justify-center border-b border-zinc-800/70">
        <span className="font-mono text-[11px] uppercase tracking-wide text-zinc-400">
          {label}
        </span>
        <span className="ml-1.5 text-[10px] text-zinc-600">{count}</span>
      </div>
    </div>
  );
}

export default memo(StageBandNode);
