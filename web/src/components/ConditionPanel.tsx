import { useRef } from "react";
import type { ConditionState } from "../types";

interface Props {
  state: ConditionState;
  onChange: (s: ConditionState) => void;
  onAnalyze: () => void;
  onAnalyzeWithGitlab?: () => void;
  gitlabMode?: boolean;
  loading: boolean;
  suggestedBranches?: string[];
}

const DEFAULT_BRANCHES = ["main", "master", "develop", "alpha", "staging", "production"];

const PIPELINE_SOURCES = [
  { value: "push", label: "Push" },
  { value: "merge_request_event", label: "Merge Request" },
  { value: "schedule", label: "Schedule" },
  { value: "web", label: "Web (manual)" },
  { value: "pipeline", label: "Pipeline (upstream)" },
  { value: "trigger", label: "Trigger token" },
  { value: "api", label: "API" },
  { value: "parent_pipeline", label: "Parent pipeline" },
];

export default function ConditionPanel({ state, onChange, onAnalyze, onAnalyzeWithGitlab, gitlabMode, loading, suggestedBranches }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);

  function set(patch: Partial<ConditionState>) {
    onChange({ ...state, ...patch });
  }

  function addVar() {
    set({ extraVars: [...state.extraVars, { key: "", value: "" }] });
  }

  function updateVar(i: number, field: "key" | "value", val: string) {
    const next = state.extraVars.map((v, idx) => (idx === i ? { ...v, [field]: val } : v));
    set({ extraVars: next });
  }

  function removeVar(i: number) {
    set({ extraVars: state.extraVars.filter((_, idx) => idx !== i) });
  }

  async function loadSample(name: string) {
    const res = await fetch(`/samples/${name}`);
    if (res.ok) {
      set({ yaml: await res.text() });
    }
  }

  function loadFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => set({ yaml: reader.result as string });
    reader.readAsText(file);
    e.target.value = "";
  }

  return (
    <aside className="w-64 h-full flex-shrink-0 bg-zinc-900 border-r border-zinc-800 flex flex-col overflow-hidden">
      <div className="px-4 py-3 border-b border-zinc-800">
        <h1 className="text-sm font-semibold text-zinc-100">GitLab CI Visualizer</h1>
      </div>

      <div className="overflow-y-auto flex-1 p-4 space-y-5 text-xs">
        {/* YAML source */}
        <div>
          <Label>YAML source</Label>
          <div className="flex flex-wrap gap-1.5 mb-1.5">
            <button onClick={() => loadSample("ctf-gitlab-ci.yaml")} className={btn}>
              CTF sample
            </button>
            <button onClick={() => loadSample("artifact-flow.yaml")} className={btn}>
              Artifact flow
            </button>
            <button onClick={() => loadSample("matrix.yaml")} className={btn}>
              Matrix
            </button>
            <button onClick={() => loadSample("triggers.yaml")} className={btn}>
              Triggers
            </button>
            <button onClick={() => fileRef.current?.click()} className={btn}>
              Load file…
            </button>
            <input ref={fileRef} type="file" accept=".yaml,.yml" className="hidden" onChange={loadFile} />
          </div>
          <textarea
            className="w-full h-24 bg-zinc-800 text-zinc-300 border border-zinc-700 rounded px-2 py-1.5 text-[10px] font-mono resize-none focus:outline-none focus:border-zinc-500"
            placeholder="Paste GitLab CI YAML here…"
            value={state.yaml}
            onChange={(e) => set({ yaml: e.target.value })}
          />
          {state.yaml && (
            <p className="text-zinc-600 text-[10px] mt-0.5">
              {state.yaml.split("\n").length} lines
            </p>
          )}
        </div>

        {/* Pipeline source */}
        <div>
          <Label>Pipeline source</Label>
          <select
            className={select}
            value={state.pipelineSource}
            onChange={(e) => set({ pipelineSource: e.target.value })}
          >
            <option value="">(not set)</option>
            {PIPELINE_SOURCES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>

        {/* Branch / tag */}
        <div>
          <Label>Branch</Label>
          {(() => {
            const branches = [...new Set([...DEFAULT_BRANCHES, ...(suggestedBranches ?? [])])];
            const isManual = state.branch !== "" && !branches.includes(state.branch);
            const selectVal = isManual ? "__manual__" : state.branch;
            return (
              <>
                <select
                  className={select}
                  value={selectVal}
                  onChange={(e) => {
                    if (e.target.value === "__manual__") set({ branch: "" });
                    else set({ branch: e.target.value });
                  }}
                >
                  <option value="">(not set)</option>
                  {branches.map((b) => (
                    <option key={b} value={b}>{b}</option>
                  ))}
                  <option value="__manual__">Manual…</option>
                </select>
                {(isManual || selectVal === "__manual__") && (
                  <input
                    className={`${input} mt-1`}
                    placeholder="custom-branch"
                    value={state.branch}
                    onChange={(e) => set({ branch: e.target.value })}
                    autoFocus
                  />
                )}
              </>
            );
          })()}
        </div>
        <div>
          <Label>Tag</Label>
          <input
            className={input}
            placeholder="v1.0.0"
            value={state.tag}
            onChange={(e) => set({ tag: e.target.value })}
          />
        </div>

        {/* Extra variables */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <Label>Variables</Label>
            <button onClick={addVar} className="text-zinc-500 hover:text-zinc-300 transition-colors text-base leading-none">
              +
            </button>
          </div>
          <div className="space-y-1">
            {state.extraVars.map((v, i) => (
              <div key={i} className="flex gap-1 items-center">
                <input
                  className={`${input} flex-1 min-w-0`}
                  placeholder="KEY"
                  value={v.key}
                  onChange={(e) => updateVar(i, "key", e.target.value)}
                />
                <input
                  className={`${input} flex-1 min-w-0`}
                  placeholder="value"
                  value={v.value}
                  onChange={(e) => updateVar(i, "value", e.target.value)}
                />
                <button
                  onClick={() => removeVar(i)}
                  className="text-zinc-600 hover:text-zinc-400 flex-shrink-0"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Analyze button */}
      <div className="p-4 border-t border-zinc-800 space-y-2">
        <button
          onClick={gitlabMode ? onAnalyzeWithGitlab : onAnalyze}
          disabled={!state.yaml || loading}
          className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-xs font-medium py-2 rounded transition-colors"
        >
          {loading ? "Analyzing…" : gitlabMode ? "Analyze with GitLab" : "Analyze pipeline"}
        </button>
        {gitlabMode && (
          <p className="text-[10px] text-zinc-500 text-center">
            Using GitLab-resolved YAML (includes resolved remotely)
          </p>
        )}
      </div>
    </aside>
  );
}

const btn =
  "px-2 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded text-[10px] transition-colors";
const input =
  "w-full bg-zinc-800 text-zinc-300 border border-zinc-700 rounded px-2 py-1 text-[10px] font-mono focus:outline-none focus:border-zinc-500";
const select =
  "w-full bg-zinc-800 text-zinc-300 border border-zinc-700 rounded px-2 py-1 text-[10px] focus:outline-none focus:border-zinc-500";

function Label({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-1">
      {children}
    </p>
  );
}
