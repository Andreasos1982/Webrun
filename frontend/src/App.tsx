import {
  startTransition,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";

import {
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

function findLatestJobForThread(
  jobs: JobRecord[],
  threadId: string | null,
): JobRecord | null {
  if (!threadId) {
    return null;
  }

  return jobs.find((job) => job.thread_id === threadId) ?? null;
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
    return "Begrenzt";
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

function threadHasCompactingFlag(activeFlags: string[] | null | undefined): boolean {
  return (activeFlags ?? []).some((flag) => flag.toLowerCase().includes("compact"));
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
  const [originCollapsed, setOriginCollapsed] = useState(false);
  const [contextCollapsed, setContextCollapsed] = useState(false);
  const [viewportScrollPercent, setViewportScrollPercent] = useState(0);
  const seededRunKeyRef = useRef<string | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);

  const selectedJob = jobs.find((job) => job.id === selectedJobId) ?? null;
  const selectedThreadRunJob = findLatestJobForThread(jobs, selectedHistoryThreadId);
  const activeRunJob =
    selectionKind === "history" ? selectedThreadRunJob : selectionKind === "job" ? selectedJob : null;
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
  const selectedTranscriptMessages =
    selectionKind === "history"
      ? selectedHistory?.messages.length
        ? selectedHistory.messages
        : selectedThreadRunJob?.messages ?? []
      : selectedJob?.messages ?? [];
  const selectedModeCapability = getModeCapability(runtime, mode);
  const selectedRunCapability = activeRunJob
    ? getModeCapability(runtime, activeRunJob.mode)
    : null;
  const selectedJobBusy = activeRunJob ? isBusy(activeRunJob.status) : false;
  const selectedThreadActiveFlags =
    activeRunJob?.thread_active_flags.length
      ? activeRunJob.thread_active_flags
      : selectedHistorySummary?.active_flags ?? [];
  const selectedThreadIsCompacting = threadHasCompactingFlag(selectedThreadActiveFlags);
  const activeJobId = activeRunJob?.id ?? null;
  const canSubmit =
    Boolean(prompt.trim()) &&
    Boolean(model) &&
    Boolean(selectedModeCapability?.enabled) &&
    !selectedJobBusy &&
    !submitting;
  const selectedTitle =
    selectedHistorySummary?.name ??
    activeRunJob?.title ??
    "New Codex session";
  const selectedSubtitle = selectedHistorySummary
    ? `${selectedTranscriptMessages.length} messages • ${historySourceLabel(selectedHistorySummary.source)} sync`
    : activeRunJob
      ? `${activeRunJob.messages.length} messages • ${activeRunJob.turn_count} turns`
      : "Alternating user and Codex messages stay visible here.";

  async function refreshHistoryThreads() {
    const response = await listCodexHistory(50);
    startTransition(() => {
      setHistoryThreads(response.threads);
    });
    setHistoryError(null);
  }

  async function refreshHistoryDetail(threadId: string) {
    const response = await fetchCodexHistoryThread(threadId);
    startTransition(() => {
      setHistoryDetail(response);
    });
    setHistoryError(null);
  }

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
            return current && response.jobs.some((job) => job.id === current) ? current : null;
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

    async function syncHistory() {
      try {
        if (cancelled) {
          return;
        }
        await refreshHistoryThreads();
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

    void syncHistory();
    const intervalId = window.setInterval(() => {
      void syncHistory();
    }, 20000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    if (!activeRunJob) {
      return;
    }

    const seedKey = `${selectionKind}:${activeRunJob.id}`;
    if (seededRunKeyRef.current === seedKey) {
      return;
    }

    seededRunKeyRef.current = seedKey;
    startTransition(() => {
      setMode(activeRunJob.mode);
      setModel(activeRunJob.model);
      setReasoningEffort(activeRunJob.reasoning_effort);
      setOpenFolder(activeRunJob.open_folder || ".");
      setLimitToOpenFolder(activeRunJob.limit_to_open_folder);
    });
  }, [activeRunJob, selectionKind]);

  useEffect(() => {
    if (selectionKind !== "job" || !selectedJob?.thread_id) {
      return;
    }

    setSelectionKind("history");
    setSelectedHistoryThreadId(selectedJob.thread_id);
    void refreshHistoryThreads();
  }, [selectedJob, selectionKind]);

  useEffect(() => {
    if (selectionKind !== "history" || !selectedHistoryThreadId) {
      return;
    }

    const threadId = selectedHistoryThreadId;
    let cancelled = false;
    setHistoryLoading(true);

    async function syncHistoryDetail() {
      try {
        if (cancelled) {
          return;
        }
        await refreshHistoryDetail(threadId);
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

    void syncHistoryDetail();
    const intervalId = window.setInterval(() => {
      void syncHistoryDetail();
    }, selectedJobBusy ? 2500 : 12000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [selectedHistoryThreadId, selectedJobBusy, selectionKind]);

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
  }, [
    selectionKind,
    selectedHistory?.messages.length,
    selectedHistoryThreadId,
    activeRunJob?.messages.length,
    activeRunJob?.updated_at,
  ]);

  useEffect(() => {
    const updateViewportScroll = () => {
      const maxScroll = Math.max(
        document.documentElement.scrollHeight - window.innerHeight,
        0,
      );
      setViewportScrollPercent(maxScroll > 0 ? (window.scrollY / maxScroll) * 100 : 0);
    };

    updateViewportScroll();
    window.addEventListener("scroll", updateViewportScroll, { passive: true });
    window.addEventListener("resize", updateViewportScroll);

    return () => {
      window.removeEventListener("scroll", updateViewportScroll);
      window.removeEventListener("resize", updateViewportScroll);
    };
  }, []);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => {
      const maxScroll = Math.max(
        document.documentElement.scrollHeight - window.innerHeight,
        0,
      );
      setViewportScrollPercent(maxScroll > 0 ? (window.scrollY / maxScroll) * 100 : 0);
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [
    historyThreads.length,
    selectedTranscriptMessages.length,
    selectionKind,
    activePanel,
    logs.length,
    events.length,
    originCollapsed,
    contextCollapsed,
  ]);

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
    seededRunKeyRef.current = "__new__";
    setSelectionKind("new");
    setSelectedJobId(null);
    setSelectedHistoryThreadId(null);
    setHistoryDetail(null);
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

  function handleSelectHistory(threadId: string) {
    setSelectionKind("history");
    setSelectedJobId(null);
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

  function handleViewportScroll(nextPercent: number) {
    const maxScroll = Math.max(
      document.documentElement.scrollHeight - window.innerHeight,
      0,
    );
    window.scrollTo({
      top: (Math.max(0, Math.min(nextPercent, 100)) / 100) * maxScroll,
      behavior: "auto",
    });
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
        thread_id: selectedHistoryThreadId,
        thread_title: selectedHistorySummary?.name ?? null,
      };

      const job = await createJob(payload);
      seededRunKeyRef.current = `${selectedHistoryThreadId ? "history" : "job"}:${job.id}`;

      startTransition(() => {
        setJobs((current) => mergeJob(current, job));
        if (job.thread_id) {
          setSelectionKind("history");
          setSelectedHistoryThreadId(job.thread_id);
          setSelectedJobId(job.id);
        } else {
          setSelectionKind("job");
          setSelectedJobId(job.id);
        }
        setActivePanel("logs");
        if (!overridePrompt) {
          setPrompt("");
        } else if (prompt.trim() === nextPrompt) {
          setPrompt("");
        }
      });
      void refreshHistoryThreads();
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
    if (!activeRunJob || cancelling) {
      return;
    }

    setCancelling(true);
    setError(null);

    try {
      const job = await cancelJob(activeRunJob.id);
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
      <div className="viewport-scroll-rail">
        <input
          aria-label="Scroll the full window"
          className="viewport-scroll-input"
          type="range"
          min="0"
          max="100"
          step="1"
          value={viewportScrollPercent}
          onChange={(event) => handleViewportScroll(Number(event.target.value))}
        />
      </div>

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
                <p className="section-label">Codex History</p>
                <h2>Synced Threads</h2>
              </div>
              <span className="section-count">{historyThreads.length}</span>
            </div>

            <div className="job-list thread-list-window">
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
                    {threadHasCompactingFlag(thread.active_flags) ? (
                      <span
                        className="message-chip compacting-chip"
                        title="Codex automatically compacts itself when the thread gets long."
                      >
                        Compacting
                      </span>
                    ) : null}
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

              {!historyLoading && !historyError && !historyThreads.length ? (
                <div className="empty-card">
                  <p className="section-label">No synced threads yet</p>
                  <p className="sidebar-copy">
                    Start a new Codex chat and it will land directly in synced history.
                  </p>
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
                    : activeRunJob
                      ? `Open folder ${activeRunJob.open_folder} • ${formatDate(activeRunJob.updated_at)}`
                      : "Select a session on the left or start a fresh chat."}
                </p>
              </div>
              <div className="title-bar-meta">
                <span className="message-chip">{selectedHistorySummary ? "Synced" : "Draft"}</span>
                <span className={`stream-pill ${streamState}`}>{streamLabel(streamState)}</span>
                {selectedThreadIsCompacting ? (
                  <span
                    className="message-chip compacting-chip"
                    title="Codex automatically compacts itself when the thread gets long."
                  >
                    Compacting
                  </span>
                ) : null}
                {selectedHistorySummary ? (
                  <span className="message-chip">{historySourceLabel(selectedHistorySummary.source)}</span>
                ) : null}
                <span className="message-chip">
                  Thread{" "}
                  {shortThreadId(selectedHistorySummary?.id ?? activeRunJob?.thread_id ?? null)}
                </span>
              </div>
            </header>

            {error ? <div className="error-banner">{error}</div> : null}
            {historyError && selectionKind === "history" ? (
              <div className="error-banner">{historyError}</div>
            ) : null}

            <div className="stage-grid">
              <article className={`stage-card ${originCollapsed ? "collapsed" : ""}`}>
                <div className="section-heading">
                  <div>
                    <p className="section-label">
                      {activeRunJob?.changed_files.length ? "Changed Files" : "History Source"}
                    </p>
                    <h3>
                      {activeRunJob?.changed_files.length ? "Workspace delta" : "Thread origin"}
                    </h3>
                  </div>
                  <span className="section-count">
                    {activeRunJob?.changed_files.length
                      ? activeRunJob.changed_files.length
                      : selectedHistorySummary
                        ? historySourceLabel(selectedHistorySummary.source)
                        : 0}
                  </span>
                  <button
                    className="ghost-button collapse-button"
                    type="button"
                    onClick={() => setOriginCollapsed((current) => !current)}
                  >
                    {originCollapsed ? "Einblenden" : "Einklappen"}
                  </button>
                </div>
                {!originCollapsed && activeRunJob?.changed_files.length ? (
                  <div className="file-list">
                    {activeRunJob.changed_files.map((file) => (
                      <div key={file} className="file-item">
                        <code>{file}</code>
                      </div>
                    ))}
                  </div>
                ) : null}
                {!originCollapsed && selectedHistorySummary && !activeRunJob?.changed_files.length ? (
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
                ) : null}
                {!originCollapsed &&
                !selectedHistorySummary &&
                !activeRunJob?.changed_files.length ? (
                  <p className="sidebar-copy">
                    No file changes or synced thread metadata available yet.
                  </p>
                ) : null}
              </article>

              <article className={`stage-card ${contextCollapsed ? "collapsed" : ""}`}>
                <div className="section-heading">
                  <div>
                    <p className="section-label">Thread State</p>
                    <h3>Native resume context</h3>
                  </div>
                  {selectedRunCapability?.dangerous ? (
                    <span className="danger-pill">Full access</span>
                  ) : null}
                  <button
                    className="ghost-button collapse-button"
                    type="button"
                    onClick={() => setContextCollapsed((current) => !current)}
                  >
                    {contextCollapsed ? "Einblenden" : "Einklappen"}
                  </button>
                </div>
                {!contextCollapsed ? (
                  <div className="detail-list">
                    <div className="detail-row">
                      <span className="detail-key">Status</span>
                      <span className="detail-value">
                        {activeRunJob?.status ?? selectedHistorySummary?.status ?? "draft"}
                      </span>
                    </div>
                    <div className="detail-row">
                      <span className="detail-key">Thread activity</span>
                      <span className="detail-value">
                        {selectedThreadIsCompacting
                          ? "Compacting"
                          : selectedThreadActiveFlags.length
                            ? selectedThreadActiveFlags.join(", ")
                            : "Idle"}
                      </span>
                    </div>
                    <div className="detail-row">
                      <span className="detail-key">Source</span>
                      <span className="detail-value">
                        {selectedHistorySummary
                          ? historySourceLabel(selectedHistorySummary.source)
                          : "New synced chat"}
                      </span>
                    </div>
                    <div className="detail-row">
                      <span className="detail-key">Created</span>
                      <span className="detail-value">
                        {selectedHistorySummary
                          ? formatDate(selectedHistorySummary.created_at)
                          : activeRunJob
                            ? formatDate(activeRunJob.created_at)
                            : "Not started"}
                      </span>
                    </div>
                    <div className="detail-row">
                      <span className="detail-key">Updated</span>
                      <span className="detail-value">
                        {selectedHistorySummary
                          ? formatDate(selectedHistorySummary.updated_at)
                          : activeRunJob
                            ? formatDate(activeRunJob.updated_at)
                            : "n/a"}
                      </span>
                    </div>
                    <div className="detail-row">
                      <span className="detail-key">Native thread</span>
                      <span className="detail-value">
                        {shortThreadId(selectedHistorySummary?.id ?? activeRunJob?.thread_id ?? null)}
                      </span>
                    </div>
                    <div className="detail-row">
                      <span className="detail-key">Open folder</span>
                      <span className="detail-value">
                        {activeRunJob?.open_folder ?? openFolder}
                      </span>
                    </div>
                    <div className="detail-row">
                      <span className="detail-key">Limit scope</span>
                      <span className="detail-value">
                        {(activeRunJob?.limit_to_open_folder ?? limitToOpenFolder)
                          ? "Enabled"
                          : "Disabled"}
                      </span>
                    </div>
                    <div className="detail-row">
                      <span className="detail-key">Executor</span>
                      <span className="detail-value">{activeRunJob?.executor ?? "pending"}</span>
                    </div>
                    <div className="detail-row">
                      <span className="detail-key">Return code</span>
                      <span className="detail-value">
                        {activeRunJob?.return_code === null || activeRunJob?.return_code === undefined
                          ? "n/a"
                          : activeRunJob.return_code}
                      </span>
                    </div>
                    {activeRunJob?.thread_compacted_at ? (
                      <div className="detail-row">
                        <span className="detail-key">Last compaction</span>
                        <span className="detail-value">
                          {formatDate(activeRunJob.thread_compacted_at)}
                        </span>
                      </div>
                    ) : null}
                    {selectedHistorySummary?.cli_version ? (
                      <div className="detail-row">
                        <span className="detail-key">CLI version</span>
                        <span className="detail-value">{selectedHistorySummary.cli_version}</span>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </article>
            </div>

            <div className="editor-lower-grid">
              <section className="access-card">
                <div className="mode-card-top">
                  <div>
                    <p className="section-label">Access</p>
                    <h3>{getAccessLabel(selectedModeCapability)}</h3>
                  </div>
                  <div className="title-bar-meta">
                    {selectedModeCapability ? (
                      <span className={`mode-state ${selectedModeCapability.mode}`}>
                        {selectedModeCapability.launch_strategy}
                      </span>
                    ) : null}
                    {selectedHistorySummary ? (
                      <span className="message-chip">
                        {historySourceLabel(selectedHistorySummary.source)}
                      </span>
                    ) : null}
                    {selectedModeCapability?.dangerous ? (
                      <span className="danger-pill">Host-wide</span>
                    ) : null}
                  </div>
                </div>
                <p className="sidebar-copy">
                  {selectedHistorySummary
                    ? `Continuing synced thread from ${historySourceLabel(selectedHistorySummary.source)}. ${getAccessDescription(selectedModeCapability)}`
                    : getAccessDescription(selectedModeCapability)}
                </p>
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
                  {activeRunJob ? (
                    <span className={`status-pill ${activeRunJob.status}`}>{activeRunJob.status}</span>
                  ) : selectedHistorySummary ? (
                    <span className="status-pill">{selectedHistorySummary.status}</span>
                  ) : null}
                </div>

                <div className="panel-body">
                  {activePanel === "logs" ? (
                    <pre className="terminal-output">
                      {activeRunJob
                        ? logs || "No logs yet."
                        : selectedHistorySummary
                          ? "Open or continue this synced thread in WebRun to generate runner logs."
                          : "No logs yet."}
                    </pre>
                  ) : null}
                  {activePanel === "events" ? (
                    <pre className="terminal-output">
                      {activeRunJob
                        ? events || "No events yet."
                        : selectedHistorySummary
                          ? "Open or continue this synced thread in WebRun to generate runner events."
                          : "No events yet."}
                    </pre>
                  ) : null}
                  {activePanel === "details" ? (
                    <div className="detail-list">
                      <div className="detail-row">
                        <span className="detail-key">Thread</span>
                        <span className="detail-value">
                          {selectedHistorySummary?.id ?? activeRunJob?.thread_id ?? "new"}
                        </span>
                      </div>
                      <div className="detail-row">
                        <span className="detail-key">Run id</span>
                        <span className="detail-value">{activeRunJob?.id ?? "n/a"}</span>
                      </div>
                      <div className="detail-row">
                        <span className="detail-key">
                          {selectedHistorySummary ? "Provider" : "Model"}
                        </span>
                        <span className="detail-value">
                          {selectedHistorySummary?.model_provider ?? activeRunJob?.model ?? model}
                        </span>
                      </div>
                      <div className="detail-row">
                        <span className="detail-key">
                          {selectedHistorySummary ? "Source" : "Reasoning"}
                        </span>
                        <span className="detail-value">
                          {selectedHistorySummary
                            ? historySourceLabel(selectedHistorySummary.source)
                            : activeRunJob?.reasoning_effort ?? reasoningEffort}
                        </span>
                      </div>
                      <div className="detail-row">
                        <span className="detail-key">Created</span>
                        <span className="detail-value">
                          {selectedHistorySummary
                            ? formatDate(selectedHistorySummary.created_at)
                            : activeRunJob
                              ? formatDate(activeRunJob.created_at)
                              : "Not started"}
                        </span>
                      </div>
                      <div className="detail-row">
                        <span className="detail-key">Updated</span>
                        <span className="detail-value">
                          {selectedHistorySummary
                            ? formatDate(selectedHistorySummary.updated_at)
                            : activeRunJob
                              ? formatDate(activeRunJob.updated_at)
                              : "n/a"}
                        </span>
                      </div>
                      <div className="detail-row">
                        <span className="detail-key">
                          {selectedHistorySummary ? "CWD" : "Open folder"}
                        </span>
                        <span className="detail-value">
                          {selectedHistorySummary?.cwd ?? activeRunJob?.open_folder ?? openFolder}
                        </span>
                      </div>
                      <div className="detail-row">
                        <span className="detail-key">Native thread</span>
                        <span className="detail-value">
                          {shortThreadId(selectedHistorySummary?.id ?? activeRunJob?.thread_id ?? null)}
                        </span>
                      </div>
                      <div className="detail-row">
                        <span className="detail-key">
                          {selectedHistorySummary ? "Thread path" : "Thread scope"}
                        </span>
                        <span className="detail-value">
                          {selectedHistorySummary?.path ??
                            activeRunJob?.thread_open_folder ??
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
                            : (activeRunJob?.thread_limit_to_open_folder ?? limitToOpenFolder)
                              ? "Enabled"
                              : "Disabled"}
                        </span>
                      </div>
                      {activeRunJob ? (
                        <div className="detail-row">
                          <span className="detail-key">Worker PID</span>
                          <span className="detail-value">{activeRunJob.worker_pid ?? "n/a"}</span>
                        </div>
                      ) : null}
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

            <div className="chat-surface chat-window" ref={messagesRef}>
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
                  placeholder="Describe the next coding task, ask for a review, or continue the thread..."
                />

                <div className="composer-grid">
                  <label className="field">
                    <span className="field-label">Model</span>
                    <select
                      value={model}
                      onChange={(event) => setModel(event.target.value)}
                    >
                      {runtime?.available_models.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="field">
                    <span className="field-label">Denken</span>
                    <select
                      value={reasoningEffort}
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
                    <span className="message-chip">
                      {selectedHistorySummary ? "Synced thread" : "New synced thread"}
                    </span>
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
                      {selectionKind === "history" ? "Send Follow-up" : "Start Chat"}
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
