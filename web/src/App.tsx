import { useState, useCallback, useEffect } from "react";
import type { Pipeline, Job, ConditionState, PipelineInput } from "./types";
import ConditionPanel from "./components/ConditionPanel";
import PipelineGraph from "./components/PipelineGraph";
import ArtifactFlowView from "./components/ArtifactFlowView";
import JobDetails from "./components/JobDetails";

interface DownstreamNav {
  jobName: string;
  pipeline: Pipeline;
}

const EMPTY_PIPELINE: Pipeline = { stages: [], jobs: [], edges: [] };

// Ensure every array field on a Job is really an array so components can call .map/.length safely.
function normalizeJob(job: Job): Job {
  return {
    ...job,
    needs: job.needs ?? [],
    needs_no_artifacts: job.needs_no_artifacts ?? [],
    rules_trace: job.rules_trace ?? [],
    tags: job.tags ?? [],
    dependencies: job.dependencies ?? [],
    matrix_instances: job.matrix_instances ?? [],
    artifacts: job.artifacts
      ? {
          ...job.artifacts,
          paths: job.artifacts.paths ?? [],
          reports: job.artifacts.reports ?? {},
        }
      : undefined,
  };
}

function normalizePipeline(p: Pipeline): Pipeline {
  return {
    ...p,
    stages: p.stages ?? [],
    jobs: (p.jobs ?? []).map(normalizeJob),
    edges: p.edges ?? [],
    artifact_edges: p.artifact_edges ?? [],
    suggested_branches: p.suggested_branches ?? [],
    suggested_variables: p.suggested_variables ?? [],
    warnings: p.warnings ?? [],
  };
}

// Acquire the VSCode API once at module level - only available inside a webview.
const vscodeApi = (() => {
  try {
    return (window as Window & typeof globalThis & { acquireVsCodeApi?: () => { postMessage: (msg: unknown) => void } }).acquireVsCodeApi?.();
  } catch {
    return undefined;
  }
})();

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
  const [viewMode, setViewMode] = useState<"pipeline" | "artifacts">("pipeline");
  const [showStageEdges, setShowStageEdges] = useState(true);
  const [showDisabled, setShowDisabled] = useState(false);
  // Tracks whether the last triggered analysis used GitLab resolution.
  // Live-regen on file save will re-use this mode automatically.
  const [gitlabMode, setGitlabMode] = useState(false);
  const [downstreamPipelines, setDownstreamPipelines] = useState<Record<string, Pipeline>>({});
  const [downstreamNav, setDownstreamNav] = useState<DownstreamNav | null>(null);

  // VSCode extension integration: listen for messages from the extension host.
  // Also used by the extension to deliver analysis results.
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg?.type === "pipeline") {
        setPipeline(normalizePipeline(msg.data));
        setDownstreamPipelines({});
        setDownstreamNav(null);
        setError(null);
        setLoading(false);
      } else if (msg?.type === "downstream-pipeline") {
        setDownstreamPipelines((prev) => ({ ...prev, [msg.jobName]: normalizePipeline(msg.pipeline) }));
      } else if (msg?.type === "error") {
        setError(msg.data);
        setPipeline(EMPTY_PIPELINE);
        setLoading(false);
      } else if (msg?.type === "yaml") {
        setConditions((c) => ({ ...c, yaml: msg.data, ...(msg.branch ? { branch: msg.branch } : {}) }));
        if (msg.useGitlab !== undefined) {
          setGitlabMode(!!msg.useGitlab);
        }
        setPendingAnalyze(true);
      }
    };
    window.addEventListener("message", handler);
    // Tell the extension host we're ready to receive the file.
    vscodeApi?.postMessage({ type: "ready" });
    return () => window.removeEventListener("message", handler);
  }, []);

  // Standalone (glvis CLI) mode: ask the server for the autodetected/--file
  // .gitlab-ci.yml and current branch, then auto-analyze.
  useEffect(() => {
    if (vscodeApi) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/initial");
        if (!res.ok) return;
        const data = (await res.json()) as { yaml?: string; branch?: string };
        if (cancelled || !data.yaml) return;
        setConditions((c) => ({
          ...c,
          yaml: data.yaml as string,
          ...(data.branch ? { branch: data.branch } : {}),
        }));
        setPendingAnalyze(true);
      } catch {
        // No initial file available - user can paste manually.
      }
    })();
    return () => {
      cancelled = true;
    };
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

  const onViewDownstream = useCallback((jobName: string) => {
    const dp = downstreamPipelines[jobName];
    if (dp) setDownstreamNav({ jobName, pipeline: dp });
  }, [downstreamPipelines]);

  const analyze = useCallback(async () => {
    if (!conditions.yaml) return;
    setLoading(true);
    setError(null);
    setSelectedJob(null);
    setDownstreamPipelines({});
    setDownstreamNav(null);

    const payload: PipelineInput = {
      yaml: conditions.yaml,
      variables: buildVars(conditions),
    };

    // In VSCode webview mode, delegate to the extension host via postMessage.
    // The response arrives through the message listener above (setLoading handled there).
    if (vscodeApi) {
      vscodeApi.postMessage({ type: "analyze", payload });
      return;
    }

    // Standalone web mode: call the local Go HTTP server.
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
        setPipeline(normalizePipeline(data));
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [conditions, buildVars]);

  // Sends the YAML to the extension host for GitLab-resolved analysis.
  // Only meaningful inside a VS Code webview; standalone mode falls back to local.
  const analyzeWithGitlab = useCallback(async () => {
    if (!conditions.yaml) return;
    setLoading(true);
    setError(null);
    setSelectedJob(null);

    const payload: PipelineInput = {
      yaml: conditions.yaml,
      variables: buildVars(conditions),
    };

    if (vscodeApi) {
      vscodeApi.postMessage({ type: "analyze-with-gitlab", payload });
      return;
    }

    // Standalone (glvis CLI) mode: the Go server resolves include: via the
    // GitLab CI lint API, then we analyze the merged YAML and resolve any
    // downstream trigger pipelines.
    setSelectedJob(null);
    setDownstreamPipelines({});
    setDownstreamNav(null);
    try {
      const resolveRes = await fetch("/api/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!resolveRes.ok) {
        setError(await resolveRes.text());
        setPipeline(EMPTY_PIPELINE);
        return;
      }
      const { resolved_yaml } = (await resolveRes.json()) as { resolved_yaml: string };

      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ yaml: resolved_yaml, variables: payload.variables }),
      });
      const data: Pipeline = await res.json();
      if (data.error) {
        setError(data.error);
        setPipeline(EMPTY_PIPELINE);
        return;
      }
      const resolved = normalizePipeline(data);
      setPipeline(resolved);
      void resolveDownstream(resolved, payload.variables);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [conditions, buildVars]);

  // Standalone downstream resolution: for each enabled trigger job, ask the Go
  // server to resolve + analyze its downstream pipeline and store the result.
  const resolveDownstream = useCallback(
    async (analyzed: Pipeline, variables: Record<string, string>) => {
      const triggerJobs = analyzed.jobs.filter((j) => j.trigger && j.enabled);
      await Promise.all(
        triggerJobs.map(async (j) => {
          try {
            const res = await fetch("/api/downstream", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ trigger: j.trigger, variables }),
            });
            if (!res.ok) return;
            const dp: Pipeline = await res.json();
            if (dp.error) return;
            setDownstreamPipelines((prev) => ({ ...prev, [j.name]: normalizePipeline(dp) }));
          } catch {
            // Silently skip unresolvable downstream pipelines.
          }
        })
      );
    },
    []
  );

  const [pendingAnalyze, setPendingAnalyze] = useState(false);

  useEffect(() => {
    if (pendingAnalyze && conditions.yaml) {
      setPendingAnalyze(false);
      if (gitlabMode) {
        analyzeWithGitlab();
      } else {
        analyze();
      }
    }
  }, [pendingAnalyze, conditions.yaml, analyze, analyzeWithGitlab, gitlabMode]);

  const [sidebarOpen, setSidebarOpen] = useState(!vscodeApi);

  // When in downstream nav, all views operate on the downstream pipeline.
  const activePipeline = downstreamNav?.pipeline ?? pipeline;

  const enabledCount = activePipeline.jobs.filter((j) => j.enabled).length;
  const totalCount = activePipeline.jobs.length;

  return (
    <div className="flex h-screen overflow-hidden bg-zinc-950 text-zinc-100">
      {/* Collapsible sidebar */}
      <div className={`flex-shrink-0 overflow-hidden transition-[width] duration-200 ease-in-out ${sidebarOpen ? "w-64" : "w-0"}`}>
        <div className="w-64 h-full">
          <ConditionPanel
            state={conditions}
            onChange={setConditions}
            onAnalyze={analyze}
            onAnalyzeWithGitlab={analyzeWithGitlab}
            gitlabMode={gitlabMode}
            loading={loading}
            suggestedBranches={pipeline.suggested_branches}
          />
        </div>
      </div>

      {/* Toggle strip */}
      <button
        onClick={() => setSidebarOpen((v) => !v)}
        className={`flex-shrink-0 ${sidebarOpen ? "w-3" : "w-8"} bg-zinc-900 border-x border-zinc-800 hover:bg-zinc-800 flex items-center justify-center cursor-pointer transition-[width,colors] duration-200 group`}
        title={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
      >
        <span className="text-zinc-600 group-hover:text-zinc-300 text-[11px] select-none transition-colors">
          {sidebarOpen ? "‹" : "›"}
        </span>
      </button>

      <div className="flex flex-col flex-1 overflow-hidden">
        {/* toolbar */}
        <div className="flex items-center gap-4 px-4 py-2 text-xs border-b border-zinc-800 bg-zinc-900">
          {/* downstream breadcrumb */}
          {downstreamNav && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => { setDownstreamNav(null); setSelectedJob(null); }}
                className="text-zinc-400 hover:text-zinc-200 transition-colors"
              >
                ← Main
              </button>
              <span className="text-zinc-600">/</span>
              <span className="text-sky-400 font-mono">{downstreamNav.jobName}</span>
            </div>
          )}

          {/* view mode tabs */}
          {totalCount > 0 && (
            <div className="flex items-center gap-0.5 rounded bg-zinc-800 p-0.5">
              <button
                className={`px-2.5 py-1 rounded text-xs transition-colors ${viewMode === "pipeline" ? "bg-zinc-700 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"}`}
                onClick={() => setViewMode("pipeline")}
              >
                Pipeline
              </button>
              <button
                className={`px-2.5 py-1 rounded text-xs transition-colors ${viewMode === "artifacts" ? "bg-amber-900 text-amber-200" : "text-zinc-500 hover:text-zinc-300"}`}
                onClick={() => setViewMode("artifacts")}
              >
                Artifact flow
              </button>
            </div>
          )}

          {totalCount > 0 && (
            <>
              <span className="text-zinc-400">
                <span className="font-medium text-emerald-400">{enabledCount}</span>
                <span className="text-zinc-600"> / {totalCount} jobs enabled</span>
              </span>
              <span className="text-zinc-700">·</span>
              <span className="text-zinc-400">{activePipeline.stages.length} stages</span>
              {viewMode === "pipeline" && (
                <>
                  <span className="text-zinc-700">·</span>
                  <span className="text-zinc-400">
                    {activePipeline.edges.filter((e) => e.type === "needs").length} explicit deps
                  </span>
                </>
              )}
              {viewMode === "artifacts" && (
                <>
                  <span className="text-zinc-700">·</span>
                  <span className="text-zinc-400">
                    {(activePipeline.artifact_edges ?? []).length} artifact flows
                  </span>
                </>
              )}
            </>
          )}
          <div className="flex items-center gap-3 ml-auto">
            <label className="flex items-center gap-1.5 text-zinc-500 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showDisabled}
                onChange={(e) => setShowDisabled(e.target.checked)}
                className="accent-blue-500"
              />
              Show disabled
            </label>
            {viewMode === "pipeline" && (
              <label className="flex items-center gap-1.5 text-zinc-500 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={showStageEdges}
                  onChange={(e) => setShowStageEdges(e.target.checked)}
                  className="accent-blue-500"
                />
                Show stage edges
              </label>
            )}
          </div>
        </div>

        {/* warnings */}
        {activePipeline.warnings && activePipeline.warnings.length > 0 && (
          <div className="px-4 py-2 bg-amber-950/60 border-b border-amber-800/60 flex flex-col gap-0.5">
            {activePipeline.warnings.map((w, i) => (
              <p key={i} className="text-xs text-amber-400">⚠ {w}</p>
            ))}
          </div>
        )}

        {/* main area */}
        <div className="relative flex flex-1 overflow-hidden">
          {error && !downstreamNav ? (
            <div className="flex items-center justify-center flex-1">
              <div className="max-w-lg p-6 border border-red-800 rounded-lg bg-red-950">
                <p className="mb-2 text-sm font-medium text-red-400">Parse error</p>
                <pre className="text-xs text-red-300 whitespace-pre-wrap">{error}</pre>
              </div>
            </div>
          ) : activePipeline.jobs.length === 0 ? (
            <EmptyState />
          ) : enabledCount === 0 && !showDisabled ? (
            <NoJobsState onShowDisabled={() => setShowDisabled(true)} />
          ) : viewMode === "artifacts" ? (
            <ArtifactFlowView
              pipeline={activePipeline}
              selectedJob={selectedJob}
              onSelectJob={setSelectedJob}
              showDisabled={showDisabled}
            />
          ) : (
            <PipelineGraph
              pipeline={activePipeline}
              selectedJob={selectedJob}
              onSelectJob={setSelectedJob}
              showStageEdges={showStageEdges}
              showDisabled={showDisabled}
            />
          )}

          <JobDetails
            job={selectedJob}
            onClose={() => setSelectedJob(null)}
            downstreamPipeline={selectedJob?.trigger ? !!downstreamPipelines[selectedJob.name] : false}
            onViewDownstream={onViewDownstream}
          />
        </div>
      </div>
    </div>
  );
}

function NoJobsState({ onShowDisabled }: { onShowDisabled: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center flex-1 gap-3">
      <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
        <circle cx="24" cy="24" r="18" stroke="#52525b" strokeWidth="1.5" />
        <line x1="24" y1="14" x2="24" y2="26" stroke="#52525b" strokeWidth="2" strokeLinecap="round" />
        <circle cx="24" cy="32" r="1.5" fill="#52525b" />
      </svg>
      <p className="text-sm text-zinc-400">No jobs will run under these conditions</p>
      <p className="max-w-xs text-xs text-center text-zinc-600">
        All jobs are disabled by their rules. Try adjusting the branch, tag, or pipeline source, or{" "}
        <button onClick={onShowDisabled} className="underline transition-colors text-zinc-400 hover:text-zinc-200">
          show disabled jobs
        </button>
        {" "}to inspect why.
      </p>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center flex-1 gap-3 text-zinc-600">
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
