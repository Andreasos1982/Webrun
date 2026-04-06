import {
  startTransition,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";

import {
  API_BASE,
  appendMessage,
  createJob,
  fetchEvents,
  fetchJob,
  fetchLogs,
  fetchRuntime,
  listJobs,
} from "./api";
import type {
  ConversationMessage,
  JobMode,
  JobRecord,
  ModeCapability,
  ReasoningEffort,
  RuntimeInfo,
} from "./types";


type PanelTab = "logs" | "events" | "details";


function formatDate(value: string | null): string {
  if (!value) {
    return "n/a";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}


function summarizeText(value: string, maxLength = 76): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }
  return `${singleLine.slice(0, maxLength - 3)}...`;
}


function getModeCapability(runtime: RuntimeInfo | null, mode: JobMode): ModeCapability | null {
  return runtime?.modes.find((item) => item.mode === mode) ?? null;
}


function getAccessLabel(capability: ModeCapability | null): string {
  if (!capability) {
    return "Zugriff";
  }
  if (capability.mode === "read-only") {
    return "Mit Beschrankungen";
  }
  return capability.dangerous ? "Vollzugriff" : "Workspace schreiben";
}


function getAccessDescription(capability: ModeCapability | null): string {
  if (!capability) {
    return "Lade Zugriffseinstellungen.";
  }
  if (capability.mode === "read-only") {
    return "Codex bleibt konsultativ und arbeitet auf einem bounded Snapshot.";
  }
  if (capability.dangerous) {
    return "Codex arbeitet mit vollem Host-Zugriff, weil der native Workspace-Sandboxpfad auf diesem VPS nicht sauber verfugbar ist.";
  }
  return "Codex darf den Workspace lesen und gezielt bearbeiten.";
}


function lastMeaningfulMessage(job: JobRecord): ConversationMessage | null {
  return job.messages[job.messages.length - 1] ?? null;
}


function messageRoleLabel(role: ConversationMessage["role"]): string {
  return role === "user" ? "Du" : "Codex";
}


function panelTitle(tab: PanelTab): string {
  if (tab === "logs") {
    return "Logs";
  }
  if (tab === "events") {
    return "Events";
  }
  return "Details";
}


export default function App() {
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<JobMode>("read-only");
  const [model, setModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>("xhigh");
  const [logs, setLogs] = useState("");
  const [events, setEvents] = useState("");
  const [activePanel, setActivePanel] = useState<PanelTab>("details");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preserveNullSelectionRef = useRef(false);
  const messagesRef = useRef<HTMLDivElement | null>(null);

  const selectedJob = jobs.find((job) => job.id === selectedJobId) ?? null;
  const selectedModeCapability = getModeCapability(runtime, mode);
  const selectedJobCapability = selectedJob ? getModeCapability(runtime, selectedJob.mode) : null;
  const canSubmit = Boolean(prompt.trim() && model && selectedModeCapability?.enabled && !selectedJob?.status.match(/queued|running/));

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
          setModel((current) => current || response.default_model);
          setReasoningEffort(response.default_reasoning_effort);
          setMode((current) => {
            const currentModeAvailable = response.modes.some((item) => item.mode === current && item.enabled);
            if (currentModeAvailable) {
              return current;
            }
            return response.modes.find((item) => item.enabled)?.mode ?? "read-only";
          });
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
            if (current === null && preserveNullSelectionRef.current) {
              return null;
            }
            return response.jobs[0]?.id ?? null;
          });
        });
      } catch (requestError) {
        if (!cancelled) {
          setError(requestError instanceof Error ? requestError.message : "Unable to load sessions.");
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
          setError(requestError instanceof Error ? requestError.message : "Unable to refresh the selected session.");
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

        eventsTimeoutId = window.setTimeout(pollEvents, response.complete ? 4000 : 1400);
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

  useEffect(() => {
    if (selectedJob) {
      setMode(selectedJob.mode);
      setModel(selectedJob.model);
      setReasoningEffort(selectedJob.reasoning_effort);
      return;
    }

    if (runtime) {
      setMode(runtime.modes.find((item) => item.enabled)?.mode ?? "read-only");
      setModel(runtime.default_model);
      setReasoningEffort(runtime.default_reasoning_effort);
    }
  }, [selectedJobId, runtime]);

  useEffect(() => {
    const element = messagesRef.current;
    if (!element) {
      return;
    }

    element.scrollTo({
      top: element.scrollHeight,
      behavior: "smooth",
    });
  }, [selectedJob?.messages.length, selectedJob?.status]);

  function handleSelectJob(jobId: string) {
    preserveNullSelectionRef.current = false;
    setSelectedJobId(jobId);
    setError(null);
  }

  function handleNewChat() {
    preserveNullSelectionRef.current = true;
    setSelectedJobId(null);
    setPrompt("");
    setError(null);
    if (runtime) {
      setMode(runtime.modes.find((item) => item.enabled)?.mode ?? "read-only");
      setModel(runtime.default_model);
      setReasoningEffort(runtime.default_reasoning_effort);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    const payload = {
      prompt,
      mode,
      model,
      reasoning_effort: reasoningEffort,
    };

    try {
      const job = selectedJob
        ? await appendMessage(selectedJob.id, payload)
        : await createJob(payload);

      preserveNullSelectionRef.current = false;
      startTransition(() => {
        setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
        setSelectedJobId(job.id);
        setPrompt("");
        setActivePanel("logs");
      });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to send the message.");
    } finally {
      setSubmitting(false);
    }
  }

  const currentPreviewMessage = selectedJob ? lastMeaningfulMessage(selectedJob) : null;

  return (
    <div className="app-shell">
      <aside className="activity-bar">
        <div className="activity-brand">WR</div>
        <button className="activity-button active" type="button">
          Codex
        </button>
        <button className="activity-button" type="button">
          Chat
        </button>
        <button className="activity-button" type="button">
          Logs
        </button>
      </aside>

      <aside className="sidebar">
        <div className="sidebar-section">
          <div className="section-heading">
            <div>
              <p className="section-label">Explorer</p>
              <h1>Sessions</h1>
            </div>
            <button className="ghost-button" onClick={handleNewChat} type="button">
              Neuer Chat
            </button>
          </div>
          <p className="sidebar-copy">
            Chat-first Codex sessions mit persistenten Logs und wiederaufrufbaren Runs unter <code>data/jobs</code>.
          </p>
        </div>

        <div className="runtime-card">
          <div className="runtime-row">
            <span className="runtime-key">Workspace</span>
            <span className="runtime-value">{runtime?.workspace_root ?? "Loading..."}</span>
          </div>
          <div className="runtime-row">
            <span className="runtime-key">Modell</span>
            <span className="runtime-value">{runtime?.default_model ?? "Loading..."}</span>
          </div>
          <div className="runtime-row">
            <span className="runtime-key">Write Strategy</span>
            <span className="runtime-value">{runtime?.workspace_write_strategy ?? "Loading..."}</span>
          </div>
        </div>

        <div className="sidebar-section grow">
          <div className="section-heading">
            <p className="section-label">Chats</p>
            <span className="section-count">{jobs.length}</span>
          </div>

          <div className="job-list">
            {jobs.length === 0 ? (
              <div className="empty-card">Noch keine Session vorhanden.</div>
            ) : (
              jobs.map((job) => {
                const capability = getModeCapability(runtime, job.mode);
                const lastMessage = lastMeaningfulMessage(job);

                return (
                  <button
                    key={job.id}
                    className={`job-item ${job.id === selectedJobId ? "selected" : ""}`}
                    onClick={() => handleSelectJob(job.id)}
                    type="button"
                  >
                    <div className="job-item-meta">
                      <span className={`status-pill ${job.status}`}>{job.status}</span>
                      <span className={`mode-pill ${job.mode}`}>{getAccessLabel(capability)}</span>
                    </div>
                    <p className="job-item-title">{job.title}</p>
                    <p className="job-item-prompt">{summarizeText(lastMessage?.content ?? job.prompt, 88)}</p>
                    <div className="job-item-footer">
                      <span className="job-item-id">{job.turn_count} Turns</span>
                      <span className="job-item-time">{formatDate(job.updated_at)}</span>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        <div className="sidebar-section mode-list">
          <div className="section-heading">
            <p className="section-label">Access</p>
          </div>
          {(runtime?.modes ?? []).map((item) => (
            <div key={item.mode} className={`mode-card ${item.enabled ? "enabled" : "disabled"}`}>
              <div className="mode-card-top">
                <strong>{getAccessLabel(item)}</strong>
                <span className={`mode-state ${item.enabled ? "enabled" : "disabled"}`}>
                  {item.enabled ? (item.dangerous ? "riskant" : "bereit") : "deaktiviert"}
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
            <p className="section-label">Codex Session</p>
            <h2>{selectedJob ? selectedJob.title : "Neuer Chat"}</h2>
            <p className="title-copy">
              {selectedJob
                ? `Thread ${selectedJob.turn_count} · ${selectedJob.model} · ${selectedJob.reasoning_effort}`
                : "Starte eine neue Unterhaltung mit Codex und verfolge die Turns im Verlauf."}
            </p>
          </div>
          <div className="title-bar-meta">
            {selectedJob ? <span className={`status-pill ${selectedJob.status}`}>{selectedJob.status}</span> : null}
            <span className={`mode-pill ${mode}`}>{getAccessLabel(selectedJobCapability ?? selectedModeCapability)}</span>
            {selectedJobCapability?.dangerous ? <span className="danger-pill">volles system</span> : null}
          </div>
        </header>

        <div className="workspace-grid chat-layout">
          <section className="chat-surface">
            <div className="chat-header">
              <div>
                <p className="section-label">Chat</p>
                <h3>{selectedJob ? "Unterhaltung" : "Codex Panel"}</h3>
              </div>
              {selectedJob ? <span className="job-item-id">/{selectedJob.id}</span> : null}
            </div>

            <div className="chat-thread" ref={messagesRef}>
              {selectedJob ? (
                <>
                  {selectedJob.messages.map((message) => {
                    const capability = getModeCapability(runtime, message.mode ?? "read-only");

                    return (
                      <article key={message.id} className={`message-card ${message.role}`}>
                        <div className="message-meta">
                          <strong>{messageRoleLabel(message.role)}</strong>
                          <span>{formatDate(message.created_at)}</span>
                        </div>
                        <div className="message-flags">
                          {message.model ? <span className="message-chip">{message.model}</span> : null}
                          {message.reasoning_effort ? (
                            <span className="message-chip">{message.reasoning_effort}</span>
                          ) : null}
                          <span className="message-chip">{getAccessLabel(capability)}</span>
                          <span className="message-chip">Turn {message.turn}</span>
                        </div>
                        <div className="message-body">{message.content}</div>
                      </article>
                    );
                  })}

                  {selectedJob.status === "queued" || selectedJob.status === "running" ? (
                    <article className="message-card assistant pending">
                      <div className="message-meta">
                        <strong>Codex</strong>
                        <span>arbeitet gerade</span>
                      </div>
                      <div className="message-flags">
                        <span className="message-chip">laufender Turn</span>
                      </div>
                      <div className="message-body typing-indicator">Antwort wird generiert...</div>
                    </article>
                  ) : null}
                </>
              ) : (
                <div className="chat-empty-state">
                  <div className="empty-mark">C</div>
                  <h3>Codex Chat starten</h3>
                  <p>
                    Die offizielle Codex IDE arbeitet thread-basiert mit Chat-Verlauf, Modellwahl,
                    Reasoning-Stufe und Zugriffsmodus. Dieses Panel bildet genau diese Kernelemente jetzt im Web nach.
                  </p>
                  <div className="empty-pills">
                    <span className="message-chip">Model picker</span>
                    <span className="message-chip">Denkaufwand</span>
                    <span className="message-chip">Mit Beschrankungen / Vollzugriff</span>
                    <span className="message-chip">/status</span>
                    <span className="message-chip">/review</span>
                  </div>
                </div>
              )}
            </div>

            {selectedJob?.error ? <div className="error-banner">{selectedJob.error}</div> : null}

            <form className="composer-card" onSubmit={handleSubmit}>
              <div className="composer-toolbar">
                <div className="control-group">
                  <label className="field-label" htmlFor="model">
                    Modell
                  </label>
                  <select
                    id="model"
                    className="mode-select"
                    onChange={(event) => setModel(event.target.value)}
                    value={model}
                  >
                    {(runtime?.available_models ?? []).map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.label}
                        {item.recommended ? " · empfohlen" : ""}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="control-group">
                  <label className="field-label" htmlFor="reasoning">
                    Denkaufwand
                  </label>
                  <select
                    id="reasoning"
                    className="mode-select"
                    onChange={(event) => setReasoningEffort(event.target.value as ReasoningEffort)}
                    value={reasoningEffort}
                  >
                    {(runtime?.reasoning_efforts ?? []).map((item) => (
                      <option key={item.value} value={item.value}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="control-group">
                  <label className="field-label" htmlFor="mode">
                    Zugriff
                  </label>
                  <select
                    id="mode"
                    className="mode-select"
                    onChange={(event) => setMode(event.target.value as JobMode)}
                    value={mode}
                  >
                    {(runtime?.modes ?? []).map((item) => (
                      <option key={item.mode} disabled={!item.enabled} value={item.mode}>
                        {getAccessLabel(item)}
                        {!item.enabled ? " · deaktiviert" : item.dangerous ? " · riskant" : ""}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <label className="composer-field" htmlFor="prompt">
                <span className="field-label">{selectedJob ? "Nachricht" : "Neuer Prompt"}</span>
                <textarea
                  id="prompt"
                  className="prompt-editor chat-input"
                  onChange={(event) => setPrompt(event.target.value)}
                  placeholder={
                    selectedJob
                      ? "Schreibe die nachste Nachricht fur diese Session."
                      : "Beschreibe die Aufgabe fur Codex."
                  }
                  rows={5}
                  value={prompt}
                />
              </label>

              <div className="composer-footer">
                <div className="mode-summary">
                  <strong>{getAccessLabel(selectedModeCapability)}</strong>
                  <p>{getAccessDescription(selectedModeCapability)}</p>
                  {selectedModeCapability?.reason ? (
                    <p className="mode-note">{selectedModeCapability.reason}</p>
                  ) : null}
                </div>

                <button className="primary-button" disabled={submitting || !canSubmit} type="submit">
                  {submitting ? "Sende..." : selectedJob ? "Nachricht senden" : "Chat starten"}
                </button>
              </div>

              {error ? <div className="error-banner">{error}</div> : null}
            </form>
          </section>

          <aside className="inspector-surface">
            <div className="panel-heading">
              <div>
                <p className="section-label">Inspector</p>
                <h3>Session Info</h3>
              </div>
            </div>

            <div className="detail-stack">
              <div className="detail-card">
                <p className="section-label">Aktiv</p>
                <h3>{selectedJob ? selectedJob.title : "Noch keine Session"}</h3>
                <p>Status: {selectedJob?.status ?? "neu"}</p>
                <p>Turns: {selectedJob?.turn_count ?? 0}</p>
                <p>Zuletzt: {formatDate(selectedJob?.updated_at ?? null)}</p>
              </div>

              <div className="detail-card">
                <p className="section-label">Runtime</p>
                <h3>{model || runtime?.default_model || "Loading..."}</h3>
                <p>Denkaufwand: {reasoningEffort}</p>
                <p>Codex Bin: {runtime?.codex_bin ?? "Loading..."}</p>
                <p>Workspace: {runtime?.workspace_root ?? "Loading..."}</p>
              </div>

              <div className="detail-card">
                <p className="section-label">Letzte Nachricht</p>
                <h3>{currentPreviewMessage ? messageRoleLabel(currentPreviewMessage.role) : "Warte auf Prompt"}</h3>
                <p>{currentPreviewMessage ? summarizeText(currentPreviewMessage.content, 140) : "Noch keine Unterhaltung."}</p>
              </div>
            </div>
          </aside>
        </div>

        <section className="panel-surface">
          <div className="panel-header">
            <div>
              <p className="section-label">Panel</p>
              <h3>{panelTitle(activePanel)}</h3>
            </div>
            {selectedJob ? <span className="job-item-id">/{selectedJob.id}</span> : null}
          </div>

          <div className="panel-tabs">
            <button
              className={`panel-tab ${activePanel === "details" ? "active" : ""}`}
              onClick={() => setActivePanel("details")}
              type="button"
            >
              Details
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
            {activePanel === "details" ? (
              <div className="panel-detail-grid">
                <div className="detail-card">
                  <p className="section-label">Thread</p>
                  <h3>{selectedJob?.thread_id ?? "noch kein Codex thread"}</h3>
                  <p>Executor: {selectedJob?.executor ?? "pending"}</p>
                  <p>Worker PID: {selectedJob?.worker_pid ?? "n/a"}</p>
                  <p>Return Code: {selectedJob?.return_code ?? "n/a"}</p>
                </div>

                <div className="detail-card">
                  <p className="section-label">Command</p>
                  <h3>{selectedJob?.command.length ? "Aktueller Launch" : "Noch kein Start"}</h3>
                  <pre className="inline-code-block">
                    {selectedJob?.command.length ? selectedJob.command.join(" ") : "Run a session to inspect the launch command."}
                  </pre>
                </div>

                <div className="detail-card">
                  <p className="section-label">Changed Files</p>
                  <h3>
                    {selectedJob?.changed_files.length
                      ? `${selectedJob.changed_files.length} Datei(en)`
                      : "Noch keine Dateiausgabe"}
                  </h3>
                  <div className="file-list">
                    {selectedJob?.changed_files.length ? (
                      selectedJob.changed_files.map((file) => (
                        <code key={file} className="file-chip">
                          {file}
                        </code>
                      ))
                    ) : (
                      <p>Read-only Sessions bleiben hier leer. Live-Write-Turns zeigen geanderte Pfade an.</p>
                    )}
                  </div>
                </div>
              </div>
            ) : null}

            {activePanel === "logs" ? (
              <pre className="panel-output">{logs || "Waehle eine Session, um den persistierten Runner-Log zu sehen."}</pre>
            ) : null}

            {activePanel === "events" ? (
              <pre className="panel-output">{events || "Waehle eine Session, um den rohen Codex-Event-Stream zu sehen."}</pre>
            ) : null}
          </div>
        </section>

        <footer className="status-bar">
          <span>{selectedJob ? "Lokal" : "Neuer Chat"}</span>
          <span>{getAccessLabel(selectedJobCapability ?? selectedModeCapability)}</span>
          <span>{model || runtime?.default_model || "model"}</span>
          <span>{reasoningEffort}</span>
          <span>{API_BASE}</span>
        </footer>
      </main>
    </div>
  );
}
