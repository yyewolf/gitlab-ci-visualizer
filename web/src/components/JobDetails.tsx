import type { Job, MatrixInstance } from "../types";

interface Props {
  job: Job | null;
  onClose: () => void;
}

export default function JobDetails({ job, onClose }: Props) {
  if (!job) return null;

  return (
    <aside className="w-80 flex-shrink-0 bg-zinc-900 border-l border-zinc-800 flex flex-col overflow-hidden">
      {/* header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
        <div>
          <p className="text-xs text-zinc-500 font-mono">{job.stage}</p>
          <h2 className="text-sm font-semibold text-zinc-100 break-all">{job.name}</h2>
        </div>
        <button
          onClick={onClose}
          className="text-zinc-500 hover:text-zinc-300 transition-colors text-lg leading-none ml-2"
        >
          ×
        </button>
      </div>

      <div className="overflow-y-auto flex-1 p-4 space-y-4 text-xs">
        {/* status */}
        <Section title="Status">
          <Row label="Enabled">{job.enabled ? "✓ yes" : "✗ no"}</Row>
          <Row label="When">{job.when}</Row>
          {job.allow_failure && <Row label="Allow failure">yes</Row>}
          {job.interruptible && <Row label="Interruptible">yes</Row>}
          {job.image && <Row label="Image">{job.image}</Row>}
          {job.environment && <Row label="Environment">{job.environment}</Row>}
          {job.resource_group && <Row label="Resource group">{job.resource_group}</Row>}
          {job.tags && job.tags.length > 0 && (
            <Row label="Tags">{job.tags.join(", ")}</Row>
          )}
        </Section>

        {/* needs */}
        {job.has_explicit_needs && (
          <Section title="Needs">
            {job.needs.length === 0 ? (
              <p className="text-zinc-500 italic">no prerequisites (starts immediately)</p>
            ) : (
              job.needs.map((n) => (
                <p key={n} className="font-mono text-sky-400">{n}</p>
              ))
            )}
          </Section>
        )}

        {/* artifacts */}
        {job.artifacts && (
          <Section title="Artifacts">
            {job.artifacts.paths?.map((p) => (
              <p key={p} className="font-mono text-zinc-300">{p}</p>
            ))}
            {job.artifacts.expire_in && (
              <Row label="Expires in">{job.artifacts.expire_in}</Row>
            )}
            {job.artifacts.when && (
              <Row label="Upload when">{job.artifacts.when}</Row>
            )}
            {job.artifacts.reports &&
              Object.entries(job.artifacts.reports).map(([type, paths]) => (
                <div key={type} className="mt-1">
                  <p className="text-zinc-500">report: {type}</p>
                  {paths && paths.map((p) => (
                    <p key={p} className="font-mono text-zinc-300 ml-2">{p}</p>
                  ))}
                </div>
              ))}
          </Section>
        )}

        {/* parallel/matrix */}
        {job.parallel_count != null && job.parallel_count > 0 && (
          job.matrix_instances?.length
            ? <MatrixSection job={job} instances={job.matrix_instances} />
            : <ParallelSection job={job} />
        )}

        {/* variables */}
        {job.variables && Object.keys(job.variables).length > 0 && (
          <Section title="Variables">
            {Object.entries(job.variables).map(([k, v]) => (
              <div key={k} className="flex gap-1">
                <span className="text-zinc-500 flex-shrink-0">{k}=</span>
                <span className="text-zinc-300 break-all font-mono">{v}</span>
              </div>
            ))}
          </Section>
        )}

        {/* rules trace */}
        {(job.rules_trace?.length ?? 0) > 0 && (
          <Section title="Rules evaluation">
            {(job.rules_trace ?? []).map((r) => (
              <div
                key={r.rule_index}
                className={`p-2 rounded mb-1 ${r.matched ? "bg-emerald-950 border border-emerald-800" : "bg-zinc-800"}`}
              >
                <div className="flex items-center gap-1.5 mb-0.5">
                  <span className={r.matched ? "text-emerald-400" : "text-zinc-500"}>
                    {r.matched ? "✓" : "✗"} rule {r.rule_index + 1}
                  </span>
                  {r.when && (
                    <span className="text-zinc-500">→ {r.when}</span>
                  )}
                </div>
                {r.condition && (
                  <code className="text-[10px] text-zinc-400 break-all">{r.condition}</code>
                )}
              </div>
            ))}
          </Section>
        )}
      </div>
    </aside>
  );
}

function MatrixSection({ job, instances }: { job: Job; instances: MatrixInstance[] }) {
  return (
    <div>
      <div className="flex items-baseline gap-2 mb-2">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Matrix</p>
        <span className="text-[10px] text-zinc-600">{instances.length} instances</span>
      </div>
      <div className="space-y-1.5">
        {instances.map((inst) => {
          const varEntries = Object.entries(inst.variables);
          return (
            <div
              key={inst.name}
              className="rounded-md border border-zinc-700/60 bg-zinc-800/60 px-2.5 py-2 hover:border-zinc-600 transition-colors"
            >
              {/* instance name row */}
              <div className="flex items-center gap-1.5 mb-1.5">
                <span className={`flex-shrink-0 w-1.5 h-1.5 rounded-full ${job.enabled ? "bg-emerald-500" : "bg-zinc-600"}`} />
                <span className="font-mono text-[10px] text-zinc-200 break-all leading-snug">
                  {job.name} <span className="text-zinc-500">{inst.name}</span>
                </span>
              </div>
              {/* variable chips */}
              <div className="flex flex-wrap gap-1 pl-3">
                {varEntries.map(([k, v]) => (
                  <span
                    key={k}
                    className="inline-flex items-center gap-1 bg-zinc-700 rounded px-1.5 py-0.5 text-[9px] leading-none"
                  >
                    <span className="text-zinc-400">{k}:</span>
                    <span className="text-violet-300 font-mono">{v}</span>
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ParallelSection({ job }: { job: Job }) {
  return (
    <div>
      <div className="flex items-baseline gap-2 mb-2">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Parallel</p>
        <span className="text-[10px] text-zinc-600">{job.parallel_count} instances</span>
      </div>
      <div className="space-y-1">
        {Array.from({ length: job.parallel_count ?? 0 }, (_, i) => (
          <div
            key={i}
            className="flex items-center gap-2 rounded-md border border-zinc-700/60 bg-zinc-800/60 px-2.5 py-1.5 hover:border-zinc-600 transition-colors"
          >
            <span className={`flex-shrink-0 w-1.5 h-1.5 rounded-full ${job.enabled ? "bg-emerald-500" : "bg-zinc-600"}`} />
            <span className="font-mono text-[10px] text-zinc-200">{job.name}</span>
            <span className="ml-auto text-[9px] text-zinc-500">{i + 1}/{job.parallel_count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-1.5">
        {title}
      </p>
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2 leading-relaxed">
      <span className="text-zinc-500 flex-shrink-0 w-24">{label}</span>
      <span className="text-zinc-300">{children}</span>
    </div>
  );
}
