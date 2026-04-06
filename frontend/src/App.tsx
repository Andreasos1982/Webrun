import { startTransition, useEffect, useState, type FormEvent } from "react";

import { API_BASE, createJob, fetchLogs, listJobs } from "./api";
import type { JobRecord } from "./types";


const defaultPrompt =
  "Inspect this workspace in read-only mode and summarize what is already here, what the main app pieces are, and what looks missing.";


function formatDate(value: string | null): string {
  if (!value) {
    return "n/a";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}


export default function App() {
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [logs, setLogs] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedJob = jobs.find((job) => job.id === selectedJobId) ?? null;

  useEffect(() => {
    let cancelled = false;

    async function refreshJobs() {
      try {
        const response = await listJobs();
        if (cancelled) {
          return;
        }

        startTransition(() => {
          setJobs(response.jobs);
          setSelectedJobId((current) => {
            if (current && response.jobs.some((job) => job.id === current)) {
              return current;
            }
            return response.jobs[0]?.id ?? null;
          });
        });
      } catch (requestError) {
        if (!cancelled) {
          setError(requestError instanceof Error ? requestError.message : "Unable to load jobs.");
        }
      }
    }

    refreshJobs();
    const intervalId = window.setInterval(refreshJobs, 2500);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    if (!selectedJobId) {
      setLogs("");
      return;
    }

    const currentJobId = selectedJobId;
    let cancelled = false;
    let offset = 0;
    let timeoutId: number | null = null;
    setLogs("");

    async function poll() {
      if (cancelled) {
        return;
      }

      try {
        const response = await fetchLogs(currentJobId, offset);
        if (cancelled) {
          return;
        }

        offset = response.next_offset;
        if (response.chunk) {
          startTransition(() => {
            setLogs((current) => current + response.chunk);
          });
        }

        const nextDelay = response.complete ? 4000 : 1200;
        timeoutId = window.setTimeout(poll, nextDelay);
      } catch (requestError) {
        if (!cancelled) {
          setError(requestError instanceof Error ? requestError.message : "Unable to load logs.");
          timeoutId = window.setTimeout(poll, 2500);
        }
      }
    }

    poll();

    return () => {
      cancelled = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [selectedJobId]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const job = await createJob({
        prompt,
        mode: "read-only",
      });

      startTransition(() => {
        setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
        setSelectedJobId(job.id);
      });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to create job.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-header">
          <p className="eyebrow">Codex Runner</p>
          <h1>Jobs</h1>
          <p className="sidebar-copy">Minimal browser UI for read-only VPS Codex runs.</p>
        </div>

        <div className="api-target">
          <span className="api-target-label">API</span>
          <code>{API_BASE}</code>
        </div>

        <div className="job-list">
          {jobs.length === 0 ? (
            <div className="empty-card">No jobs yet.</div>
          ) : (
            jobs.map((job) => (
              <button
                key={job.id}
                className={`job-item ${job.id === selectedJobId ? "selected" : ""}`}
                onClick={() => setSelectedJobId(job.id)}
                type="button"
              >
                <div className="job-item-top">
                  <span className={`status-pill ${job.status}`}>{job.status}</span>
                  <span className="job-item-id">{job.id}</span>
                </div>
                <p className="job-item-prompt">{job.prompt}</p>
                <span className="job-item-time">{formatDate(job.created_at)}</span>
              </button>
            ))
          )}
        </div>
      </aside>

      <main className="main-column">
        <section className="editor-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Task</p>
              <h2>Read-Only Job</h2>
            </div>
            <span className="mode-badge">snapshot-backed Codex exec</span>
          </div>

          <form className="task-form" onSubmit={handleSubmit}>
            <label className="field-label" htmlFor="prompt">
              Prompt
            </label>
            <textarea
              id="prompt"
              className="prompt-editor"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Describe the read-only inspection task to run."
              rows={10}
            />
            <div className="task-form-footer">
              <div className="helper-copy">
                The backend builds a bounded workspace snapshot, sends that snapshot to Codex in read-only
                mode, and stores the resulting logs under <code>data/jobs</code>.
              </div>
              <button className="primary-button" disabled={submitting || !prompt.trim()} type="submit">
                {submitting ? "Starting..." : "Create Job"}
              </button>
            </div>
          </form>

          {error ? <div className="error-banner">{error}</div> : null}

          <div className="details-grid">
            <div className="detail-card">
              <p className="eyebrow">Selected Job</p>
              {selectedJob ? (
                <>
                  <h3>{selectedJob.id}</h3>
                  <p className="detail-copy">Executor: {selectedJob.executor}</p>
                  <p className="detail-copy">Started: {formatDate(selectedJob.started_at)}</p>
                  <p className="detail-copy">Finished: {formatDate(selectedJob.finished_at)}</p>
                </>
              ) : (
                <p className="detail-copy">Pick a job from the sidebar to inspect it.</p>
              )}
            </div>

            <div className="detail-card">
              <p className="eyebrow">Workspace</p>
              <h3>Current Root</h3>
              <p className="detail-copy">{selectedJob?.cwd ?? "No job selected."}</p>
              <p className="detail-copy">Write-enabled jobs are intentionally not exposed yet.</p>
            </div>
          </div>

          <div className="result-card">
            <div className="panel-header compact">
              <div>
                <p className="eyebrow">Result</p>
                <h3>Last Assistant Output</h3>
              </div>
              {selectedJob ? <span className={`status-pill ${selectedJob.status}`}>{selectedJob.status}</span> : null}
            </div>
            <pre className="result-output">
              {selectedJob?.final_output ?? "Run a job to see the final assistant response here."}
            </pre>
            {selectedJob?.error ? <div className="error-inline">{selectedJob.error}</div> : null}
          </div>
        </section>

        <section className="logs-panel">
          <div className="panel-header compact">
            <div>
              <p className="eyebrow">Logs</p>
              <h2>Output Panel</h2>
            </div>
            {selectedJob ? <span className="job-item-id">/{selectedJob.id}/output.log</span> : null}
          </div>
          <pre className="log-output">{logs || "Select a job to stream logs."}</pre>
        </section>
      </main>
    </div>
  );
}
