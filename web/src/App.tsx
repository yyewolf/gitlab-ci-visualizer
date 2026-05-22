import { useState, useCallback, useEffect } from "react";
import type { Pipeline, Job, ConditionState, PipelineInput } from "./types";
import ConditionPanel from "./components/ConditionPanel";
import PipelineGraph from "./components/PipelineGraph";
import JobDetails from "./components/JobDetails";

const EMPTY_PIPELINE: Pipeline = { stages: [], jobs: [], edges: [] };

const DEFAULT_STATE: ConditionState = {
  yaml: "",
  pipelineSource: "push",
  branch: "main",
  tag: "",
  extraVars: [],
};

export default function App() {
  const [conditions, setConditions] = useState<ConditionState>(DEFAULT_STATE);
  const [pipeline, setPipeline] = useState<Pipeline>(EMPTY_PIPELINE);
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showStageEdges, setShowStageEdges] = useState(true);
  const [showDisabled, setShowDisabled] = useState(false);

  // VSCode extension integration: listen for messages from the extension host
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg?.type === "pipeline") {
        setPipeline(msg.data);
        setError(null);
      } else if (msg?.type === "yaml") {
        setConditions((c) => ({ ...c, yaml: msg.data }));
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  useEffect(() => {
    const keys = pipeline.suggested_variables;
    if (!keys?.length) return;
    setConditions((c) => {
      const existing = new Set(c.extraVars.map((v) => v.key));
      const toAdd = keys.filter((k) => !existing.has(k)).map((k) => ({ key: k, value: "" }));
      if (toAdd.length === 0) return c;
      return { ...c, extraVars: [...c.extraVars, ...toAdd] };
    });
  }, [pipeline.suggested_variables]);

  const buildVars = useCallback((c: ConditionState): Record<string, string> => {
    const vars: Record<string, string> = {};
    if (c.pipelineSource) vars["CI_PIPELINE_SOURCE"] = c.pipelineSource;
    if (c.branch) vars["CI_COMMIT_BRANCH"] = c.branch;
    if (c.tag) vars["CI_COMMIT_TAG"] = c.tag;
    for (const { key, value } of c.extraVars) {
      if (key) vars[key] = value;
    }
    return vars;
  }, []);

  const analyze = useCallback(async () => {
    if (!conditions.yaml) return;
    setLoading(true);
    setError(null);
    setSelectedJob(null);

    const payload: PipelineInput = {
      yaml: conditions.yaml,
      variables: buildVars(conditions),
    };

    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data: Pipeline = await res.json();
      if (data.error) {
        setError(data.error);
        setPipeline(EMPTY_PIPELINE);
      } else {
        setPipeline(data);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [conditions, buildVars]);

  const enabledCount = pipeline.jobs.filter((j) => j.enabled).length;
  const totalCount = pipeline.jobs.length;

  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100 overflow-hidden">
      <ConditionPanel
        state={conditions}
        onChange={setConditions}
        onAnalyze={analyze}
        loading={loading}
        suggestedBranches={pipeline.suggested_branches}
      />

      <div className="flex-1 flex flex-col overflow-hidden">
        {/* toolbar */}
        <div className="flex items-center gap-4 px-4 py-2 border-b border-zinc-800 bg-zinc-900 text-xs">
          {totalCount > 0 && (
            <>
              <span className="text-zinc-400">
                <span className="text-emerald-400 font-medium">{enabledCount}</span>
                <span className="text-zinc-600"> / {totalCount} jobs enabled</span>
              </span>
              <span className="text-zinc-700">·</span>
              <span className="text-zinc-400">{pipeline.stages.length} stages</span>
              <span className="text-zinc-700">·</span>
              <span className="text-zinc-400">
                {pipeline.edges.filter((e) => e.type === "needs").length} explicit deps
              </span>
            </>
          )}
          <div className="ml-auto flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-zinc-500 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showDisabled}
                onChange={(e) => setShowDisabled(e.target.checked)}
                className="accent-blue-500"
              />
              Show disabled
            </label>
            <label className="flex items-center gap-1.5 text-zinc-500 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showStageEdges}
                onChange={(e) => setShowStageEdges(e.target.checked)}
                className="accent-blue-500"
              />
              Show stage edges
            </label>
          </div>
        </div>

        {/* main area */}
        <div className="flex-1 flex overflow-hidden relative">
          {error ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="bg-red-950 border border-red-800 rounded-lg p-6 max-w-lg">
                <p className="text-red-400 text-sm font-medium mb-2">Parse error</p>
                <pre className="text-red-300 text-xs whitespace-pre-wrap">{error}</pre>
              </div>
            </div>
          ) : pipeline.jobs.length === 0 ? (
            <EmptyState />
          ) : enabledCount === 0 && !showDisabled ? (
            <NoJobsState onShowDisabled={() => setShowDisabled(true)} />
          ) : (
            <PipelineGraph
              pipeline={pipeline}
              selectedJob={selectedJob}
              onSelectJob={setSelectedJob}
              showStageEdges={showStageEdges}
              showDisabled={showDisabled}
            />
          )}

          <JobDetails job={selectedJob} onClose={() => setSelectedJob(null)} />
        </div>
      </div>
    </div>
  );
}

function NoJobsState({ onShowDisabled }: { onShowDisabled: () => void }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3">
      <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
        <circle cx="24" cy="24" r="18" stroke="#52525b" strokeWidth="1.5" />
        <line x1="24" y1="14" x2="24" y2="26" stroke="#52525b" strokeWidth="2" strokeLinecap="round" />
        <circle cx="24" cy="32" r="1.5" fill="#52525b" />
      </svg>
      <p className="text-sm text-zinc-400">No jobs will run under these conditions</p>
      <p className="text-xs text-zinc-600 text-center max-w-xs">
        All jobs are disabled by their rules. Try adjusting the branch, tag, or pipeline source, or{" "}
        <button onClick={onShowDisabled} className="text-zinc-400 underline hover:text-zinc-200 transition-colors">
          show disabled jobs
        </button>
        {" "}to inspect why.
      </p>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-zinc-600 gap-3">
      <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
        <rect x="4" y="12" width="12" height="10" rx="2" stroke="#52525b" strokeWidth="1.5" />
        <rect x="20" y="8" width="12" height="10" rx="2" stroke="#52525b" strokeWidth="1.5" />
        <rect x="20" y="24" width="12" height="10" rx="2" stroke="#52525b" strokeWidth="1.5" />
        <rect x="36" y="16" width="12" height="10" rx="2" stroke="#52525b" strokeWidth="1.5" />
        <line x1="16" y1="17" x2="20" y2="13" stroke="#3f3f46" strokeWidth="1.5" />
        <line x1="16" y1="17" x2="20" y2="29" stroke="#3f3f46" strokeWidth="1.5" />
        <line x1="32" y1="13" x2="36" y2="21" stroke="#3f3f46" strokeWidth="1.5" />
        <line x1="32" y1="29" x2="36" y2="21" stroke="#3f3f46" strokeWidth="1.5" />
      </svg>
      <p className="text-sm">Paste a GitLab CI YAML and click Analyze</p>
    </div>
  );
}
