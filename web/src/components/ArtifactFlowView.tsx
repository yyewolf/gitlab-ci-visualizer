import { useMemo, useCallback, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  type Node,
  type Edge as FlowEdge,
  type NodeMouseHandler,
  MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { Pipeline, Job, Edge } from "../types";
import ArtifactJobNode, { type ArtifactJobNodeData } from "./ArtifactJobNode";

interface Props {
  pipeline: Pipeline;
  selectedJob: Job | null;
  onSelectJob: (job: Job | null) => void;
  showDisabled: boolean;
}

const NODE_W = 208;
const NODE_H = 80;
const STAGE_GAP = 80;
const JOB_GAP = 12;
const STAGE_HEADER_H = 32;

const nodeTypes = { artifactJob: ArtifactJobNode };

export default function ArtifactFlowView({
  pipeline,
  selectedJob,
  onSelectJob,
  showDisabled,
}: Props) {
  const [hoveredJobName, setHoveredJobName] = useState<string | null>(null);

  const { baseNodes, baseFlowEdges, visibleArtifactEdges, visibleStages, visibleJobNames, inFlowSet } =
    useMemo(() => buildGraph(pipeline, showDisabled), [pipeline, showDisabled]);

  const hoveredJobEnabled = useMemo(() => {
    if (!hoveredJobName) return true;
    return pipeline.jobs.find((j) => j.name === hoveredJobName)?.enabled ?? true;
  }, [hoveredJobName, pipeline.jobs]);

  const ancestorPath = useMemo(() => {
    if (!hoveredJobName || !hoveredJobEnabled) return null;
    return computeAncestors(hoveredJobName, visibleArtifactEdges, visibleJobNames);
  }, [hoveredJobName, hoveredJobEnabled, visibleArtifactEdges, visibleJobNames]);

  const nodes: Node[] = useMemo(
    () =>
      baseNodes.map((n) => {
        const isHovering = hoveredJobName != null && hoveredJobEnabled;
        const onPath = ancestorPath?.jobs.has(n.id) ?? false;
        return {
          ...n,
          data: {
            ...(n.data as ArtifactJobNodeData),
            isSelected: n.id === selectedJob?.name,
            isHighlighted: n.id === hoveredJobName,
            isAncestor: onPath,
            // When hovering: dim everything not on the highlighted path.
            // When idle: dim jobs outside the artifact flow.
            isDimmed: isHovering
              ? n.id !== hoveredJobName && !onPath
              : !inFlowSet.has(n.id),
          } satisfies ArtifactJobNodeData,
        };
      }),
    [baseNodes, selectedJob, hoveredJobName, hoveredJobEnabled, ancestorPath, inFlowSet],
  );

  const edges: FlowEdge[] = useMemo(() => {
    const isHovering = hoveredJobName != null && hoveredJobEnabled;
    return baseFlowEdges.map((e) => {
      const onPath = ancestorPath?.edgeIds.has(e.id) ?? false;
      const color = onPath ? "#fbbf24" : "#d97706";
      return {
        ...e,
        animated: onPath,
        style: {
          ...e.style,
          stroke: color,
          strokeWidth: onPath ? 2 : e.style?.strokeWidth,
          opacity: isHovering && !onPath ? 0.08 : 1,
        },
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 12, height: 12 },
      };
    });
  }, [baseFlowEdges, hoveredJobName, hoveredJobEnabled, ancestorPath]);

  const onNodeClick: NodeMouseHandler = useCallback(
    (_, node) => {
      const job = pipeline.jobs.find((j) => j.name === node.id);
      onSelectJob(job ?? null);
    },
    [pipeline, onSelectJob],
  );
  const onNodeMouseEnter: NodeMouseHandler = useCallback((_, node) => setHoveredJobName(node.id), []);
  const onNodeMouseLeave: NodeMouseHandler = useCallback(() => setHoveredJobName(null), []);
  const onPaneClick = useCallback(() => onSelectJob(null), [onSelectJob]);

  if ((pipeline.artifact_edges ?? []).length === 0) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 gap-2 text-zinc-600">
        <p className="text-sm">No artifact flow detected</p>
        <p className="text-xs text-zinc-700">
          Add <code className="text-zinc-500">artifacts:</code> blocks to your jobs to see how data flows through the pipeline.
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 relative bg-zinc-950">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        onNodeMouseEnter={onNodeMouseEnter}
        onNodeMouseLeave={onNodeMouseLeave}
        onPaneClick={onPaneClick}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.2}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#27272a" gap={20} />
        <Controls className="!bg-zinc-900 !border-zinc-700 [&>button]:!bg-zinc-900 [&>button]:!border-zinc-700 [&>button]:!text-zinc-400 [&>button:hover]:!bg-zinc-800" />
      </ReactFlow>

      {visibleStages.length > 0 && (
        <StageLegend stages={visibleStages} jobs={baseNodes.map((n) => (n.data as ArtifactJobNodeData).job)} />
      )}

      <ArtifactLegend />
    </div>
  );
}

// ---- graph builder ----

function buildGraph(
  pipeline: Pipeline,
  showDisabled: boolean,
): {
  baseNodes: Node[];
  baseFlowEdges: FlowEdge[];
  visibleArtifactEdges: Edge[];
  visibleStages: string[];
  visibleJobNames: Set<string>;
  inFlowSet: Set<string>;
} {
  const visibleJobs = showDisabled ? pipeline.jobs : pipeline.jobs.filter((j) => j.enabled);
  const visibleJobNames = new Set(visibleJobs.map((j) => j.name));

  const visibleArtifactEdges = (pipeline.artifact_edges ?? []).filter(
    (e) => visibleJobNames.has(e.from) && visibleJobNames.has(e.to),
  );

  const producerSet = new Set(visibleJobs.filter((j) => j.artifacts != null).map((j) => j.name));
  const consumerSet = new Set(visibleArtifactEdges.map((e) => e.to));
  const inFlowSet = new Set([...producerSet, ...consumerSet]);

  const stagesWithJobs = new Set(visibleJobs.map((j) => j.stage));
  const visibleStages = pipeline.stages.filter((s) => stagesWithJobs.has(s));
  const stageIdx = new Map(visibleStages.map((s, i) => [s, i]));

  const jobStage = new Map(visibleJobs.map((j) => [j.name, j.stage]));

  const stageOrder = new Map<string, number>();
  {
    const counters = new Map<string, number>();
    for (const job of visibleJobs) {
      stageOrder.set(job.name, counters.get(job.stage) ?? 0);
      counters.set(job.stage, (counters.get(job.stage) ?? 0) + 1);
    }
  }

  const handleUsage = new Map(
    visibleJobs.map((j) => [j.name, { top: false, bottom: false, left: false, right: false, topSrc: false, bottomTgt: false }]),
  );
  for (const e of visibleArtifactEdges) {
    const sameStage = jobStage.get(e.from) === jobStage.get(e.to);
    const from = handleUsage.get(e.from);
    const to = handleUsage.get(e.to);
    if (sameStage) {
      const fromAbove = (stageOrder.get(e.from) ?? 0) < (stageOrder.get(e.to) ?? 0);
      if (fromAbove) {
        if (from) from.bottom = true;
        if (to) to.top = true;
      } else {
        if (from) from.topSrc = true;
        if (to) to.bottomTgt = true;
      }
    } else {
      if (from) from.right = true;
      if (to) to.left = true;
    }
  }

  const stageJobCounts = new Map<string, number>();
  const baseNodes: Node[] = visibleJobs.map((job) => {
    const si = stageIdx.get(job.stage) ?? 0;
    const count = stageJobCounts.get(job.stage) ?? 0;
    stageJobCounts.set(job.stage, count + 1);
    return {
      id: job.name,
      type: "artifactJob",
      position: {
        x: si * (NODE_W + STAGE_GAP),
        y: STAGE_HEADER_H + count * (NODE_H + JOB_GAP),
      },
      data: {
        job,
        isProducer: producerSet.has(job.name),
        inFlow: inFlowSet.has(job.name),
        isSelected: false,
        isHighlighted: false,
        isAncestor: false,
        isDimmed: !inFlowSet.has(job.name),
        activeHandles: handleUsage.get(job.name) ?? { top: false, bottom: false, left: false, right: false, topSrc: false, bottomTgt: false },
      } satisfies ArtifactJobNodeData,
    };
  });

  const baseFlowEdges: FlowEdge[] = visibleArtifactEdges.map((e) => {
    const sameStage = jobStage.get(e.from) === jobStage.get(e.to);
    const fromAbove = sameStage && (stageOrder.get(e.from) ?? 0) < (stageOrder.get(e.to) ?? 0);
    return {
      id: `art:${e.from}→${e.to}`,
      source: e.from,
      target: e.to,
      sourceHandle: sameStage ? (fromAbove ? "bottom" : "topSrc") : "right",
      targetHandle: sameStage ? (fromAbove ? "top" : "bottomTgt") : "left",
      type: "smoothstep",
      animated: false,
      style: { stroke: "#d97706", strokeWidth: 1.5 },
      markerEnd: { type: MarkerType.ArrowClosed, color: "#d97706", width: 12, height: 12 },
    };
  });

  return { baseNodes, baseFlowEdges, visibleArtifactEdges, visibleStages, visibleJobNames, inFlowSet };
}

// ---- ancestor BFS (same logic as PipelineGraph) ----

function computeAncestors(
  fromName: string,
  edges: Edge[],
  visibleJobNames: Set<string>,
): { jobs: Set<string>; edgeIds: Set<string> } {
  const revAdj = new Map<string, Array<{ source: string; edgeId: string }>>();
  for (const e of edges) {
    if (!visibleJobNames.has(e.from) || !visibleJobNames.has(e.to)) continue;
    const edgeId = `art:${e.from}→${e.to}`;
    const arr = revAdj.get(e.to) ?? [];
    arr.push({ source: e.from, edgeId });
    revAdj.set(e.to, arr);
  }

  const jobs = new Set<string>();
  const edgeIds = new Set<string>();
  const queue = [fromName];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const { source, edgeId } of revAdj.get(cur) ?? []) {
      edgeIds.add(edgeId);
      if (!jobs.has(source)) {
        jobs.add(source);
        queue.push(source);
      }
    }
  }
  return { jobs, edgeIds };
}

// ---- stage legend (same as PipelineGraph) ----

function StageLegend({ stages, jobs }: { stages: string[]; jobs: Job[] }) {
  const counts = new Map<string, number>();
  for (const j of jobs) counts.set(j.stage, (counts.get(j.stage) ?? 0) + 1);
  return (
    <div className="absolute top-2 left-1/2 -translate-x-1/2 flex gap-2 pointer-events-none z-10">
      {stages.map((s) => {
        const count = counts.get(s) ?? 0;
        return (
          <div key={s} className="bg-zinc-900/80 backdrop-blur border border-zinc-700 rounded px-2 py-1 text-center">
            <p className="text-[10px] font-mono text-zinc-300">{s}</p>
            <p className="text-[9px] text-zinc-600">{count} job{count !== 1 ? "s" : ""}</p>
          </div>
        );
      })}
    </div>
  );
}

function ArtifactLegend() {
  return (
    <div className="absolute bottom-10 right-4 flex flex-col gap-1.5 pointer-events-none z-10 bg-zinc-900/80 backdrop-blur border border-zinc-800 rounded px-3 py-2">
      <div className="flex items-center gap-2 text-[10px] text-zinc-400">
        <span className="text-amber-500 text-[11px]">▤</span>
        Produces artifacts
      </div>
      <div className="flex items-center gap-2 text-[10px] text-zinc-400">
        <svg width="20" height="8" className="flex-shrink-0">
          <line x1="0" y1="4" x2="14" y2="4" stroke="#d97706" strokeWidth="1.5" />
          <polygon points="14,1 20,4 14,7" fill="#d97706" />
        </svg>
        Artifact flow
      </div>
      <div className="flex items-center gap-2 text-[10px] text-zinc-500">
        <span className="w-5 h-2 rounded bg-zinc-700 opacity-30" />
        No artifact flow
      </div>
    </div>
  );
}
