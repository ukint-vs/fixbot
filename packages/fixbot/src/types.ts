export const JOB_SPEC_VERSION_V1 = "fixbot.job/v1" as const;
export const JOB_RESULT_VERSION_V1 = "fixbot.result/v1" as const;
export const EXECUTION_PLAN_VERSION_V1 = "fixbot.execution/v1" as const;
export const EXECUTION_OUTPUT_VERSION_V1 = "fixbot.execution-output/v1" as const;
export const DAEMON_CONFIG_VERSION_V1 = "fixbot.daemon-config/v1" as const;
export const DAEMON_STATUS_VERSION_V1 = "fixbot.daemon-status/v1" as const;
export const DAEMON_JOB_ENVELOPE_VERSION_V1 = "fixbot.daemon-job-envelope/v1" as const;

export const DAEMON_LIFECYCLE_STATES = ["starting", "idle", "running", "degraded", "error"] as const;

export const TASK_CLASSES = ["fix_ci", "fix_lint", "fix_tests", "solve_issue", "fix_cve"] as const;
export type TaskClass = (typeof TASK_CLASSES)[number];
export type ResultStatus = "success" | "failed" | "timeout";
export type ExecutionMode = "process" | "docker";
export type SandboxMode = "workspace-write" | "read-only";
export type DaemonLifecycleState = (typeof DAEMON_LIFECYCLE_STATES)[number];
export type DaemonStatusFormat = "json";
export type DaemonSubmissionKind = "cli" | "github-label";

export interface RepoTarget {
	url: string;
	baseBranch: string;
}

export interface FixCiContext {
	githubActionsRunId: number;
}

export interface FixLintContext {
	lintCommand?: string;
}

export interface FixTestsContext {
	testCommand?: string;
}

export interface SolveIssueContext {
	issueNumber: number;
	issueTitle?: string;
	issueBody?: string;
}

export interface FixCveContext {
	cveId: string;
	vulnerablePackage?: string;
	targetVersion?: string;
}

export interface SandboxConfig {
	mode: SandboxMode;
	networkAccess?: boolean;
}

export interface ModelOverride {
	provider: string;
	modelId: string;
}

export interface ExecutionConstraints {
	mode?: ExecutionMode;
	timeoutMs: number;
	memoryLimitMb: number;
	sandbox?: SandboxConfig;
	model?: ModelOverride;
}

export interface JobSpecV1 {
	version: typeof JOB_SPEC_VERSION_V1;
	jobId: string;
	taskClass: TaskClass;
	repo: RepoTarget;
	fixCi?: FixCiContext;
	fixLint?: FixLintContext;
	fixTests?: FixTestsContext;
	solveIssue?: SolveIssueContext;
	fixCve?: FixCveContext;
	execution: ExecutionConstraints;
}

export interface NormalizedSandboxConfig {
	mode: SandboxMode;
	networkAccess: boolean;
}

export interface NormalizedExecutionConstraints {
	mode: ExecutionMode;
	timeoutMs: number;
	memoryLimitMb: number;
	sandbox: NormalizedSandboxConfig;
	model?: ModelOverride;
}

export interface NormalizedJobSpecV1 {
	version: typeof JOB_SPEC_VERSION_V1;
	jobId: string;
	taskClass: TaskClass;
	repo: RepoTarget;
	fixCi?: FixCiContext;
	fixLint?: FixLintContext;
	fixTests?: FixTestsContext;
	solveIssue?: SolveIssueContext;
	fixCve?: FixCveContext;
	execution: NormalizedExecutionConstraints;
}

export interface ParsedResultMarkers {
	result?: Exclude<ResultStatus, "timeout">;
	summary?: string;
	failureReason?: string;
	hasResult: boolean;
	hasSummary: boolean;
	hasFailureReason: boolean;
}

export interface ExecutionPlanV1 {
	version: typeof EXECUTION_PLAN_VERSION_V1;
	job: NormalizedJobSpecV1;
	baseCommit: string;
	selectedModel: ModelSelection;
}

export interface ModelSelection {
	provider: string;
	modelId: string;
}

export interface ExecutionOutputV1 {
	version: typeof EXECUTION_OUTPUT_VERSION_V1;
	assistantFinalText: string;
	parsedMarkers: ParsedResultMarkers;
	model?: ModelSelection;
	assistantError?: string;
	internalError?: string;
}

export interface JobArtifactPaths {
	resultsDir: string;
	resultFile: string;
	artifactDir: string;
	jobSpecFile: string;
	executionPlanFile: string;
	executionOutputFile: string;
	workspaceDir: string;
	patchFile: string;
	traceFile: string;
	assistantFinalFile: string;
	injectedContextFile: string;
	isolatedAgentDir: string;
	gitStatusFile: string;
	todoFile: string;
	ciLogFile: string;
}

export interface JobResultV1 {
	version: typeof JOB_RESULT_VERSION_V1;
	jobId: string;
	taskClass: TaskClass;
	status: ResultStatus;
	summary: string;
	failureReason?: string;
	repo: RepoTarget;
	fixCi?: FixCiContext;
	fixLint?: FixLintContext;
	fixTests?: FixTestsContext;
	solveIssue?: SolveIssueContext;
	fixCve?: FixCveContext;
	execution: {
		mode: ExecutionMode;
		timeoutMs: number;
		memoryLimitMb: number;
		sandbox: NormalizedSandboxConfig;
		model?: ModelOverride;
		selectedModel?: ModelSelection;
		workspaceDir: string;
		baseCommit?: string;
		headCommit?: string;
		startedAt: string;
		finishedAt: string;
		durationMs: number;
	};
	artifacts: {
		resultFile: string;
		rootDir: string;
		jobSpecFile: string;
		patchFile: string;
		traceFile: string;
		assistantFinalFile: string;
		gitStatusFile?: string;
		todoFile?: string;
		ciLogFile?: string;
	};
	diagnostics: {
		patchSha256: string;
		changedFileCount: number;
		markers: {
			result: boolean;
			summary: boolean;
			failureReason: boolean;
		};
	};
}

export interface DaemonPathConfig {
	stateDir: string;
	resultsDir: string;
}

export interface DaemonStatusOutputConfig {
	file?: string;
	pretty?: boolean;
}

export interface DaemonRuntimeConfig {
	heartbeatIntervalMs?: number;
	idleSleepMs?: number;
}

/**
 * Optional model override in daemon config.
 * When set, the daemon uses this model instead of the provider default.
 * Example: { provider: "anthropic", modelId: "claude-sonnet-4-6" }
 */
export interface DaemonModelConfig {
	provider: string;
	modelId: string;
}

export interface DaemonGitHubRepoConfig {
	url: string;
	baseBranch: string;
	triggerLabel: string;
	taskClassOverrides?: Record<string, TaskClass>;
}

export interface GitHubAppAuthConfig {
	appId: number;
	privateKeyPath: string;
	installationId: number;
}

export interface DaemonGitHubConfig {
	repos: DaemonGitHubRepoConfig[];
	token?: string;
	pollIntervalMs?: number;
	appAuth?: GitHubAppAuthConfig;
}

export interface NormalizedDaemonGitHubRepoConfig {
	url: string;
	baseBranch: string;
	triggerLabel: string;
	taskClassOverrides?: Record<string, TaskClass>;
}

export interface NormalizedDaemonGitHubConfig {
	repos: NormalizedDaemonGitHubRepoConfig[];
	token: string | undefined;
	pollIntervalMs: number;
	appAuth?: GitHubAppAuthConfig;
}

export interface DaemonConfigV1 {
	version: typeof DAEMON_CONFIG_VERSION_V1;
	paths: DaemonPathConfig;
	status?: DaemonStatusOutputConfig;
	runtime?: DaemonRuntimeConfig;
	github?: DaemonGitHubConfig;
	identity?: { botUrl?: string };
	model?: DaemonModelConfig;
}

export interface DaemonResolvedPaths {
	stateDir: string;
	resultsDir: string;
	statusFile: string;
	pidFile: string;
	lockFile: string;
}

export interface NormalizedDaemonStatusOutputConfig {
	format: DaemonStatusFormat;
	file: string;
	pretty: boolean;
}

export interface NormalizedDaemonRuntimeConfig {
	heartbeatIntervalMs: number;
	idleSleepMs: number;
}

export interface NormalizedDaemonConfigV1 {
	version: typeof DAEMON_CONFIG_VERSION_V1;
	paths: DaemonResolvedPaths;
	status: NormalizedDaemonStatusOutputConfig;
	runtime: NormalizedDaemonRuntimeConfig;
	github?: NormalizedDaemonGitHubConfig;
	identity: { botUrl: string };
	model?: DaemonModelConfig;
}

export interface DaemonErrorSummary {
	message: string;
	at: string;
	code?: string;
}

export interface DaemonSubmissionSourceV1 {
	kind: DaemonSubmissionKind;
	filePath?: string;
	githubRepo?: string;
	githubIssueNumber?: number;
	githubLabelName?: string;
	githubActionsRunId?: number;
}

export interface DaemonJobArtifactSummaryV1 {
	artifactDir: string;
	resultFile: string;
}

export interface DaemonJobEnvelopeV1 {
	version: typeof DAEMON_JOB_ENVELOPE_VERSION_V1;
	jobId: string;
	job: NormalizedJobSpecV1;
	submission: DaemonSubmissionSourceV1;
	enqueuedAt: string;
	artifacts: DaemonJobArtifactSummaryV1;
}

export interface DaemonQueuedJobPreviewV1 {
	jobId: string;
	enqueuedAt?: string;
	submission?: DaemonSubmissionSourceV1;
	artifactDir?: string;
}

export interface DaemonQueueStatusV1 {
	depth: number;
	preview: DaemonQueuedJobPreviewV1[];
	previewTruncated: boolean;
}

export interface DaemonActiveJobStatusV1 {
	jobId: string;
	state: string;
	enqueuedAt?: string;
	startedAt?: string;
	artifactDir?: string;
}

export interface DaemonRecentResultSummaryV1 {
	jobId: string;
	status: ResultStatus;
	finishedAt: string;
	submission?: DaemonSubmissionSourceV1;
	enqueuedAt?: string;
	startedAt?: string;
	summary?: string;
	failureReason?: string;
	resultFile?: string;
	artifactDir?: string;
}

export interface DaemonStatusV1 {
	version: typeof DAEMON_STATUS_VERSION_V1;
	state: DaemonLifecycleState;
	pid?: number;
	startedAt?: string;
	heartbeatAt?: string;
	lastTransitionAt: string;
	paths: DaemonResolvedPaths;
	lastError?: DaemonErrorSummary;
	queue: DaemonQueueStatusV1;
	activeJob: DaemonActiveJobStatusV1 | null;
	recentResults: DaemonRecentResultSummaryV1[];
}

export interface DaemonStatusSnapshotV1 {
	version: typeof DAEMON_STATUS_VERSION_V1;
	state: DaemonLifecycleState;
	pid: number | null;
	startedAt: string | null;
	heartbeatAt: string | null;
	heartbeatAgeMs: number | null;
	lastTransitionAt: string;
	paths: DaemonResolvedPaths;
	lastError: DaemonErrorSummary | null;
	queue: DaemonQueueStatusV1;
	activeJob: DaemonActiveJobStatusV1 | null;
	recentResults: DaemonRecentResultSummaryV1[];
}
