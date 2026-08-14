import type { ControlConfig } from "./config.js";
import { ControlError } from "./errors.js";
import type { ProcessResult, ProcessRunOptions } from "./process.js";
import type { PreflightResult } from "./schemas.js";
import { z } from "zod";
import { githubSlugFromRemote } from "./github-source.js";
import { createSensitiveDataPolicy, type SensitiveDataPolicy } from "./sensitive-data.js";
import { realpath } from "node:fs/promises";

export interface PreflightRunner {
  runGh(args: string[], credential: "project" | "repo", options?: ProcessRunOptions): Promise<ProcessResult>;
  run(command: string, args: string[], options?: ProcessRunOptions): Promise<ProcessResult>;
}

export interface PreflightProjectPort {
  verifyFields(): Promise<void>;
  addPreflightItem(contentId: string): Promise<string>;
  verifyItemContentId(itemId: string): Promise<string | undefined>;
  readLastReviewed(itemId: string): Promise<string | undefined>;
  writeLastReviewed(itemId: string, date: string): Promise<void>;
  clearLastReviewed(itemId: string): Promise<void>;
}

export interface PreflightAuthorityPort {
  observeCommittedLegacy(): Promise<void>;
}

export interface PreflightNotionPort {
  verifyReadOnlyRoutes(): Promise<void>;
}

export interface PreflightRepositoryPort {
  verifyPrivateRepository(slug: string): Promise<void>;
}

export interface PreflightRegistryPort {
  assertReady(): Promise<unknown>;
}

export interface PreflightServiceOptions {
  config: ControlConfig;
  environment: NodeJS.ProcessEnv;
  runner: PreflightRunner;
  project: PreflightProjectPort;
  authority: PreflightAuthorityPort;
  notion: PreflightNotionPort;
  repository: PreflightRepositoryPort;
  registry: PreflightRegistryPort;
  sensitiveData?: SensitiveDataPolicy;
  remoteUrl?: () => Promise<string>;
  pushRemoteUrl?: () => Promise<string>;
  registryRoot?: () => Promise<string>;
  today?: () => string;
}

// Keep this local schema separate from Project Record parsing: preflight
// deliberately performs an unchanged-body write, not record adoption.
const IssueResponseSchema = z.object({
  node_id: z.string().min(1).max(128),
  number: z.number().int().safe().positive(),
  html_url: z.string().max(512).url(),
  title: z.string(),
  body: z.string(),
  labels: z.array(z.object({ name: z.string().min(1) }).passthrough()),
}).passthrough();

function credentials(environment: NodeJS.ProcessEnv): void {
  const project = environment.GH_PROJECT_TOKEN;
  const repo = environment.GH_REPO_TOKEN;
  if (!project) throw new ControlError("MISSING_CREDENTIAL", "Missing host credential", { key: "GH_PROJECT_TOKEN" });
  if (!repo) throw new ControlError("MISSING_CREDENTIAL", "Missing host credential", { key: "GH_REPO_TOKEN" });
  if (project === repo) throw new ControlError("CREDENTIALS_NOT_SEPARATE", "Project and Registry credentials must be distinct");
}

function parseHeaderResponse(stdout: string): Set<string> {
  const normalized = stdout.replaceAll("\r\n", "\n");
  const blocks = normalized.split("\n\n");
  const header = blocks.find((block) => /^HTTP\/\S+ 2\d\d(?:\s|$)/m.test(block));
  if (!header) throw new ControlError("PROJECT_SCOPE_UNVERIFIABLE", "Unable to verify classic Project token scopes");
  const lines = header.split("\n");
  const scopeLines = lines.filter((line) => /^x-oauth-scopes\s*:/i.test(line));
  if (scopeLines.length !== 1) throw new ControlError("PROJECT_SCOPE_UNVERIFIABLE", "Project token scope response was missing or ambiguous");
  const raw = scopeLines[0]?.slice((scopeLines[0]?.indexOf(":") ?? -1) + 1) ?? "";
  return new Set(raw.split(",").map((scope) => scope.trim()).filter(Boolean));
}

function parseJson<T>(stdout: string, schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, code: string): T {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new ControlError(code, "GitHub preflight returned invalid JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ControlError(code, "GitHub preflight returned an invalid response shape");
  return parsed.data;
}

function restHeaders(): string[] {
  return ["-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2026-03-10"];
}

function distinctProbeDate(original: string | undefined, proposed: string): string {
  if (original !== proposed) return proposed;
  const previous = new Date(`${proposed}T00:00:00.000Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  return previous.toISOString().slice(0, 10);
}

function isProvenProjectScopeFailure(cause: unknown): boolean {
  if (!(cause instanceof ControlError) || cause.code !== "COMMAND_FAILED") return false;
  const stderr = typeof cause.details.stderr === "string" ? cause.details.stderr : "";
  return /(?:resource not accessible by personal access token|insufficient (?:oauth )?scope|required scope|requires .*\bproject\b.*scope)/i.test(stderr);
}

function rethrowProjectProbeFailure(cause: unknown): never {
  if (isProvenProjectScopeFailure(cause)) {
    throw new ControlError(
      "PROJECT_TOKEN_REQUIRES_BROAD_REPO_SCOPE",
      "Narrow Project credential lacks a capability required by the private fixture",
    );
  }
  if (cause instanceof ControlError) throw cause;
  throw new ControlError("PREFLIGHT_PROJECT_INTEGRITY", "Project preflight fixture integrity could not be proven");
}

/** Live fail-closed probe for the intentionally split Project/Registry credentials. */
export class PreflightService {
  private readonly today: () => string;
  private readonly sensitiveData: SensitiveDataPolicy;

  constructor(private readonly options: PreflightServiceOptions) {
    if (!options.registry || typeof options.registry.assertReady !== "function") {
      throw new ControlError("INVALID_CONFIG", "Preflight requires the exact Registry readiness authority port");
    }
    this.today = options.today ?? (() => new Date().toISOString().slice(0, 10));
    this.sensitiveData = options.sensitiveData ?? createSensitiveDataPolicy(options.environment, [
      options.config.registryDir,
      options.config.stateDir,
      options.config.worktreeRoot,
    ]);
  }

  async run(): Promise<PreflightResult> {
    credentials(this.options.environment);
    await this.options.authority.observeCommittedLegacy();
    await this.options.notion.verifyReadOnlyRoutes();
    if (this.options.config.registryRepository.split("/", 1)[0]?.toLowerCase() !== this.options.config.githubOwner.toLowerCase()) {
      throw new ControlError("UNSUPPORTED_REGISTRY_OWNER", "Personal Project fixture must be in a repository owned by the configured user");
    }
    const scopeResult = await this.options.runner.runGh([
      "api", "--include", "--silent", "/user", ...restHeaders(),
    ], "project");
    const scopes = parseHeaderResponse(scopeResult.stdout);
    if (scopes.has("repo")) throw new ControlError("PROJECT_TOKEN_HAS_REPO_SCOPE", "Project token must not expose repo scope");
    if (!scopes.has("project")) throw new ControlError("PROJECT_SCOPE_MISSING", "Project token must expose project scope");
    if (scopes.size !== 1) throw new ControlError("PROJECT_SCOPE_NOT_EXACT", "Project token must expose exactly project scope");

    await this.options.repository.verifyPrivateRepository(this.options.config.registryRepository);
    await this.options.registry.assertReady();

    const observedRoot = this.options.registryRoot
      ? await this.options.registryRoot()
      : (await this.options.runner.run("git", ["rev-parse", "--show-toplevel"], {
        cwd: this.options.config.registryDir,
      })).stdout.trim();
    let configuredRoot: string;
    let actualRoot: string;
    try {
      [configuredRoot, actualRoot] = this.options.registryRoot
        ? [this.options.config.registryDir, observedRoot]
        : await Promise.all([realpath(this.options.config.registryDir), realpath(observedRoot)]);
    } catch {
      throw new ControlError("REGISTRY_ROOT_MISMATCH", "Registry directory is not the exact Git checkout root");
    }
    if (configuredRoot !== actualRoot) {
      throw new ControlError("REGISTRY_ROOT_MISMATCH", "Registry directory is not the exact Git checkout root");
    }

    const remote = this.options.remoteUrl
      ? await this.options.remoteUrl()
      : (await this.options.runner.run("git", ["remote", "get-url", "--all", this.options.config.registryRemote], {
        cwd: this.options.config.registryDir,
      })).stdout.trim();
    const remoteLines = remote.split("\n").map((line) => line.trim()).filter(Boolean);
    if (remoteLines.length !== 1) throw new ControlError("AMBIGUOUS_REGISTRY_REMOTE", "Registry remote must have exactly one URL");
    const remoteSlug = githubSlugFromRemote(remoteLines[0] as string, true);
    if (remoteSlug.toLowerCase() !== this.options.config.registryRepository.toLowerCase()) {
      throw new ControlError("REGISTRY_REMOTE_MISMATCH", "Registry remote does not match configured repository identity");
    }
    const pushRemote = this.options.pushRemoteUrl
      ? await this.options.pushRemoteUrl()
      : this.options.remoteUrl
        ? await this.options.remoteUrl()
        : (await this.options.runner.run(
          "git",
          ["remote", "get-url", "--push", "--all", this.options.config.registryRemote],
          { cwd: this.options.config.registryDir },
        )).stdout.trim();
    const pushRemoteLines = pushRemote.split("\n").map((line) => line.trim()).filter(Boolean);
    if (pushRemoteLines.length !== 1) {
      throw new ControlError("AMBIGUOUS_REGISTRY_REMOTE", "Registry remote must have exactly one effective push URL");
    }
    const pushRemoteSlug = githubSlugFromRemote(pushRemoteLines[0] as string, true);
    if (pushRemoteSlug.toLowerCase() !== this.options.config.registryRepository.toLowerCase()) {
      throw new ControlError("REGISTRY_REMOTE_MISMATCH", "Registry push URL does not match configured repository identity");
    }

    const registryStatus = await this.options.runner.run(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { cwd: this.options.config.registryDir },
    );
    if (registryStatus.stdout.length > 0) {
      throw new ControlError("REGISTRY_DIRTY", "Registry checkout must be clean before live preflight");
    }
    await this.options.runner.run(
      "git",
      ["fetch", this.options.config.registryRemote, this.options.config.registryBranch],
      { cwd: this.options.config.registryDir },
    );
    const localHead = (await this.options.runner.run("git", ["rev-parse", "HEAD"], {
      cwd: this.options.config.registryDir,
    })).stdout.trim();
    const remoteHead = (await this.options.runner.run(
      "git",
      ["rev-parse", `${this.options.config.registryRemote}/${this.options.config.registryBranch}`],
      { cwd: this.options.config.registryDir },
    )).stdout.trim();
    if (localHead !== remoteHead) {
      throw new ControlError("REMOTE_DIVERGED", "Registry checkout must equal the fetched remote branch head");
    }

    const issuePath = `repos/${this.options.config.registryRepository}/issues/${this.options.config.preflightRegistryIssueNumber}`;
    const issue = parseJson(
      (await this.options.runner.runGh(["api", issuePath, ...restHeaders()], "repo")).stdout,
      IssueResponseSchema,
      "INVALID_PREFLIGHT_ISSUE",
    );
    this.sensitiveData.assertSafe(issue);
    const expectedIssueUrl = `https://github.com/${this.options.config.registryRepository}/issues/${this.options.config.preflightRegistryIssueNumber}`;
    if (
      issue.number !== this.options.config.preflightRegistryIssueNumber ||
      issue.html_url.toLowerCase() !== expectedIssueUrl.toLowerCase()
    ) throw new ControlError("INVALID_PREFLIGHT_ISSUE", "Registry preflight Issue identity does not match configuration");
    const fixtureLabels = new Set(issue.labels.map((label) => label.name));
    if (!fixtureLabels.has("trial") || fixtureLabels.has("project-record")) {
      throw new ControlError("INVALID_PREFLIGHT_ISSUE", "The Registry preflight Issue must be trial-only");
    }

    await this.options.project.verifyFields();
    let attachedItemId: string;
    try {
      attachedItemId = await this.options.project.addPreflightItem(issue.node_id);
      const contentId = await this.options.project.verifyItemContentId(this.options.config.preflightProjectItemId);
      if (attachedItemId !== this.options.config.preflightProjectItemId || contentId !== issue.node_id) {
        throw new ControlError("PREFLIGHT_PROJECT_INTEGRITY", "Project fixture attachment does not match its source Issue");
      }
    } catch (cause) {
      rethrowProjectProbeFailure(cause);
    }

    let original: string | undefined;
    try {
      original = await this.options.project.readLastReviewed(this.options.config.preflightProjectItemId);
    } catch (cause) {
      rethrowProjectProbeFailure(cause);
    }
    const probeDate = distinctProbeDate(original, this.today());
    let probeFailure: unknown;
    try {
      await this.options.project.writeLastReviewed(
        this.options.config.preflightProjectItemId,
        probeDate,
      );
      if (await this.options.project.readLastReviewed(this.options.config.preflightProjectItemId) !== probeDate) {
        throw new ControlError("PREFLIGHT_PROJECT_INTEGRITY", "Project date probe did not persist the requested value");
      }
    } catch (cause) {
      probeFailure = cause;
    } finally {
      try {
        if (original === undefined) await this.options.project.clearLastReviewed(this.options.config.preflightProjectItemId);
        else await this.options.project.writeLastReviewed(this.options.config.preflightProjectItemId, original);
        if (await this.options.project.readLastReviewed(this.options.config.preflightProjectItemId) !== original) {
          throw new Error("restore readback mismatch");
        }
      } catch {
        throw new ControlError("PREFLIGHT_RESTORE_FAILED", "Unable to restore the Project preflight fixture");
      }
    }
    if (probeFailure) {
      rethrowProjectProbeFailure(probeFailure);
    }

    const updated = parseJson(
      (await this.options.runner.runGh([
        "api", "--method", "PATCH", issuePath, ...restHeaders(), "--raw-field", `body=${issue.body}`,
      ], "repo")).stdout,
      IssueResponseSchema,
      "INVALID_PREFLIGHT_ISSUE",
    );
    this.sensitiveData.assertSafe(updated);
    if (
      updated.node_id !== issue.node_id ||
      updated.number !== issue.number ||
      updated.html_url.toLowerCase() !== issue.html_url.toLowerCase() ||
      updated.body !== issue.body
    ) {
      throw new ControlError("INVALID_PREFLIGHT_ISSUE", "Registry Issue unchanged-write verification failed");
    }

    await this.options.runner.run("git", ["push", "--dry-run", this.options.config.registryRemote, `HEAD:${this.options.config.registryBranch}`], {
      cwd: this.options.config.registryDir,
    });

    return {
      status: "ready",
      checks: {
        credentials: "ok",
        authority: "ok",
        notion_guard: "ok",
        project: "ok",
        registry_repository: "ok",
        registry_issue: "ok",
        registry_git: "ok",
      },
    };
  }
}
