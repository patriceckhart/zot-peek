#!/usr/bin/env bun
import { createInterface } from "node:readline";
import { stdin, stdout, stderr, platform } from "node:process";
import { extname, join } from "node:path";
import { readFile } from "node:fs/promises";

const VERSION = "1.0.0";

type Json = Record<string, any>;
type ReviewScope = "git-diff" | "last-commit" | "commit" | "all-files";
type ChangeStatus = "modified" | "added" | "deleted" | "renamed";
type CommentSide = "original" | "modified" | "file";

interface ChangedPath { status: ChangeStatus; oldPath: string | null; newPath: string | null }
interface ReviewFileComparison { status: ChangeStatus; oldPath: string | null; newPath: string | null; displayPath: string; hasOriginal: boolean; hasModified: boolean }
interface ReviewCommit { sha: string; shortSha: string; subject: string }
interface ReviewFile { id: string; path: string; worktreeStatus: ChangeStatus | null; hasWorkingTreeFile: boolean; inGitDiff: boolean; inLastCommit: boolean; gitDiff: ReviewFileComparison | null; lastCommit: ReviewFileComparison | null; commitComparisons: Record<string, ReviewFileComparison> }
interface ReviewFileContents { originalContent: string; modifiedContent: string }
interface DiffReviewComment { id: string; fileId: string; scope: ReviewScope; commitSha?: string; side: CommentSide; startLine: number | null; endLine: number | null; body: string }
interface ReviewSubmitPayload { type: "submit"; overallComment: string; comments: DiffReviewComment[] }
interface ReviewCancelPayload { type: "cancel" }
interface ReviewRequestFilePayload { type: "request-file"; requestId: string; fileId: string; scope: ReviewScope; commitSha?: string }

type ReviewWindowMessage = ReviewSubmitPayload | ReviewCancelPayload | ReviewRequestFilePayload;

let cwd = process.cwd();
const activeServers = new Set<ServerSession>();

function send(frame: Json): void {
  stdout.write(JSON.stringify(frame) + "\n");
}

function log(message: string): void {
  stderr.write(`[zot-peek] ${message}\n`);
}

async function run(command: string, args: string[], options: { cwd?: string } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([command, ...args], { cwd: options.cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout: out, stderr: err };
}

async function runGit(repoRoot: string, args: string[]): Promise<string> {
  const result = await run("git", args, { cwd: repoRoot });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout;
}

async function runGitAllowFailure(repoRoot: string, args: string[]): Promise<string> {
  const result = await run("git", args, { cwd: repoRoot });
  return result.code === 0 ? result.stdout : "";
}

async function getRepoRoot(startCwd: string): Promise<string> {
  const result = await run("git", ["rev-parse", "--show-toplevel"], { cwd: startCwd });
  if (result.code !== 0) throw new Error("Not inside a git repository.");
  return result.stdout.trim();
}

async function hasHead(repoRoot: string): Promise<boolean> {
  return (await run("git", ["rev-parse", "--verify", "HEAD"], { cwd: repoRoot })).code === 0;
}

function parseNameStatus(output: string): ChangedPath[] {
  const changes: ChangedPath[] = [];
  for (const line of output.split(/\r?\n/).map((v) => v.trim()).filter(Boolean)) {
    const parts = line.split("\t");
    const code = (parts[0] ?? "")[0];
    if (code === "R" && parts[1] && parts[2]) changes.push({ status: "renamed", oldPath: parts[1], newPath: parts[2] });
    else if (code === "M" && parts[1]) changes.push({ status: "modified", oldPath: parts[1], newPath: parts[1] });
    else if (code === "A" && parts[1]) changes.push({ status: "added", oldPath: null, newPath: parts[1] });
    else if (code === "D" && parts[1]) changes.push({ status: "deleted", oldPath: parts[1], newPath: null });
  }
  return changes;
}

function parseUntrackedPaths(output: string): ChangedPath[] {
  return output.split(/\r?\n/).map((v) => v.trim()).filter(Boolean).map((path) => ({ status: "added", oldPath: null, newPath: path }));
}

function parseTrackedPaths(output: string): string[] {
  return output.split(/\r?\n/).map((v) => v.trim()).filter(Boolean);
}

function mergeChangedPaths(tracked: ChangedPath[], untracked: ChangedPath[]): ChangedPath[] {
  const seen = new Set(tracked.map((c) => `${c.status}:${c.oldPath ?? ""}:${c.newPath ?? ""}`));
  const merged = [...tracked];
  for (const change of untracked) {
    const key = `${change.status}:${change.oldPath ?? ""}:${change.newPath ?? ""}`;
    if (!seen.has(key)) {
      merged.push(change);
      seen.add(key);
    }
  }
  return merged;
}

function unique<T>(values: T[]): T[] { return [...new Set(values)]; }
function toDisplayPath(change: ChangedPath): string { return change.status === "renamed" ? `${change.oldPath ?? ""} -> ${change.newPath ?? ""}` : change.newPath ?? change.oldPath ?? "(unknown)"; }
function toComparison(change: ChangedPath): ReviewFileComparison { return { status: change.status, oldPath: change.oldPath, newPath: change.newPath, displayPath: toDisplayPath(change), hasOriginal: change.oldPath != null, hasModified: change.newPath != null }; }
function buildReviewFileId(path: string, hasWorkingTreeFile: boolean, gitDiff: ReviewFileComparison | null, lastCommit: ReviewFileComparison | null): string { return [path, hasWorkingTreeFile ? "working" : "gone", gitDiff?.displayPath ?? "", lastCommit?.displayPath ?? ""].join("::"); }

function parseCommitLog(output: string): ReviewCommit[] {
  return output.split(/\r?\n/).map((v) => v.trim()).filter(Boolean).map((line) => {
    const [sha = "", shortSha = "", ...subjectParts] = line.split("\t");
    return { sha, shortSha, subject: subjectParts.join("\t") };
  }).filter((commit) => commit.sha.length > 0);
}

function isReviewableFilePath(path: string): boolean {
  const lowerPath = path.toLowerCase();
  const fileName = lowerPath.split("/").pop() ?? lowerPath;
  const extension = extname(fileName);
  const binaryExtensions = new Set([".7z", ".a", ".avi", ".avif", ".bin", ".bmp", ".class", ".dll", ".dylib", ".eot", ".exe", ".gif", ".gz", ".ico", ".jar", ".jpeg", ".jpg", ".lockb", ".map", ".mov", ".mp3", ".mp4", ".o", ".otf", ".pdf", ".png", ".pyc", ".so", ".svgz", ".tar", ".ttf", ".wasm", ".webm", ".webp", ".woff", ".woff2", ".zip"]);
  return fileName.length > 0 && !binaryExtensions.has(extension) && !fileName.endsWith(".min.js") && !fileName.endsWith(".min.css");
}

function upsertSeed<T>(map: Map<string, T>, key: string, create: () => T): T {
  const existing = map.get(key);
  if (existing) return existing;
  const value = create();
  map.set(key, value);
  return value;
}

async function getReviewWindowData(startCwd: string): Promise<{ repoRoot: string; files: ReviewFile[]; commits: ReviewCommit[] }> {
  const repoRoot = await getRepoRoot(startCwd);
  const repositoryHasHead = await hasHead(repoRoot);
  const trackedDiffOutput = repositoryHasHead ? await runGit(repoRoot, ["diff", "--find-renames", "-M", "--name-status", "HEAD", "--"]) : "";
  const untrackedOutput = await runGitAllowFailure(repoRoot, ["ls-files", "--others", "--exclude-standard"]);
  const trackedFilesOutput = await runGitAllowFailure(repoRoot, ["ls-files", "--cached"]);
  const deletedFilesOutput = await runGitAllowFailure(repoRoot, ["ls-files", "--deleted"]);
  const lastCommitOutput = repositoryHasHead ? await runGitAllowFailure(repoRoot, ["diff-tree", "--root", "--find-renames", "-M", "--name-status", "--no-commit-id", "-r", "HEAD"]) : "";
  const commits = repositoryHasHead ? parseCommitLog(await runGitAllowFailure(repoRoot, ["log", "--max-count=50", "--format=%H%x09%h%x09%s"])) : [];
  const commitChanges = new Map<string, ChangedPath[]>();
  for (const commit of commits) {
    const output = await runGitAllowFailure(repoRoot, ["diff-tree", "--root", "--find-renames", "-M", "--name-status", "--no-commit-id", "-r", commit.sha]);
    commitChanges.set(commit.sha, parseNameStatus(output).filter((change) => isReviewableFilePath(change.newPath ?? change.oldPath ?? "")));
  }

  const worktreeChanges = mergeChangedPaths(parseNameStatus(trackedDiffOutput), parseUntrackedPaths(untrackedOutput)).filter((change) => isReviewableFilePath(change.newPath ?? change.oldPath ?? ""));
  const deletedPaths = new Set(parseTrackedPaths(deletedFilesOutput));
  const currentPaths = unique([...parseTrackedPaths(trackedFilesOutput), ...parseTrackedPaths(untrackedOutput)]).filter((path) => !deletedPaths.has(path)).filter(isReviewableFilePath);
  const lastCommitChanges = parseNameStatus(lastCommitOutput).filter((change) => isReviewableFilePath(change.newPath ?? change.oldPath ?? ""));

  type Seed = Omit<ReviewFile, "id">;
  const seeds = new Map<string, Seed>();
  for (const path of currentPaths) seeds.set(path, { path, worktreeStatus: null, hasWorkingTreeFile: true, inGitDiff: false, inLastCommit: false, gitDiff: null, lastCommit: null, commitComparisons: {} });
  for (const change of worktreeChanges) {
    const key = change.newPath ?? change.oldPath ?? toDisplayPath(change);
    const seed = upsertSeed(seeds, key, () => ({ path: key, worktreeStatus: null, hasWorkingTreeFile: change.newPath != null, inGitDiff: false, inLastCommit: false, gitDiff: null, lastCommit: null, commitComparisons: {} }));
    seed.worktreeStatus = change.status; seed.hasWorkingTreeFile = change.newPath != null; seed.inGitDiff = true; seed.gitDiff = toComparison(change);
  }
  for (const change of lastCommitChanges) {
    const key = change.newPath ?? change.oldPath ?? toDisplayPath(change);
    const seed = upsertSeed(seeds, key, () => ({ path: key, worktreeStatus: null, hasWorkingTreeFile: change.newPath != null && currentPaths.includes(change.newPath), inGitDiff: false, inLastCommit: false, gitDiff: null, lastCommit: null, commitComparisons: {} }));
    seed.inLastCommit = true; seed.lastCommit = toComparison(change);
  }
  for (const [commitSha, changes] of commitChanges) for (const change of changes) {
    const key = change.newPath ?? change.oldPath ?? toDisplayPath(change);
    const seed = upsertSeed(seeds, key, () => ({ path: key, worktreeStatus: null, hasWorkingTreeFile: change.newPath != null && currentPaths.includes(change.newPath), inGitDiff: false, inLastCommit: false, gitDiff: null, lastCommit: null, commitComparisons: {} }));
    seed.commitComparisons[commitSha] = toComparison(change);
  }

  const files = [...seeds.values()].map((seed) => ({ id: buildReviewFileId(seed.path, seed.hasWorkingTreeFile, seed.gitDiff, seed.lastCommit), ...seed })).sort((a, b) => a.path.localeCompare(b.path));
  return { repoRoot, files, commits };
}

async function getRevisionContent(repoRoot: string, revision: string, path: string): Promise<string> {
  const result = await run("git", ["show", `${revision}:${path}`], { cwd: repoRoot });
  return result.code === 0 ? result.stdout : "";
}

async function getWorkingTreeContent(repoRoot: string, path: string): Promise<string> {
  try { return await readFile(join(repoRoot, path), "utf8"); } catch { return ""; }
}

async function loadReviewFileContents(repoRoot: string, file: ReviewFile, scope: ReviewScope, commitSha?: string): Promise<ReviewFileContents> {
  if (scope === "all-files") {
    const content = file.hasWorkingTreeFile ? await getWorkingTreeContent(repoRoot, file.path) : "";
    return { originalContent: content, modifiedContent: content };
  }
  const comparison = scope === "git-diff" ? file.gitDiff : scope === "commit" && commitSha ? file.commitComparisons[commitSha] : file.lastCommit;
  if (!comparison) return { originalContent: "", modifiedContent: "" };
  const originalRevision = scope === "git-diff" ? "HEAD" : scope === "commit" && commitSha ? `${commitSha}^` : "HEAD^";
  const modifiedRevision = scope === "git-diff" ? null : scope === "commit" && commitSha ? commitSha : "HEAD";
  return {
    originalContent: comparison.oldPath == null ? "" : await getRevisionContent(repoRoot, originalRevision, comparison.oldPath),
    modifiedContent: comparison.newPath == null ? "" : modifiedRevision == null ? await getWorkingTreeContent(repoRoot, comparison.newPath) : await getRevisionContent(repoRoot, modifiedRevision, comparison.newPath),
  };
}

function formatScopeLabel(scope: ReviewScope): string {
  return scope === "git-diff" ? "git diff" : scope === "last-commit" ? "last commit" : scope === "commit" ? "commit" : "all files";
}

function composeReviewPrompt(files: ReviewFile[], payload: ReviewSubmitPayload): string {
  const fileMap = new Map(files.map((file) => [file.id, file]));
  const lines = ["Please address the following feedback", ""];
  if (payload.overallComment.trim()) lines.push(payload.overallComment.trim(), "");
  payload.comments.forEach((comment, index) => {
    const file = fileMap.get(comment.fileId);
    const comparison = comment.scope === "git-diff" ? file?.gitDiff : comment.scope === "last-commit" ? file?.lastCommit : comment.scope === "commit" && comment.commitSha ? file?.commitComparisons[comment.commitSha] : null;
    const filePath = comparison?.displayPath ?? file?.path ?? "(unknown file)";
    const scopePrefix = comment.scope === "commit" && comment.commitSha ? `[commit ${comment.commitSha.slice(0, 12)}] ` : `[${formatScopeLabel(comment.scope)}] `;
    const location = comment.side === "file" || comment.startLine == null ? `${scopePrefix}${filePath}` : `${scopePrefix}${filePath}:${comment.endLine != null && comment.endLine !== comment.startLine ? `${comment.startLine}-${comment.endLine}` : comment.startLine}${comment.scope !== "all-files" ? comment.side === "original" ? " (old)" : " (new)" : ""}`;
    lines.push(`${index + 1}. ${location}`, `   ${comment.body.trim()}`, "");
  });
  return lines.join("\n").trim();
}

function escapeForInlineScript(value: string): string {
  return value.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

async function buildReviewHtml(data: Json, wsUrl: string): Promise<string> {
  const webDir = join(import.meta.dir, "web");
  const template = await readFile(join(webDir, "index.html"), "utf8");
  const app = await readFile(join(webDir, "app.js"), "utf8");
  const bridge = `
(() => {
  const ws = new WebSocket(${JSON.stringify(wsUrl)});
  const pending = [];
  window.reviewBridge = {
    send(message) { const encoded = JSON.stringify(message); ws.readyState === 1 ? ws.send(encoded) : pending.push(encoded); },
    close() { setTimeout(() => window.close(), 50); }
  };
  ws.addEventListener("open", () => { while (pending.length) ws.send(pending.shift()); });
  ws.addEventListener("message", (event) => window.__reviewReceive?.(JSON.parse(event.data)));
})();`;
  return template.replace("__INLINE_DATA__", escapeForInlineScript(JSON.stringify(data))).replace("__BRIDGE_JS__", bridge).replace("__INLINE_JS__", app);
}

class ServerSession {
  server?: Bun.Server;
  ws?: ServerWebSocket<unknown>;
  settled = false;
  fileMap: Map<string, ReviewFile>;
  contentCache = new Map<string, Promise<ReviewFileContents>>();

  constructor(public repoRoot: string, public files: ReviewFile[], public commits: ReviewCommit[], public resolve: (value: ReviewSubmitPayload | ReviewCancelPayload | null) => void) {
    this.fileMap = new Map(files.map((file) => [file.id, file]));
  }

  settle(value: ReviewSubmitPayload | ReviewCancelPayload | null): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve(value);
    setTimeout(() => this.close(), 250);
  }

  close(): void {
    activeServers.delete(this);
    try { this.ws?.close(); } catch {}
    try { this.server?.stop(true); } catch {}
  }

  send(message: Json): void {
    this.ws?.send(JSON.stringify(message));
  }

  async handleRequest(message: ReviewRequestFilePayload): Promise<void> {
    const file = this.fileMap.get(message.fileId);
    if (!file) {
      this.send({ type: "file-error", requestId: message.requestId, fileId: message.fileId, scope: message.scope, commitSha: message.commitSha, message: "Unknown file requested." });
      return;
    }
    const cacheKey = `${message.scope}:${message.commitSha ?? ""}:${file.id}`;
    let pending = this.contentCache.get(cacheKey);
    if (!pending) {
      pending = loadReviewFileContents(this.repoRoot, file, message.scope, message.commitSha);
      this.contentCache.set(cacheKey, pending);
    }
    try {
      const contents = await pending;
      this.send({ type: "file-data", requestId: message.requestId, fileId: message.fileId, scope: message.scope, commitSha: message.commitSha, ...contents });
    } catch (error) {
      this.send({ type: "file-error", requestId: message.requestId, fileId: message.fileId, scope: message.scope, commitSha: message.commitSha, message: error instanceof Error ? error.message : String(error) });
    }
  }
}

async function openBrowser(url: string): Promise<void> {
  const opener = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  await run(opener, args).catch((error) => log(`failed to open browser: ${error}`));
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (platform === "darwin") {
      const proc = Bun.spawn(["pbcopy"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
      proc.stdin.write(text);
      proc.stdin.end();
      return await proc.exited === 0;
    }
    if (platform === "win32") {
      const proc = Bun.spawn(["clip"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
      proc.stdin.write(text);
      proc.stdin.end();
      return await proc.exited === 0;
    }
    const proc = Bun.spawn(["xclip", "-selection", "clipboard"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    proc.stdin.write(text);
    proc.stdin.end();
    return await proc.exited === 0;
  } catch {
    return false;
  }
}

function panelLinesForPrompt(prompt: string): string[] {
  const lines = prompt.split("\n");
  return lines.length > 120 ? [...lines.slice(0, 120), "", `... ${lines.length - 120} more line(s) copied to clipboard`] : lines;
}

async function openReviewWindow(startCwd: string): Promise<string | null> {
  const data = await getReviewWindowData(startCwd);
  if (data.files.length === 0) throw new Error("No reviewable files found.");

  let session!: ServerSession;
  const terminal = new Promise<ReviewSubmitPayload | ReviewCancelPayload | null>((resolve) => {
    session = new ServerSession(data.repoRoot, data.files, data.commits, resolve);
  });

  const server = Bun.serve({
    port: 0,
    fetch: async (req, srv) => {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        return srv.upgrade(req) ? undefined : new Response("upgrade failed", { status: 400 });
      }
      const wsUrl = `ws://127.0.0.1:${srv.port}/ws`;
      return new Response(await buildReviewHtml(data, wsUrl), { headers: { "content-type": "text/html; charset=utf-8" } });
    },
    websocket: {
      open(ws) { session.ws = ws; },
      close() { if (!session.settled) session.settle(null); },
      message(_ws, raw) {
        let message: ReviewWindowMessage;
        try { message = JSON.parse(String(raw)); } catch { return; }
        if (message.type === "request-file") void session.handleRequest(message);
        else if (message.type === "submit" || message.type === "cancel") session.settle(message);
      },
    },
  });

  session.server = server;
  activeServers.add(session);
  await openBrowser(`http://127.0.0.1:${server.port}/`);
  const result = await terminal;
  if (!result || result.type === "cancel") return null;
  return composeReviewPrompt(data.files, result);
}

send({ type: "hello", name: "zot-peek", version: VERSION, capabilities: ["commands"] });
send({ type: "register_command", name: "peek", description: "Open a review window for repository changes" });
send({ type: "ready" });

const rl = createInterface({ input: stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  let frame: Json;
  try { frame = JSON.parse(line); } catch { return; }
  if (frame.type === "hello_ack" && typeof frame.cwd === "string") {
    cwd = frame.cwd;
    return;
  }
  if (frame.type === "command_invoked" && frame.name === "peek") {
    const panelId = `zot-peek:${frame.id ?? Date.now()}`;
    send({
      type: "command_response",
      id: frame.id,
      action: "open_panel",
      open_panel: {
        id: panelId,
        title: "zot peek",
        lines: ["Review window opened.", "Finish the review in the browser window.", "The generated prompt will be copied to the clipboard."],
        footer: "esc closes this panel, the browser window stays open",
      },
    });

    void (async () => {
      try {
        const prompt = await openReviewWindow(cwd);
        if (prompt == null) {
          send({ type: "panel_render", panel_id: panelId, title: "zot peek", lines: ["Review cancelled."], footer: "" });
          return;
        }
        const copied = await copyToClipboard(prompt);
        send({
          type: "panel_render",
          panel_id: panelId,
          title: "zot peek feedback",
          lines: copied ? ["Feedback prompt copied to clipboard.", "", ...panelLinesForPrompt(prompt)] : ["Feedback prompt ready, clipboard copy failed.", "", ...panelLinesForPrompt(prompt)],
          footer: copied ? "paste into the zot editor with cmd+v" : "copy the prompt from this panel",
        });
        send({ type: "notify", level: copied ? "success" : "warn", message: copied ? "Review feedback copied to clipboard." : "Review feedback is ready in the panel." });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        send({ type: "panel_render", panel_id: panelId, title: "zot peek", lines: [`Review failed: ${message}`], footer: "" });
        send({ type: "notify", level: "error", message: `Review failed: ${message}` });
      }
    })();
    return;
  }
  if (frame.type === "shutdown") {
    for (const session of [...activeServers]) session.close();
    send({ type: "shutdown_ack" });
    rl.close();
  }
});
