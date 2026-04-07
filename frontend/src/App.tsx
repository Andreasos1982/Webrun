import {
  startTransition,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";

import {
  appendMessage,
  cancelJob,
  createJob,
  fetchCodexHistoryThread,
  fetchEvents,
  fetchFolders,
  fetchJob,
  fetchLogs,
  fetchRuntime,
  jobStreamUrl,
  listCodexHistory,
  listJobs,
} from "./api";
import type {
  ConversationMessage,
  CodexHistoryMessage,
  CodexHistoryThreadDetail,
  CodexHistoryThreadSummary,
  FolderBrowserResponse,
  JobMode,
  JobRecord,
  JobStatus,
  ModeCapability,
  ReasoningEffort,
  RuntimeInfo,
} from "./types";

type PanelTab = "logs" | "events" | "details";
type StreamState = "idle" | "connecting" | "live" | "polling";
type SelectionKind = "new" | "job" | "history";
type TranscriptMessage = ConversationMessage | CodexHistoryMessage;
type StreamMessage =
  | { type: "snapshot"; job: JobRecord; logs: string; events: string }
  | { type: "job"; job: JobRecord }
  | { type: "logs"; chunk: string }
  | { type: "events"; chunk: string }
  | { type: "heartbeat" };

const QUICK_ACTIONS = [
  { label: "/status", prompt: "/status" },
  {
    label: "/review",
    prompt: "/review Review the current changes and call out behavioral risks and missing tests.",
  },
  { label: "/local", prompt: "/local" },
  { label: "/cloud", prompt: "/cloud" },
] as const;

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

function sortJobs(jobs: JobRecord[]): JobRecord[] {
  return [...jobs].sort(
    (left, right) =>
      new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime(),
  );
}

function mergeJob(current: JobRecord[], nextJob: JobRecord): JobRecord[] {
  const next = current.filter((job) => job.id !== nextJob.id);
  next.push(nextJob);
  return sortJobs(next);
}

function getModeCapability(
  runtime: RuntimeInfo | null,
  mode: JobMode,
): ModeCapability | null {
  return runtime?.modes.find((item) => item.mode === mode) ?? null;
}

function getAccessLabel(capability: ModeCapability | null): string {
  if (!capability) {
    return "Zugriff";
  }
  if (capability.mode === "read-only") {
    return "Mit Beschrankungen";
  }
  return capability.dangerous ? "Vollzugriff" : "Agent";
}

function getAccessDescription(capability: ModeCapability | null): string {
  if (!capability) {
    return "Lade Zugriffseinstellungen.";
  }
  if (capability.mode === "read-only") {
    return "Codex bleibt im Chat-/Planungsmodus und arbeitet auf einem bounded Snapshot statt direkt im Workspace.";
  }
  if (capability.dangerous) {
    return "Vollzugriff: Codex arbeitet mit vollem Host-Zugriff, weil der native Workspace-Sandboxpfad auf diesem VPS nicht sauber verfugbar ist.";
  }
  return "Agent-Modus: Codex darf den Workspace lesen, bearbeiten und lokale Kommandos im offenen Projektkontext ausfuhren.";
}

function isBusy(status: JobStatus): boolean {
  return status === "queued" || status === "running";
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

function streamLabel(state: StreamState): string {
  if (state === "connecting") {
    return "Verbinde";
  }
  if (state === "live") {
    return "Live";
  }
  if (state === "polling") {
    return "Polling";
  }
  return "Idle";
}

function latestTranscriptAssistantMessage(
  messages: TranscriptMessage[],
): TranscriptMessage | null {
  return [...messages].reverse().find((message) => message.role === "assistant") ?? null;
}

function isConversationMessage(
  message: TranscriptMessage,
): message is ConversationMessage {
  return "created_at" in message;
}

function shortThreadId(threadId: string | null): string {
  if (!threadId) {
    return "Kein nativer Thread";
  }
  if (threadId.length <= 16) {
    return threadId;
  }
  return `${threadId.slice(0, 8)}...${threadId.slice(-6)}`;
}

function historySourceLabel(source: string): string {
  if (source === "vscode") {
    return "VS Code";
  }
  if (source === "cli") {
    return "CLI";
  }
  if (source === "chatgpt") {
    return "ChatGPT";
  }
  return source;
}

export default function App() {
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [historyThreads, setHistoryThreads] = useState<CodexHistoryThreadSummary[]>([]);
  const [historyDetail, setHistoryDetail] = useState<CodexHistoryThreadDetail | null>(null);
  const [selectionKind, setSelectionKind] = useState<SelectionKind>("new");
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [selectedHistoryThreadId, setSelectedHistoryThreadId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<JobMode>("read-only");
  const [model, setModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>("xhigh");
  const [openFolder, setOpenFolder] = useState(".");
  const [limitToOpenFolder, setLimitToOpenFolder] = useState(false);
  const [logs, setLogs] = useState("");
  const [events, setEvents] = useState("");
  const [activePanel, setActivePanel] = useState<PanelTab>("details");
  const [streamState, setStreamState] = useState<StreamState>("idle");
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [folderBrowser, setFolderBrowser] = useState<FolderBrowserResponse | null>(null);
  const [folderLoading, setFolderLoading] = useState(false);
  const [folderError, setFolderError] = useState<string | null>(null);
  const preserveNullSelectionRef = useRef(false);
  const seededJobIdRef = useRef<string | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);

  const selectedJob =
    selectionKind === "job"
      ? jobs.find((job) => job.id === selectedJobId) ?? null
      : null;
  const selectedHistorySummary =
    selectionKind === "history"
      ? historyThreads.find((thread) => thread.id === selectedHistoryThreadId) ??
        (historyDetail?.thread.id === selectedHistoryThreadId ? historyDetail.thread : null)
      : null;
  const selectedHistory =
    selectionKind === "history" &&
    historyDetail?.thread.id === selectedHistoryThreadId
      ? historyDetail
      : null;
  const selectedTranscriptMessages = selectedJob?.messages ?? selectedHistory?.messages ?? [];
  const selectedModeCapability = getModeCapability(runtime, mode);
  const selectedJobCapability = selectedJob
    ? getModeCapability(runtime, selectedJob.mode)
    : null;
  const selectedJobBusy = selectedJob ? isBusy(selectedJob.status) : false;
  const latestAssistant = latestTranscriptAssistantMessage(selectedTranscriptMessages);
  const activeJobId = selectionKind === "job" ? selectedJobId : null;
  const canSubmit =
    Boolean(prompt.trim()) &&
    Boolean(model) &&
    Boolean(selectedModeCapability?.enabled) &&
    selectionKind !== "history" &&
    !selectedJobBusy &&
    !submitting;
  const selectedTitle =
    selectedHistorySummary?.name ??
    selectedJob?.title ??
    "New Codex session";
  const selectedSubtitle = selectedHistorySummary
    ? `${selectedTranscriptMessages.length} messages • ${historySourceLabel(selectedHistorySummary.source)} history`
    : selectedJob
      ? `${selectedJob.messages.length} messages • ${selectedJob.turn_count} turns`
      : "Alternating user and Codex messages stay visible here.";

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
            const currentModeAvailable = response.modes.some(
              (item) => item.mode === current && item.enabled,
            );
            if (currentModeAvailable) {
              return current;
            }
            return response.modes.find((item) => item.enabled)?.mode ?? "read-only";
          });
        });
      } catch (requestError) {
        if (!cancelled) {
          setError(
            requestError instanceof Error
              ? requestError.message
              : "Unable to load runtime info.",
          );
        }
      }
    }

    void loadRuntime();

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
          setJobs(sortJobs(response.jobs));
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
          setError(
            requestError instanceof Error
              ? requestError.message
              : "Unable to load sessions.",
          );
        }
      }
    }

    void refreshJobs();
    const intervalId = window.setInterval(() => {
      void refreshJobs();
    }, 3000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function refreshHistory() {
      try {
        const response = await listCodexHistory(50);
        if (cancelled) {
          return;
        }

        startTransition(() => {
          setHistoryThreads(response.threads);
        });
        setHistoryError(null);
      } catch (requestError) {
        if (!cancelled) {
          setHistoryError(
            requestError instanceof Error
              ? requestError.message
              : "Unable to load Codex history.",
          );
        }
      }
    }

    void refreshHistory();
    const intervalId = window.setInterval(() => {
      void refreshHistory();
    }, 20000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    if (!selectedJob) {
      return;
    }
    if (seededJobIdRef.current === selectedJob.id) {
      return;
    }

    seededJobIdRef.current = selectedJob.id;
    startTransition(() => {
      setMode(selectedJob.mode);
      setModel(selectedJob.model);
      setReasoningEffort(selectedJob.reasoning_effort);
      setOpenFolder(selectedJob.open_folder || ".");
      setLimitToOpenFolder(selectedJob.limit_to_open_folder);
    });
  }, [selectedJob]);

  useEffect(() => {
    if (selectionKind !== "history" || !selectedHistoryThreadId) {
      return;
    }

    const threadId = selectedHistoryThreadId;
    let cancelled = false;
    setHistoryLoading(true);

    async function loadHistoryDetail() {
      try {
        const response = await fetchCodexHistoryThread(threadId);
        if (cancelled) {
          return;
        }

        startTransition(() => {
          setHistoryDetail(response);
        });
        setHistoryError(null);
      } catch (requestError) {
        if (!cancelled) {
          setHistoryError(
            requestError instanceof Error
              ? requestError.message
              : "Unable to load the selected Codex thread.",
          );
        }
      } finally {
        if (!cancelled) {
          setHistoryLoading(false);
        }
      }
    }

    void loadHistoryDetail();

    return () => {
      cancelled = true;
    };
  }, [selectionKind, selectedHistoryThreadId]);

  useEffect(() => {
    if (!activeJobId) {
      setLogs("");
      setEvents("");
      setStreamState("idle");
      return;
    }

    let cancelled = false;
    let websocket: WebSocket | null = null;
    let pollingStarted = false;
    let jobTimer: number | null = null;
    let logsTimer: number | null = null;
    let eventsTimer: number | null = null;
    let logsOffset = 0;
    let eventsOffset = 0;

    const syncJob = (job: JobRecord) => {
      startTransition(() => {
        setJobs((current) => mergeJob(current, job));
      });
    };

    const stopTimers = () => {
      if (jobTimer !== null) {
        window.clearTimeout(jobTimer);
      }
      if (logsTimer !== null) {
        window.clearTimeout(logsTimer);
      }
      if (eventsTimer !== null) {
        window.clearTimeout(eventsTimer);
      }
    };

    const startPolling = () => {
      if (pollingStarted || cancelled) {
        return;
      }
      pollingStarted = true;
      setStreamState("polling");

      const pollJob = async () => {
        if (cancelled) {
          return;
        }
        try {
          const job = await fetchJob(activeJobId);
          if (cancelled) {
            return;
          }
          syncJob(job);
        } catch (requestError) {
          if (!cancelled) {
            setError(
              requestError instanceof Error
                ? requestError.message
                : "Unable to refresh the selected session.",
            );
          }
        } finally {
          if (!cancelled) {
            jobTimer = window.setTimeout(() => {
              void pollJob();
            }, 1500);
          }
        }
      };

      const pollLogs = async () => {
        if (cancelled) {
          return;
        }
        try {
          const response = await fetchLogs(activeJobId, logsOffset);
          if (cancelled) {
            return;
          }
          if (response.chunk) {
            logsOffset = response.next_offset;
            setLogs((current) => current + response.chunk);
          }
        } catch (requestError) {
          if (!cancelled) {
            setError(
              requestError instanceof Error
                ? requestError.message
                : "Unable to stream logs.",
            );
          }
        } finally {
          if (!cancelled) {
            logsTimer = window.setTimeout(() => {
              void pollLogs();
            }, 900);
          }
        }
      };

      const pollEvents = async () => {
        if (cancelled) {
          return;
        }
        try {
          const response = await fetchEvents(activeJobId, eventsOffset);
          if (cancelled) {
            return;
          }
          if (response.chunk) {
            eventsOffset = response.next_offset;
            setEvents((current) => current + response.chunk);
          }
        } catch (requestError) {
          if (!cancelled) {
            setError(
              requestError instanceof Error
                ? requestError.message
                : "Unable to stream events.",
            );
          }
        } finally {
          if (!cancelled) {
            eventsTimer = window.setTimeout(() => {
              void pollEvents();
            }, 1000);
          }
        }
      };

      void pollJob();
      void pollLogs();
      void pollEvents();
    };

    setLogs("");
    setEvents("");

    if (!runtime?.supports_websocket_streams) {
      startPolling();
      return () => {
        cancelled = true;
        stopTimers();
      };
    }

    setStreamState("connecting");

    try {
      websocket = new WebSocket(jobStreamUrl(activeJobId));
    } catch {
      startPolling();
      return () => {
        cancelled = true;
        stopTimers();
      };
    }

    websocket.onopen = () => {
      if (!cancelled) {
        setStreamState("live");
      }
    };

    websocket.onmessage = (event) => {
      if (cancelled) {
        return;
      }

      try {
        const message = JSON.parse(event.data) as StreamMessage;
        if (message.type === "snapshot") {
          syncJob(message.job);
          setLogs(message.logs);
          setEvents(message.events);
          return;
        }
        if (message.type === "job") {
          syncJob(message.job);
          return;
        }
        if (message.type === "logs") {
          setLogs((current) => current + message.chunk);
          return;
        }
        if (message.type === "events") {
          setEvents((current) => current + message.chunk);
        }
      } catch {
        setError("Unable to decode the live stream payload.");
      }
    };

    websocket.onerror = () => {
      if (!cancelled) {
        websocket?.close();
      }
    };

    websocket.onclose = () => {
      if (!cancelled) {
        startPolling();
      }
    };

    return () => {
      cancelled = true;
      stopTimers();
      websocket?.close();
    };
  }, [activeJobId, runtime?.supports_websocket_streams]);

  useEffect(() => {
    if (!messagesRef.current) {
      return;
    }
    messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
  }, [selectionKind, selectedHistory?.messages.length, selectedJobId, selectedJob?.messages.length]);

  async function loadFolderBrowser(path: string) {
    setFolderLoading(true);
    setFolderError(null);

    try {
      const response = await fetchFolders(path);
      startTransition(() => {
        setFolderBrowser(response);
      });
    } catch (requestError) {
      setFolderError(
        requestError instanceof Error
          ? requestError.message
          : "Unable to browse folders.",
      );
    } finally {
      setFolderLoading(false);
    }
  }

  function handleNewChat() {
    preserveNullSelectionRef.current = true;
    seededJobIdRef.current = "__new__";
    setSelectionKind("new");
    setSelectedJobId(null);
    setSelectedHistoryThreadId(null);
    setPrompt("");
    setError(null);
    setHistoryError(null);
    setActivePanel("details");
    setLogs("");
    setEvents("");
    setStreamState("idle");
    setOpenFolder(".");
    setLimitToOpenFolder(false);
    if (runtime) {
      setModel(runtime.default_model);
      setReasoningEffort(runtime.default_reasoning_effort);
      setMode(runtime.modes.find((item) => item.enabled)?.mode ?? "read-only");
    }
    promptRef.current?.focus();
  }

  function handleSelectJob(jobId: string) {
    preserveNullSelectionRef.current = false;
    setSelectionKind("job");
    setSelectedJobId(jobId);
    setActivePanel("details");
    setError(null);
  }

  function handleSelectHistory(threadId: string) {
    setSelectionKind("history");
    setSelectedHistoryThreadId(threadId);
    setActivePanel("details");
    setError(null);
    setHistoryError(null);
    setLogs("");
    setEvents("");
    setStreamState("idle");
  }

  async function openFolderDialog() {
    setFolderDialogOpen(true);
    await loadFolderBrowser(openFolder);
  }

  function chooseFolder(path: string) {
    setOpenFolder(path);
    setFolderDialogOpen(false);
    setFolderError(null);
  }

  async function submitPrompt(overridePrompt?: string) {
    const nextPrompt = (overridePrompt ?? prompt).trim();
    if (!nextPrompt || !selectedModeCapability?.enabled || submitting) {
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const payload = {
        prompt: nextPrompt,
        mode,
        model,
        reasoning_effort: reasoningEffort,
        open_folder: openFolder,
        limit_to_open_folder: limitToOpenFolder,
      };

      const job = selectedJob
        ? await appendMessage(selectedJob.id, payload)
        : await createJob(payload);

      preserveNullSelectionRef.current = false;
      seededJobIdRef.current = job.id;

      startTransition(() => {
        setSelectionKind("job");
        setJobs((current) => mergeJob(current, job));
        setSelectedJobId(job.id);
        setActivePanel("logs");
        if (!overridePrompt) {
          setPrompt("");
        } else if (prompt.trim() === nextPrompt) {
          setPrompt("");
        }
      });
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Unable to start the session.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await submitPrompt();
  }

  async function handleCancel() {
    if (!selectedJob || cancelling) {
      return;
    }

    setCancelling(true);
    setError(null);

    try {
      const job = await cancelJob(selectedJob.id);
      startTransition(() => {
        setJobs((current) => mergeJob(current, job));
        setActivePanel("logs");
      });
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Unable to cancel the session.",
      );
    } finally {
      setCancelling(false);
    }
  }

  return (
    <>
      <div className="app-shell">
        <aside className="activity-bar">
          <div className="activity-brand">WR</div>
          <button className="activity-button active" type="button">
            C
          </button>
          <button className="activity-button" type="button">
            J
          </button>
          <button className="activity-button" type="button">
            L
          </button>
        </aside>

        <aside className="sidebar">
          <section className="sidebar-section">
            <p className="section-label">Codex</p>
            <div className="section-heading">
              <h1>WebRun</h1>
              <button className="primary-button" type="button" onClick={handleNewChat}>
                New Chat
              </button>
            </div>
            <p className="sidebar-copy">
              VPS runner with native Codex threads, persistent logs, live streaming,
              and scoped folder execution.
            </p>
          </section>

          <section className="sidebar-section">
            <div className="runtime-card">
              <div className="runtime-row">
                <span className="runtime-key">Workspace</span>
                <p className="runtime-value">
                  {runtime?.workspace_root ?? "Loading runtime..."}
                </p>
              </div>
              <div className="runtime-row">
                <span className="runtime-key">Live transport</span>
                <p className="runtime-value">
                  {runtime?.supports_websocket_streams ? "WebSocket stream" : "HTTP polling"}
                </p>
              </div>
              <div className="runtime-row">
                <span className="runtime-key">Native threads</span>
                <p className="runtime-value">
                  {runtime?.supports_native_thread_resume ? "Enabled" : "Unavailable"}
                </p>
              </div>
              <div className="runtime-row">
                <span className="runtime-key">Write strategy</span>
                <p className="runtime-value">
                  {runtime?.workspace_write_strategy ?? "Loading..."}
                </p>
              </div>
            </div>
          </section>

          <section className="sidebar-section grow">
            <div className="section-heading">
              <div>
                <p className="section-label">Sessions</p>
                <h2>WebRun Chats</h2>
              </div>
              <span className="section-count">{jobs.length}</span>
            </div>

            <div className="job-list">
              {jobs.map((job) => {
                const lastMessage = job.messages[job.messages.length - 1];
                return (
                  <button
                    key={job.id}
                    className={`job-item ${job.id === selectedJobId ? "selected" : ""}`}
                    type="button"
                    onClick={() => handleSelectJob(job.id)}
                  >
                    <div className="job-item-meta">
                      <span className={`status-pill ${job.status}`}>{job.status}</span>
                      <span className={`mode-pill ${job.mode}`}>{getAccessLabel(getModeCapability(runtime, job.mode))}</span>
                    </div>
                    <h3 className="job-item-title">{job.title || summarizeText(job.prompt)}</h3>
                    <p className="job-item-prompt">
                      {lastMessage ? summarizeText(lastMessage.content) : summarizeText(job.prompt)}
                    </p>
                    <div className="job-item-footer">
                      <span className="job-item-time">{formatDate(job.updated_at)}</span>
                      <span className="job-item-id">{job.open_folder}</span>
                    </div>
                  </button>
                );
              })}

              {!jobs.length ? (
                <div className="empty-card">
                  <p className="section-label">No sessions yet</p>
                  <p className="sidebar-copy">
                    Start a new Codex chat and the transcript will persist here.
                  </p>
                </div>
              ) : null}
            </div>
          </section>

          <section className="sidebar-section grow">
            <div className="section-heading">
              <div>
                <p className="section-label">Codex History</p>
                <h2>Synced Threads</h2>
              </div>
              <span className="section-count">{historyThreads.length}</span>
            </div>

            <div className="job-list">
              {historyThreads.map((thread) => (
                <button
                  key={thread.id}
                  className={`job-item ${
                    selectionKind === "history" && thread.id === selectedHistoryThreadId
                      ? "selected"
                      : ""
                  }`}
                  type="button"
                  onClick={() => handleSelectHistory(thread.id)}
                >
                  <div className="job-item-meta">
                    <span className="status-pill">{historySourceLabel(thread.source)}</span>
                    <span className="message-chip">{thread.status}</span>
                  </div>
                  <h3 className="job-item-title">{thread.name}</h3>
                  <p className="job-item-prompt">
                    {thread.preview
                      ? summarizeText(thread.preview)
                      : "No preview available for this Codex thread."}
                  </p>
                  <div className="job-item-footer">
                    <span className="job-item-time">{formatDate(thread.updated_at)}</span>
                    <span className="job-item-id">{thread.cwd || "n/a"}</span>
                  </div>
                </button>
              ))}

              {historyLoading && !historyThreads.length ? (
                <div className="empty-card">
                  <p className="sidebar-copy">Loading Codex history...</p>
                </div>
              ) : null}

              {historyError && !historyThreads.length ? (
                <div className="empty-card">
                  <p className="section-label">History unavailable</p>
                  <p className="sidebar-copy">{historyError}</p>
                </div>
              ) : null}
            </div>
          </section>
        </aside>

        <main className="workbench">
          <section className="editor-stage">
            <header className="title-bar">
              <div>
                <p className="section-label">Workspace Console</p>
                <h2>{selectedTitle}</h2>
                <p className="title-copy">
                  {selectedHistorySummary
                    ? `${historySourceLabel(selectedHistorySummary.source)} thread • ${formatDate(selectedHistorySummary.updated_at)}`
                    : selectedJob
                      ? `Open folder ${selectedJob.open_folder} • ${formatDate(selectedJob.updated_at)}`
                      : "Select a session on the left or start a fresh chat."}
                </p>
              </div>
              <div className="title-bar-meta">
                <span className="message-chip">
                  {selectedHistorySummary ? "Synced" : "Lokal"}
                </span>
                {selectedHistorySummary ? (
                  <span className="message-chip">
                    {historySourceLabel(selectedHistorySummary.source)}
                  </span>
                ) : (
                  <span className={`stream-pill ${streamState}`}>{streamLabel(streamState)}</span>
                )}
                <span className="message-chip">
                  Thread{" "}
                  {shortThreadId(
                    selectedHistorySummary?.id ?? selectedJob?.thread_id ?? null,
                  )}
                </span>
              </div>
            </header>

            {error ? <div className="error-banner">{error}</div> : null}
            {historyError && selectionKind === "history" ? (
              <div className="error-banner">{historyError}</div>
            ) : null}

            <div className="stage-grid">
              <article className="stage-card stage-hero">
                <div className="section-heading">
                  <div>
                    <p className="section-label">Latest Assistant Message</p>
                    <h3>Codex output preview</h3>
                  </div>
                  {selectedHistorySummary || selectedJob ? (
                    <span
                      className={`status-pill ${selectedJob?.status ?? selectedHistorySummary?.status ?? ""}`}
                    >
                      {selectedJob?.status ?? selectedHistorySummary?.status}
                    </span>
                  ) : null}
                </div>
                {latestAssistant ? (
                  <pre className="stage-output">{latestAssistant.content}</pre>
                ) : (
                  <div className="stage-empty">
                    <p className="sidebar-copy">
                      Assistant replies land here and stay in the chat transcript on the
                      right.
                    </p>
                  </div>
                )}
              </article>

              <article className="stage-card">
                <div className="section-heading">
                  <div>
                    <p className="section-label">
                      {selectedHistorySummary ? "History Source" : "Changed Files"}
                    </p>
                    <h3>
                      {selectedHistorySummary ? "Thread origin" : "Workspace delta"}
                    </h3>
                  </div>
                  <span className="section-count">
                    {selectedHistorySummary
                      ? historySourceLabel(selectedHistorySummary.source)
                      : selectedJob?.changed_files.length ?? 0}
                  </span>
                </div>
                {selectedHistorySummary ? (
                  <div className="detail-list">
                    <div className="detail-row">
                      <span className="detail-key">Source</span>
                      <span className="detail-value">
                        {historySourceLabel(selectedHistorySummary.source)}
                      </span>
                    </div>
                    <div className="detail-row">
                      <span className="detail-key">CWD</span>
                      <span className="detail-value">{selectedHistorySummary.cwd || "n/a"}</span>
                    </div>
                    <div className="detail-row">
                      <span className="detail-key">Provider</span>
                      <span className="detail-value">
                        {selectedHistorySummary.model_provider ?? "n/a"}
                      </span>
                    </div>
                    <div className="detail-row">
                      <span className="detail-key">Path</span>
                      <span className="detail-value">
                        {selectedHistorySummary.path || "n/a"}
                      </span>
                    </div>
                  </div>
                ) : selectedJob?.changed_files.length ? (
                  <div className="file-list">
                    {selectedJob.changed_files.map((file) => (
                      <div key={file} className="file-item">
                        <code>{file}</code>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="sidebar-copy">
                    No file changes recorded for this session yet.
                  </p>
                )}
              </article>

              <article className="stage-card">
                <div className="section-heading">
                  <div>
                    <p className="section-label">
                      {selectedHistorySummary ? "Thread State" : "Thread State"}
                    </p>
                    <h3>
                      {selectedHistorySummary ? "Imported history" : "Native resume context"}
                    </h3>
                  </div>
                  {selectedHistorySummary ? (
                    <span className="message-chip">Read-only</span>
                  ) : selectedJobCapability?.dangerous ? (
                    <span className="danger-pill">Full access</span>
                  ) : null}
                </div>
                <div className="detail-list">
                  {selectedHistorySummary ? (
                    <>
                      <div className="detail-row">
                        <span className="detail-key">Status</span>
                        <span className="detail-value">{selectedHistorySummary.status}</span>
                      </div>
                      <div className="detail-row">
                        <span className="detail-key">Created</span>
                        <span className="detail-value">
                          {formatDate(selectedHistorySummary.created_at)}
                        </span>
                      </div>
                      <div className="detail-row">
                        <span className="detail-key">Updated</span>
                        <span className="detail-value">
                          {formatDate(selectedHistorySummary.updated_at)}
                        </span>
                      </div>
                      <div className="detail-row">
                        <span className="detail-key">CLI Version</span>
                        <span className="detail-value">
                          {selectedHistorySummary.cli_version ?? "n/a"}
                        </span>
                      </div>
                      <div className="detail-row">
                        <span className="detail-key">Thread Id</span>
                        <span className="detail-value">
                          {shortThreadId(selectedHistorySummary.id)}
                        </span>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="detail-row">
                        <span className="detail-key">Mode</span>
                        <span className="detail-value">{selectedJob?.mode ?? mode}</span>
                      </div>
                      <div className="detail-row">
                        <span className="detail-key">Open folder</span>
                        <span className="detail-value">
                          {selectedJob?.open_folder ?? openFolder}
                        </span>
                      </div>
                      <div className="detail-row">
                        <span className="detail-key">Limit scope</span>
                        <span className="detail-value">
                          {(selectedJob?.limit_to_open_folder ?? limitToOpenFolder)
                            ? "Enabled"
                            : "Disabled"}
                        </span>
                      </div>
                      <div className="detail-row">
                        <span className="detail-key">Native thread</span>
                        <span className="detail-value">
                          {shortThreadId(selectedJob?.thread_id ?? null)}
                        </span>
                      </div>
                      <div className="detail-row">
                        <span className="detail-key">Executor</span>
                        <span className="detail-value">{selectedJob?.executor ?? "pending"}</span>
                      </div>
                      <div className="detail-row">
                        <span className="detail-key">Return code</span>
                        <span className="detail-value">
                          {selectedJob?.return_code === null ||
                          selectedJob?.return_code === undefined
                            ? "n/a"
                            : selectedJob.return_code}
                        </span>
                      </div>
                    </>
                  )}
                </div>
              </article>
            </div>

            <div className="editor-lower-grid">
              <section className="access-card">
                <div className="mode-card-top">
                  <div>
                    <p className="section-label">
                      {selectedHistorySummary ? "History" : "Access"}
                    </p>
                    <h3>
                      {selectedHistorySummary
                        ? "Synced Codex transcript"
                        : getAccessLabel(selectedModeCapability)}
                    </h3>
                  </div>
                  <div className="title-bar-meta">
                    {!selectedHistorySummary && selectedModeCapability ? (
                      <span className={`mode-state ${selectedModeCapability.mode}`}>
                        {selectedModeCapability.launch_strategy}
                      </span>
                    ) : null}
                    {selectedHistorySummary ? (
                      <span className="message-chip">
                        {historySourceLabel(selectedHistorySummary.source)}
                      </span>
                    ) : null}
                    {!selectedHistorySummary && selectedModeCapability?.dangerous ? (
                      <span className="danger-pill">Host-wide</span>
                    ) : null}
                  </div>
                </div>
                <p className="sidebar-copy">
                  {selectedHistorySummary
                    ? "This transcript is mirrored from Codex account history through the local app-server bridge. It is read-only in WebRun for now."
                    : getAccessDescription(selectedModeCapability)}
                </p>
                {selectedHistorySummary ? (
                  <div className="detail-list compact-detail-list">
                    <div className="detail-row">
                      <span className="detail-key">Source</span>
                      <span className="detail-value">
                        {historySourceLabel(selectedHistorySummary.source)}
                      </span>
                    </div>
                    <div className="detail-row">
                      <span className="detail-key">CWD</span>
                      <span className="detail-value">{selectedHistorySummary.cwd || "n/a"}</span>
                    </div>
                    <div className="detail-row">
                      <span className="detail-key">Path</span>
                      <span className="detail-value">{selectedHistorySummary.path || "n/a"}</span>
                    </div>
                  </div>
                ) : (
                  <>
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={limitToOpenFolder}
                        onChange={(event) => setLimitToOpenFolder(event.target.checked)}
                      />
                      <span>Limit to the open folder</span>
                    </label>
                    <div className="scope-row">
                      <div>
                        <span className="runtime-key">Open folder</span>
                        <p className="runtime-value">{openFolder}</p>
                      </div>
                      <button
                        className="ghost-button"
                        type="button"
                        onClick={() => void openFolderDialog()}
                      >
                        Change
                      </button>
                    </div>
                  </>
                )}
              </section>

              <section className="panel-surface">
                <div className="panel-header">
                  <div className="panel-tabs">
                    {(["logs", "events", "details"] as PanelTab[]).map((tab) => (
                      <button
                        key={tab}
                        className={`panel-tab ${activePanel === tab ? "active" : ""}`}
                        type="button"
                        onClick={() => setActivePanel(tab)}
                      >
                        {panelTitle(tab)}
                      </button>
                    ))}
                  </div>
                  {selectedJob ? (
                    <span className={`status-pill ${selectedJob.status}`}>{selectedJob.status}</span>
                  ) : null}
                </div>

                <div className="panel-body">
                  {activePanel === "logs" ? (
                    <pre className="terminal-output">
                      {selectedHistorySummary
                        ? "WebRun logs are only available for sessions started inside this app."
                        : logs || "No logs yet."}
                    </pre>
                  ) : null}
                  {activePanel === "events" ? (
                    <pre className="terminal-output">
                      {selectedHistorySummary
                        ? "Codex history imports do not expose WebRun event streams."
                        : events || "No events yet."}
                    </pre>
                  ) : null}
                  {activePanel === "details" ? (
                    <div className="detail-list">
                      <div className="detail-row">
                        <span className="detail-key">
                          {selectedHistorySummary ? "Thread" : "Session"}
                        </span>
                        <span className="detail-value">
                          {selectedHistorySummary?.id ?? selectedJob?.id ?? "new"}
                        </span>
                      </div>
                      <div className="detail-row">
                        <span className="detail-key">
                          {selectedHistorySummary ? "Provider" : "Model"}
                        </span>
                        <span className="detail-value">
                          {selectedHistorySummary?.model_provider ?? selectedJob?.model ?? model}
                        </span>
                      </div>
                      <div className="detail-row">
                        <span className="detail-key">
                          {selectedHistorySummary ? "Source" : "Reasoning"}
                        </span>
                        <span className="detail-value">
                          {selectedHistorySummary
                            ? historySourceLabel(selectedHistorySummary.source)
                            : selectedJob?.reasoning_effort ?? reasoningEffort}
                        </span>
                      </div>
                      <div className="detail-row">
                        <span className="detail-key">Created</span>
                        <span className="detail-value">
                          {selectedHistorySummary
                            ? formatDate(selectedHistorySummary.created_at)
                            : selectedJob
                              ? formatDate(selectedJob.created_at)
                              : "Not started"}
                        </span>
                      </div>
                      <div className="detail-row">
                        <span className="detail-key">Updated</span>
                        <span className="detail-value">
                          {selectedHistorySummary
                            ? formatDate(selectedHistorySummary.updated_at)
                            : selectedJob
                              ? formatDate(selectedJob.updated_at)
                              : "n/a"}
                        </span>
                      </div>
                      <div className="detail-row">
                        <span className="detail-key">
                          {selectedHistorySummary ? "CWD" : "Open folder"}
                        </span>
                        <span className="detail-value">
                          {selectedHistorySummary?.cwd ?? selectedJob?.open_folder ?? openFolder}
                        </span>
                      </div>
                      <div className="detail-row">
                        <span className="detail-key">Native thread</span>
                        <span className="detail-value">
                          {shortThreadId(selectedHistorySummary?.id ?? selectedJob?.thread_id ?? null)}
                        </span>
                      </div>
                      <div className="detail-row">
                        <span className="detail-key">
                          {selectedHistorySummary ? "Thread path" : "Thread scope"}
                        </span>
                        <span className="detail-value">
                          {selectedHistorySummary?.path ??
                            selectedJob?.thread_open_folder ??
                            "not established"}
                        </span>
                      </div>
                      <div className="detail-row">
                        <span className="detail-key">
                          {selectedHistorySummary ? "CLI version" : "Limit scope"}
                        </span>
                        <span className="detail-value">
                          {selectedHistorySummary
                            ? selectedHistorySummary.cli_version ?? "n/a"
                            : (selectedJob?.thread_limit_to_open_folder ?? limitToOpenFolder)
                              ? "Enabled"
                              : "Disabled"}
                        </span>
                      </div>
                      {selectedHistorySummary ? null : (
                        <div className="detail-row">
                          <span className="detail-key">Worker PID</span>
                          <span className="detail-value">{selectedJob?.worker_pid ?? "n/a"}</span>
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>
              </section>
            </div>
          </section>

          <aside className="chat-pane">
            <header className="chat-header">
              <div>
                <p className="section-label">Chat</p>
                <h2>{selectionKind === "new" ? "Compose a new Codex thread" : selectedTitle}</h2>
                <p className="title-copy">{selectedSubtitle}</p>
              </div>
              <div className="chat-header-actions">
                {selectedJobBusy ? (
                  <button
                    className="ghost-button danger-action"
                    type="button"
                    onClick={handleCancel}
                    disabled={cancelling}
                  >
                    {cancelling ? "Stopping..." : "Cancel"}
                  </button>
                ) : null}
                <button className="ghost-button" type="button" onClick={handleNewChat}>
                  New
                </button>
              </div>
            </header>

            <div className="chat-surface" ref={messagesRef}>
              {selectedJob || selectedHistory ? (
                selectedTranscriptMessages.map((message) => (
                  <article key={message.id} className={`message-card ${message.role}`}>
                    <div className="message-meta">
                      <strong>{messageRoleLabel(message.role)}</strong>
                      <div className="message-flags">
                        <span className="message-chip">
                          Turn {isConversationMessage(message) ? message.turn : message.turn_index}
                        </span>
                        {isConversationMessage(message) && message.model ? (
                          <span className="message-chip">{message.model}</span>
                        ) : null}
                        {isConversationMessage(message) && message.reasoning_effort ? (
                          <span className="message-chip">{message.reasoning_effort}</span>
                        ) : null}
                        {isConversationMessage(message) && message.mode ? (
                          <span className={`mode-pill ${message.mode}`}>{message.mode}</span>
                        ) : null}
                        {!isConversationMessage(message) && message.phase ? (
                          <span className="message-chip">{message.phase}</span>
                        ) : null}
                        {!isConversationMessage(message) ? (
                          <span className="message-chip">{message.source_item_type}</span>
                        ) : null}
                      </div>
                    </div>
                    <pre className="message-body">{message.content}</pre>
                  </article>
                ))
              ) : selectionKind === "history" ? (
                <div className="empty-chat">
                  <p className="section-label">Codex history</p>
                  <h3>{historyLoading ? "Loading synced thread..." : "Thread preview unavailable"}</h3>
                  <p className="sidebar-copy">
                    {historyLoading
                      ? "WebRun is fetching the selected Codex transcript through the local app-server bridge."
                      : "The selected history thread could not be rendered yet."}
                  </p>
                </div>
              ) : (
                <div className="empty-chat">
                  <p className="section-label">No active chat</p>
                  <h3>Start a new Codex conversation</h3>
                  <p className="sidebar-copy">
                    Pick the model, reasoning effort, access level, and folder scope
                    below. Every follow-up stays in the same transcript.
                  </p>
                </div>
              )}
            </div>

            <section className="composer-card">
              {selectedHistorySummary ? (
                <div className="history-banner">
                  This Codex history thread is read-only in WebRun for now. Start a new chat
                  to continue work inside this app.
                </div>
              ) : null}

              <div className="composer-toolbar">
                <div className="quick-action-row">
                  {QUICK_ACTIONS.map((action) => (
                    <button
                      key={action.label}
                      className="panel-tab quick-action"
                      type="button"
                      onClick={() => void submitPrompt(action.prompt)}
                      disabled={
                        submitting ||
                        selectedJobBusy ||
                        selectionKind === "history" ||
                        !selectedModeCapability?.enabled
                      }
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
                <button
                  className="ghost-button"
                  type="button"
                  onClick={() => void openFolderDialog()}
                  disabled={selectionKind === "history"}
                >
                  Choose Folder
                </button>
              </div>

              <form className="composer-form" onSubmit={handleSubmit}>
                <textarea
                  ref={promptRef}
                  className="composer-input"
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  rows={6}
                  disabled={selectionKind === "history"}
                  placeholder="Describe the next coding task, ask for a review, or continue the thread..."
                />

                <div className="composer-grid">
                  <label className="field">
                    <span className="field-label">Model</span>
                    <select
                      value={model}
                      onChange={(event) => setModel(event.target.value)}
                      disabled={selectionKind === "history"}
                    >
                      {runtime?.available_models.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="field">
                    <span className="field-label">Denkaufwand</span>
                    <select
                      value={reasoningEffort}
                      disabled={selectionKind === "history"}
                      onChange={(event) =>
                        setReasoningEffort(event.target.value as ReasoningEffort)
                      }
                    >
                      {runtime?.reasoning_efforts.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="field">
                    <span className="field-label">Zugriff</span>
                    <select
                      value={mode}
                      disabled={selectionKind === "history"}
                      onChange={(event) => setMode(event.target.value as JobMode)}
                    >
                      {runtime?.modes.map((option) => (
                        <option key={option.mode} value={option.mode} disabled={!option.enabled}>
                          {getAccessLabel(option)}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <div className="composer-footer">
                  <div className="status-bar">
                    <span className="message-chip">Lokal</span>
                    <span className={`stream-pill ${streamState}`}>{streamLabel(streamState)}</span>
                    {runtime?.supports_native_thread_resume ? (
                      <span className="message-chip">Native resume</span>
                    ) : null}
                  </div>

                  <div className="composer-actions">
                    {selectedJobBusy ? (
                      <button
                        className="ghost-button danger-action"
                        type="button"
                        onClick={handleCancel}
                        disabled={cancelling}
                      >
                        {cancelling ? "Stopping..." : "Cancel"}
                      </button>
                    ) : null}
                    <button
                      className="primary-button"
                      type="submit"
                      disabled={!canSubmit}
                    >
                      {selectionKind === "history"
                        ? "History is read-only"
                        : selectedJob
                          ? "Send Follow-up"
                          : "Start Chat"}
                    </button>
                  </div>
                </div>
              </form>
            </section>
          </aside>
        </main>
      </div>

      {folderDialogOpen ? (
        <div className="modal-backdrop" onClick={() => setFolderDialogOpen(false)}>
          <div
            className="modal-card"
            onClick={(event) => {
              event.stopPropagation();
            }}
          >
            <div className="section-heading">
              <div>
                <p className="section-label">Choose Folder</p>
                <h3>Limit the open workspace scope</h3>
              </div>
              <button
                className="ghost-button"
                type="button"
                onClick={() => setFolderDialogOpen(false)}
              >
                Close
              </button>
            </div>

            <div className="detail-list">
              <div className="detail-row">
                <span className="detail-key">Workspace root</span>
                <span className="detail-value">{runtime?.workspace_root ?? "Loading..."}</span>
              </div>
              <div className="detail-row">
                <span className="detail-key">Current path</span>
                <span className="detail-value">
                  {folderBrowser?.current_path ?? openFolder}
                </span>
              </div>
            </div>

            <div className="modal-actions">
              <button
                className="ghost-button"
                type="button"
                onClick={() => void loadFolderBrowser(".")}
                disabled={folderLoading}
              >
                Workspace root
              </button>
              <button
                className="ghost-button"
                type="button"
                onClick={() =>
                  folderBrowser?.parent_path
                    ? void loadFolderBrowser(folderBrowser.parent_path)
                    : undefined
                }
                disabled={folderLoading || !folderBrowser?.parent_path}
              >
                Up
              </button>
              <button
                className="primary-button"
                type="button"
                onClick={() => chooseFolder(folderBrowser?.current_path ?? openFolder)}
                disabled={folderLoading}
              >
                Use this folder
              </button>
            </div>

            {folderError ? <div className="error-banner compact">{folderError}</div> : null}

            <div className="folder-list">
              {folderLoading ? (
                <div className="folder-row-card">
                  <p className="sidebar-copy">Loading folders...</p>
                </div>
              ) : null}

              {!folderLoading && folderBrowser?.entries.length ? (
                folderBrowser.entries.map((entry) => (
                  <div key={entry.path} className="folder-row-card">
                    <div>
                      <strong>{entry.name}</strong>
                      <p className="sidebar-copy">{entry.path}</p>
                    </div>
                    <div className="folder-row-actions">
                      <button
                        className="ghost-button"
                        type="button"
                        onClick={() => void loadFolderBrowser(entry.path)}
                      >
                        Open
                      </button>
                      <button
                        className="ghost-button"
                        type="button"
                        onClick={() => chooseFolder(entry.path)}
                      >
                        Choose
                      </button>
                    </div>
                  </div>
                ))
              ) : null}

              {!folderLoading && folderBrowser && folderBrowser.entries.length === 0 ? (
                <div className="folder-row-card">
                  <p className="sidebar-copy">
                    No subfolders here. You can still use the current folder.
                  </p>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
