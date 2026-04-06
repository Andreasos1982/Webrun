import { startTransition, useEffect, useState, type FormEvent } from "react";

import { API_BASE, createJob, fetchEvents, fetchJob, fetchLogs, fetchRuntime, listJobs } from "./api";
import type { JobMode, JobRecord, ModeCapability, RuntimeInfo } from "./types";


const defaultPrompt =
  "Inspect this workspace in read-only mode and summarize what is already here, what the main app pieces are, and what looks missing.";

type PanelTab = "output" | "logs" | "events";


function formatDate(value: string | null): string {
  if (!value) {
    return "n/a";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}


function summarizePrompt(prompt: string): string {
  const singleLine = prompt.replace(/\s+/g, " ").trim();
  if (singleLine.length <= 92) {
    return singleLine;
  }
  return `${singleLine.slice(0, 89)}...`;
}


function getModeCapability(runtime: RuntimeInfo | null, mode: JobMode): ModeCapability | null {
  return runtime?.modes.find((item) => item.mode === mode) ?? null;
}


export default function App() {
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [mode, setMode] = useState<JobMode>("read-only");
  const [logs, setLogs] = useState("");
  const [events, setEvents] = useState("");
  const [activePanel, setActivePanel] = useState<PanelTab>("output");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedJob = jobs.find((job) => job.id === selectedJobId) ?? null;
  const selectedModeCapability = getModeCapability(runtime, mode);
  const selectedJobCapability = selectedJob ? getModeCapability(runtime, selectedJob.mode) : null;

  useEffect(() => {
    let cancelled = false;

    async function loadRuntime() {
      try {
        const response = await fetchRuntime();
        if (cancelled) {
          return;
        }

        startTransition(() => {
          setRuntime(response);
        });
      } catch (requestError) {
        if (!cancelled) {
          setError(requestError instanceof Error ? requestError.message : "Unable to load runtime info.");
        }
      }
    }

    loadRuntime();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!runtime) {
      return;
    }

    const currentModeAvailable = runtime.modes.some((item) => item.mode === mode && item.enabled);
    if (!currentModeAvailable) {
      const firstEnabledMode = runtime.modes.find((item) => item.enabled)?.mode ?? "read-only";
      setMode(firstEnabledMode);
    }
  }, [runtime, mode]);

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
      return;
    }

    const currentJobId = selectedJobId;
    let cancelled = false;

    async function refreshSelectedJob() {
      try {
        const job = await fetchJob(currentJobId);
        if (cancelled) {
          return;
        }

        startTransition(() => {
          setJobs((current) => {
            const nextJobs = current.map((item) => (item.id === job.id ? job : item));
            if (!nextJobs.some((item) => item.id === job.id)) {
              nextJobs.unshift(job);
            }
            return nextJobs;
          });
        });
      } catch (requestError) {
        if (!cancelled) {
          setError(requestError instanceof Error ? requestError.message : "Unable to refresh the selected job.");
        }
      }
    }

    refreshSelectedJob();
    const intervalId = window.setInterval(refreshSelectedJob, 1500);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [selectedJobId]);

  useEffect(() => {
    if (!selectedJobId) {
      setLogs("");
      setEvents("");
      return;
    }

    const currentJobId = selectedJobId;
    let cancelled = false;
    let logsOffset = 0;
    let eventsOffset = 0;
    let logsTimeoutId: number | null = null;
    let eventsTimeoutId: number | null = null;

    setLogs("");
    setEvents("");

    async function pollLogs() {
      if (cancelled) {
        return;
      }

      try {
        const response = await fetchLogs(currentJobId, logsOffset);
        if (cancelled) {
          return;
        }

        logsOffset = response.next_offset;
        if (response.chunk) {
          startTransition(() => {
            setLogs((current) => current + response.chunk);
          });
        }

        logsTimeoutId = window.setTimeout(pollLogs, response.complete ? 4000 : 1200);
      } catch (requestError) {
        if (!cancelled) {
          setError(requestError instanceof Error ? requestError.message : "Unable to load logs.");
          logsTimeoutId = window.setTimeout(pollLogs, 2500);
        }
      }
    }

    async function pollEvents() {
      if (cancelled) {
        return;
      }

      try {
        const response = await fetchEvents(currentJobId, eventsOffset);
        if (cancelled) {
          return;
        }

        eventsOffset = response.next_offset;
        if (response.chunk) {
          startTransition(() => {
            setEvents((current) => current + response.chunk);
          });
        }

        eventsTimeoutId = window.setTimeout(pollEvents, response.complete ? 4000 : 1500);
      } catch (requestError) {
        if (!cancelled) {
          setError(requestError instanceof Error ? requestError.message : "Unable to load events.");
          eventsTimeoutId = window.setTimeout(pollEvents, 2500);
        }
      }
    }

    pollLogs();
    pollEvents();

    return () => {
      cancelled = true;
      if (logsTimeoutId !== null) {
        window.clearTimeout(logsTimeoutId);
      }
      if (eventsTimeoutId !== null) {
        window.clearTimeout(eventsTimeoutId);
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
        mode,
      });

      startTransition(() => {
        setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
        setSelectedJobId(job.id);
        setActivePanel("logs");
      });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to create job.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="app-shell">
      <aside className="activity-bar">
        <div className="activity-brand">WR</div>
        <button className="activity-button active" type="button">
          Jobs
        </button>
        <button className="activity-button" type="button">
          Task
        </button>
        <button className="activity-button" type="button">
          Output
        </button>
      </aside>

      <aside className="sidebar">
        <div className="sidebar-section">
          <p className="section-label">Explorer</p>
          <h1>Sessions</h1>
          <p className="sidebar-copy">Detached Codex runs backed by local job files under `data/jobs`.</p>
        </div>

        <div className="runtime-card">
          <div className="runtime-row">
            <span className="runtime-key">Workspace</span>
            <span className="runtime-value">{runtime?.workspace_root ?? "Loading..."}</span>
          </div>
          <div className="runtime-row">
            <span className="runtime-key">Write Strategy</span>
            <span className="runtime-value">{runtime?.workspace_write_strategy ?? "Loading..."}</span>
          </div>
        </div>

        <div className="sidebar-section grow">
          <div className="section-heading">
            <p className="section-label">Jobs</p>
            <span className="section-count">{jobs.length}</span>
          </div>

          <div className="job-list">
            {jobs.length === 0 ? (
              <div className="empty-card">No sessions yet.</div>
            ) : (
              jobs.map((job) => (
                <button
                  key={job.id}
                  className={`job-item ${job.id === selectedJobId ? "selected" : ""}`}
                  onClick={() => setSelectedJobId(job.id)}
                  type="button"
                >
                  <div className="job-item-meta">
                    <span className={`status-pill ${job.status}`}>{job.status}</span>
                    <span className={`mode-pill ${job.mode}`}>{job.mode}</span>
                  </div>
                  <p className="job-item-prompt">{summarizePrompt(job.prompt)}</p>
                  <div className="job-item-footer">
                    <span className="job-item-id">{job.id}</span>
                    <span className="job-item-time">{formatDate(job.updated_at)}</span>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        <div className="sidebar-section mode-list">
          <div className="section-heading">
            <p className="section-label">Modes</p>
          </div>
          {runtime?.modes.map((item) => (
            <div key={item.mode} className={`mode-card ${item.enabled ? "enabled" : "disabled"}`}>
              <div className="mode-card-top">
                <strong>{item.label}</strong>
                <span className={`mode-state ${item.enabled ? "enabled" : "disabled"}`}>
                  {item.enabled ? (item.dangerous ? "unsafe" : "ready") : "disabled"}
                </span>
              </div>
              <p>{item.description}</p>
              {item.reason ? <p className="mode-note">{item.reason}</p> : null}
            </div>
          ))}
        </div>
      </aside>

      <main className="workbench">
        <header className="title-bar">
          <div>
            <p className="section-label">Codex Web Runner</p>
            <h2>{selectedJob ? `Session ${selectedJob.id}` : "No session selected"}</h2>
          </div>
          <div className="title-bar-meta">
            {selectedJob ? <span className={`status-pill ${selectedJob.status}`}>{selectedJob.status}</span> : null}
            {selectedJob ? <span className={`mode-pill ${selectedJob.mode}`}>{selectedJob.mode}</span> : null}
            {selectedJobCapability?.dangerous ? <span className="danger-pill">full access</span> : null}
          </div>
        </header>

        <div className="workspace-grid">
          <section className="editor-surface">
            <div className="panel-heading">
              <div>
                <p className="section-label">Task</p>
                <h3>New Job</h3>
              </div>
              <div className="mode-selector-wrap">
                <label className="field-label" htmlFor="mode">
                  Mode
                </label>
                <select
                  id="mode"
                  className="mode-select"
                  value={mode}
                  onChange={(event) => setMode(event.target.value as JobMode)}
                >
                  {(runtime?.modes ?? []).map((item) => (
                    <option key={item.mode} value={item.mode} disabled={!item.enabled}>
                      {item.label}
                      {!item.enabled ? " (disabled)" : item.dangerous ? " (unsafe)" : ""}
                    </option>
                  ))}
                </select>
              </div>
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
                placeholder="Describe the task for Codex."
                rows={12}
              />

              <div className="composer-footer">
                <div className="mode-summary">
                  <strong>{selectedModeCapability?.label ?? "Loading mode..."}</strong>
                  <p>{selectedModeCapability?.description ?? "Fetching runtime capabilities."}</p>
                  {selectedModeCapability?.reason ? <p className="mode-note">{selectedModeCapability.reason}</p> : null}
                </div>

                <button
                  className="primary-button"
                  disabled={submitting || !prompt.trim() || !selectedModeCapability?.enabled}
                  type="submit"
                >
                  {submitting ? "Starting..." : "Run Job"}
                </button>
              </div>
            </form>

            {error ? <div className="error-banner">{error}</div> : null}

            <div className="detail-grid">
              <div className="detail-card">
                <p className="section-label">Session</p>
                <h3>{selectedJob?.id ?? "No session selected"}</h3>
                <p>Executor: {selectedJob?.executor ?? "pending"}</p>
                <p>Started: {formatDate(selectedJob?.started_at ?? null)}</p>
                <p>Finished: {formatDate(selectedJob?.finished_at ?? null)}</p>
              </div>

              <div className="detail-card">
                <p className="section-label">Workspace</p>
                <h3>Live Root</h3>
                <p>{runtime?.workspace_root ?? "Loading..."}</p>
                <p>Worker PID: {selectedJob?.worker_pid ?? "n/a"}</p>
                <p>Codex Bin: {runtime?.codex_bin ?? "Loading..."}</p>
              </div>

              <div className="detail-card">
                <p className="section-label">Changed Files</p>
                <h3>{selectedJob?.changed_files.length ? `${selectedJob.changed_files.length} file(s)` : "No file edits yet"}</h3>
                <div className="file-list">
                  {selectedJob?.changed_files.length ? (
                    selectedJob.changed_files.map((file) => (
                      <code key={file} className="file-chip">
                        {file}
                      </code>
                    ))
                  ) : (
                    <p>Read-only jobs stay empty here. Live write jobs will surface changed paths.</p>
                  )}
                </div>
              </div>
            </div>
          </section>

          <section className="panel-surface">
            <div className="panel-header">
              <div>
                <p className="section-label">Panel</p>
                <h3>Output</h3>
              </div>
              {selectedJob ? <span className="job-item-id">/{selectedJob.id}</span> : null}
            </div>

            <div className="panel-tabs">
              <button
                className={`panel-tab ${activePanel === "output" ? "active" : ""}`}
                onClick={() => setActivePanel("output")}
                type="button"
              >
                Response
              </button>
              <button
                className={`panel-tab ${activePanel === "logs" ? "active" : ""}`}
                onClick={() => setActivePanel("logs")}
                type="button"
              >
                Logs
              </button>
              <button
                className={`panel-tab ${activePanel === "events" ? "active" : ""}`}
                onClick={() => setActivePanel("events")}
                type="button"
              >
                Events
              </button>
            </div>

            <div className="panel-body">
              {activePanel === "output" ? (
                <>
                  <pre className="panel-output">
                    {selectedJob?.final_output ?? "Run a job to see the final assistant response here."}
                  </pre>
                  {selectedJob?.error ? <div className="error-inline">{selectedJob.error}</div> : null}
                </>
              ) : null}

              {activePanel === "logs" ? (
                <pre className="panel-output">{logs || "Select a session to stream its readable output log."}</pre>
              ) : null}

              {activePanel === "events" ? (
                <pre className="panel-output">{events || "Select a session to inspect raw Codex JSONL events."}</pre>
              ) : null}
            </div>
          </section>
        </div>

        <footer className="status-bar">
          <span>API: {API_BASE}</span>
          <span>Strategy: {runtime?.workspace_write_strategy ?? "loading"}</span>
          <span>Selected: {selectedJob?.id ?? "none"}</span>
        </footer>
      </main>
    </div>
  );
}
