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
import JobNode, { type JobNodeData } from "./JobNode";
import StageBandNode, { type StageBandData } from "./StageBandNode";

interface Props {
  pipeline: Pipeline;
  selectedJob: Job | null;
  onSelectJob: (job: Job | null) => void;
  showStageEdges: boolean;
  showDisabled: boolean;
}

const NODE_W = 208;
const NODE_H = 96; // fixed job-node height — JobNode renders at this height (h-24)
const STAGE_GAP = 80;
const JOB_GAP = 16;
const STAGE_HEADER_H = 32;
const STAGE_TOP_PAD = 20; // gap between the stage-name header and the first job

const nodeTypes = { job: JobNode, stageBand: StageBandNode };

export default function PipelineGraph({
  pipeline,
  selectedJob,
  onSelectJob,
  showStageEdges,
  showDisabled,
}: Props) {
  const [hoveredJobName, setHoveredJobName] = useState<string | null>(null);

  // Stable structure: positions, isInstant, visible sets
  const { baseNodes, stageNodes, baseFlowEdges, allVisibleEdges, visibleJobNames } =
    useMemo(
      () => buildGraph(pipeline, showStageEdges, showDisabled),
      [pipeline, showStageEdges, showDisabled],
    );

  // Disabled jobs suppress path highlighting and dimming when hovered.
  const hoveredJobEnabled = useMemo(() => {
    if (!hoveredJobName) return true;
    return pipeline.jobs.find((j) => j.name === hoveredJobName)?.enabled ?? true;
  }, [hoveredJobName, pipeline.jobs]);

  // Ancestor path uses ALL edges (stage + needs) so hovering a job shows its full
  // upstream chain even when stage edges aren't drawn.
  const ancestorPath = useMemo(() => {
    if (!hoveredJobName || !hoveredJobEnabled) return null;
    return computeAncestors(hoveredJobName, allVisibleEdges, visibleJobNames);
  }, [hoveredJobName, hoveredJobEnabled, allVisibleEdges, visibleJobNames]);

  // Merge hover/selection state into nodes. Stage band nodes are prepended
  // (and carry zIndex: -1) so they render behind the job nodes.
  const nodes: Node[] = useMemo(
    () =>
      stageNodes.concat(
      baseNodes.map((n) => ({
        ...n,
        data: {
          ...(n.data as JobNodeData),
          isSelected: n.id === selectedJob?.name,
          isHighlighted: n.id === hoveredJobName,
          isAncestor: ancestorPath?.jobs.has(n.id) ?? false,
          isDimmed:
            hoveredJobName != null &&
            hoveredJobEnabled &&
            n.id !== hoveredJobName &&
            !(ancestorPath?.jobs.has(n.id)),
        } satisfies JobNodeData,
      })),
      ),
    [stageNodes, baseNodes, selectedJob, hoveredJobName, hoveredJobEnabled, ancestorPath],
  );

  // Merge path highlighting into edges
  const edges: FlowEdge[] = useMemo(() => {
    const isHovering = hoveredJobName != null && hoveredJobEnabled;
    return baseFlowEdges.map((e) => {
      const onPath = ancestorPath?.edgeIds.has(e.id) ?? false;
      return {
        ...e,
        animated: onPath || e.animated,
        style: {
          ...e.style,
          stroke: onPath ? "#f59e0b" : e.style?.stroke,
          strokeWidth: onPath ? 2 : e.style?.strokeWidth,
          opacity: isHovering && !onPath ? 0.08 : 1,
        },
        markerEnd: onPath
          ? { type: MarkerType.ArrowClosed, color: "#f59e0b", width: 12, height: 12 }
          : e.markerEnd,
      };
    });
  }, [baseFlowEdges, hoveredJobName, ancestorPath]);

  const onNodeClick: NodeMouseHandler = useCallback(
    (_, node) => {
      const job = pipeline.jobs.find((j) => j.name === node.id);
      onSelectJob(job ?? null);
    },
    [pipeline, onSelectJob],
  );

  const onNodeMouseEnter: NodeMouseHandler = useCallback((_, node) => {
    setHoveredJobName(node.id);
  }, []);

  const onNodeMouseLeave: NodeMouseHandler = useCallback(() => {
    setHoveredJobName(null);
  }, []);

  const onPaneClick = useCallback(() => onSelectJob(null), [onSelectJob]);

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
    </div>
  );
}

// ---- graph builder (stable: no hover/selection state) ----

function buildGraph(
  pipeline: Pipeline,
  showStageEdges: boolean,
  showDisabled: boolean,
): {
  baseNodes: Node[];
  stageNodes: Node[];
  baseFlowEdges: FlowEdge[];
  allVisibleEdges: Edge[];
  visibleStages: string[];
  visibleJobNames: Set<string>;
} {
  const visibleJobs = showDisabled ? pipeline.jobs : pipeline.jobs.filter((j) => j.enabled);
  const visibleJobNames = new Set(visibleJobs.map((j) => j.name));

  const stagesWithJobs = new Set(visibleJobs.map((j) => j.stage));
  const visibleStages = pipeline.stages.filter((s) => stagesWithJobs.has(s));
  const stageIdx = new Map(visibleStages.map((s, i) => [s, i]));

  // All edges between visible jobs, used for ancestor path computation regardless
  // of whether stage edges are currently drawn.
  const allVisibleEdges = pipeline.edges.filter(
    (e) => visibleJobNames.has(e.from) && visibleJobNames.has(e.to),
  );

  // Edges that are actually drawn (respects showStageEdges)
  const drawnEdges = pipeline.edges.filter(
    (e) =>
      visibleJobNames.has(e.from) &&
      visibleJobNames.has(e.to) &&
      (showStageEdges || e.type === "needs"),
  );

  // "Instant" = no incoming edges across ALL visible edges (not just drawn ones)
  const hasIncoming = new Set(allVisibleEdges.map((e) => e.to));

  const jobStage = new Map(visibleJobs.map((j) => [j.name, j.stage]));

  // Index of each job within its stage column (determines visual top-to-bottom order).
  const stageOrder = new Map<string, number>();
  {
    const counters = new Map<string, number>();
    for (const job of visibleJobs) {
      stageOrder.set(job.name, counters.get(job.stage) ?? 0);
      counters.set(job.stage, (counters.get(job.stage) ?? 0) + 1);
    }
  }

  const handleUsage = new Map(
    visibleJobs.map((j) => [j.name, { top: false, bottom: false, left: false, right: false, topSrc: false, bottomTgt: false }])
  );
  for (const e of drawnEdges) {
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
      type: "job",
      position: {
        x: si * (NODE_W + STAGE_GAP),
        y: STAGE_HEADER_H + STAGE_TOP_PAD + count * (NODE_H + JOB_GAP),
      },
      data: {
        job,
        isInstant: !hasIncoming.has(job.name),
        activeHandles: handleUsage.get(job.name) ?? { top: false, bottom: false, left: false, right: false, topSrc: false, bottomTgt: false },
        // hover/selection fields filled in merge step
        isSelected: false,
        isHighlighted: false,
        isAncestor: false,
        isDimmed: false,
      } satisfies JobNodeData,
    };
  });

  // Stage band background nodes: one tall column per visible stage, tiled
  // edge-to-edge so their left borders form the vertical boundaries between
  // stages. Drawn behind jobs and non-interactive.
  const maxJobsInStage = Math.max(
    1,
    ...visibleStages.map((s) =>
      visibleJobs.reduce((n, j) => (j.stage === s ? n + 1 : n), 0),
    ),
  );
  const bandHeight =
    STAGE_HEADER_H + STAGE_TOP_PAD + maxJobsInStage * (NODE_H + JOB_GAP);
  const bandWidth = NODE_W + STAGE_GAP;
  const stageNodes: Node[] = visibleStages.map((stage, i) => ({
    id: `__stage__${stage}`,
    type: "stageBand",
    position: { x: i * (NODE_W + STAGE_GAP) - STAGE_GAP / 2, y: 0 },
    width: bandWidth,
    height: bandHeight,
    draggable: false,
    selectable: false,
    focusable: false,
    zIndex: -1,
    className: "pointer-events-none",
    style: { width: bandWidth, height: bandHeight },
    data: {
      label: stage,
      count: stageJobCounts.get(stage) ?? 0,
      index: i,
      isLast: i === visibleStages.length - 1,
    } satisfies StageBandData,
  }));

  const baseFlowEdges: FlowEdge[] = drawnEdges.map((e) => {
    const sameStage = jobStage.get(e.from) === jobStage.get(e.to);
    const fromAbove = sameStage && (stageOrder.get(e.from) ?? 0) < (stageOrder.get(e.to) ?? 0);
    return {
      id: `${e.from}→${e.to}`,
      source: e.from,
      target: e.to,
      sourceHandle: sameStage ? (fromAbove ? "bottom" : "topSrc") : "right",
      targetHandle: sameStage ? (fromAbove ? "top" : "bottomTgt") : "left",
      type: "smoothstep",
      animated: false,
      style: {
        stroke: e.type === "needs" ? "#60a5fa" : "#3f3f46",
        strokeWidth: e.type === "needs" ? 2 : 1,
        strokeDasharray: e.type === "stage" ? "4 4" : undefined,
      },
      markerEnd:
        e.type === "needs"
          ? { type: MarkerType.ArrowClosed, color: "#60a5fa", width: 12, height: 12 }
          : undefined,
    };
  });

  return { baseNodes, stageNodes, baseFlowEdges, allVisibleEdges, visibleStages, visibleJobNames };
}

// ---- ancestor BFS ----

function computeAncestors(
  fromName: string,
  edges: Edge[],
  visibleJobNames: Set<string>,
): { jobs: Set<string>; edgeIds: Set<string> } {
  // Reverse adjacency: target → [{source, edgeId}]
  const revAdj = new Map<string, Array<{ source: string; edgeId: string }>>();
  for (const e of edges) {
    if (!visibleJobNames.has(e.from) || !visibleJobNames.has(e.to)) continue;
    const edgeId = `${e.from}→${e.to}`;
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
