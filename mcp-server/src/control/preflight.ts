import type { ControlConfig } from "./config.js";
import { ControlError } from "./errors.js";
import type { ProcessResult, ProcessRunOptions } from "./process.js";
import type { PreflightResult } from "./schemas.js";
import { z } from "zod";

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

export interface PreflightServiceOptions {
  config: ControlConfig;
  environment: NodeJS.ProcessEnv;
  runner: PreflightRunner;
  project: PreflightProjectPort;
  remoteUrl?: () => Promise<string>;
  today?: () => string;
}

// Keep this local schema separate from Project Record parsing: preflight
// deliberately performs an unchanged-body write, not record adoption.
const IssueResponseSchema = z.object({
  node_id: z.string().min(1),
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

function sshRemote(remote: string): boolean {
  return /^git@[A-Za-z0-9.-]+:[A-Za-z0-9._/-]+(?:\.git)?$/.test(remote) || /^ssh:\/\/[A-Za-z0-9@._-]+\/[A-Za-z0-9._/-]+(?:\.git)?$/.test(remote);
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

/** Live fail-closed probe for the intentionally split Project/Registry credentials. */
export class PreflightService {
  private readonly today: () => string;

  constructor(private readonly options: PreflightServiceOptions) {
    this.today = options.today ?? (() => new Date().toISOString().slice(0, 10));
  }

  async run(): Promise<PreflightResult> {
    credentials(this.options.environment);
    if (this.options.config.registryRepository.split("/", 1)[0]?.toLowerCase() !== this.options.config.githubOwner.toLowerCase()) {
      throw new ControlError("UNSUPPORTED_REGISTRY_OWNER", "Personal Project fixture must be in a repository owned by the configured user");
    }
    const scopeResult = await this.options.runner.runGh([
      "api", "--include", "--silent", "/user", ...restHeaders(),
    ], "project");
    const scopes = parseHeaderResponse(scopeResult.stdout);
    if (scopes.has("repo")) throw new ControlError("PROJECT_TOKEN_HAS_REPO_SCOPE", "Project token must not expose repo scope");
    if (!scopes.has("project")) throw new ControlError("PROJECT_SCOPE_MISSING", "Project token must expose project scope");

    const issuePath = `repos/${this.options.config.registryRepository}/issues/${this.options.config.preflightRegistryIssueNumber}`;
    const issue = parseJson(
      (await this.options.runner.runGh(["api", issuePath, ...restHeaders()], "repo")).stdout,
      IssueResponseSchema,
      "INVALID_PREFLIGHT_ISSUE",
    );
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
        throw new Error("fixture attach/source mismatch");
      }
    } catch {
      throw new ControlError(
        "PROJECT_TOKEN_REQUIRES_BROAD_REPO_SCOPE",
        "Narrow Project credential could not idempotently attach and identify the private fixture Issue",
      );
    }

    let original: string | undefined;
    try {
      original = await this.options.project.readLastReviewed(this.options.config.preflightProjectItemId);
    } catch {
      throw new ControlError("PROJECT_TOKEN_REQUIRES_BROAD_REPO_SCOPE", "Project date fixture is unavailable to the narrow credential");
    }
    let probeFailure: unknown;
    try {
      await this.options.project.writeLastReviewed(
        this.options.config.preflightProjectItemId,
        distinctProbeDate(original, this.today()),
      );
    } catch (cause) {
      probeFailure = cause;
    } finally {
      try {
        if (original === undefined) await this.options.project.clearLastReviewed(this.options.config.preflightProjectItemId);
        else await this.options.project.writeLastReviewed(this.options.config.preflightProjectItemId, original);
      } catch {
        throw new ControlError("PREFLIGHT_RESTORE_FAILED", "Unable to restore the Project preflight fixture");
      }
    }
    if (probeFailure) {
      throw new ControlError("PROJECT_TOKEN_REQUIRES_BROAD_REPO_SCOPE", "Project write probe failed with the narrow credential");
    }

    const updated = parseJson(
      (await this.options.runner.runGh([
        "api", "--method", "PATCH", issuePath, ...restHeaders(), "--raw-field", `body=${issue.body}`,
      ], "repo")).stdout,
      IssueResponseSchema,
      "INVALID_PREFLIGHT_ISSUE",
    );
    if (updated.node_id !== issue.node_id || updated.body !== issue.body) {
      throw new ControlError("INVALID_PREFLIGHT_ISSUE", "Registry Issue unchanged-write verification failed");
    }

    const remote = this.options.remoteUrl
      ? await this.options.remoteUrl()
      : (await this.options.runner.run("git", ["remote", "get-url", this.options.config.registryRemote], {
        cwd: this.options.config.registryDir,
      })).stdout.trim();
    if (!sshRemote(remote)) throw new ControlError("REGISTRY_REMOTE_NOT_SSH", "Registry preflight requires an SSH remote");
    await this.options.runner.run("git", ["fetch", this.options.config.registryRemote, this.options.config.registryBranch], { cwd: this.options.config.registryDir });
    await this.options.runner.run("git", ["push", "--dry-run", this.options.config.registryRemote, `HEAD:${this.options.config.registryBranch}`], {
      cwd: this.options.config.registryDir,
    });

    return {
      status: "ready",
      checks: { credentials: "ok", project: "ok", registry_issue: "ok", registry_git: "ok" },
    };
  }
}
