const { useEffect, useMemo, useRef, useState } = React;
const h = React.createElement;
const reviewData = JSON.parse(document.getElementById("review-data")?.textContent || "{}");

function cls(...parts) { return parts.filter(Boolean).join(" "); }
function baseName(path) { return String(path || "").split("/").pop() || path || ""; }
function parentName(path) { const value = String(path || ""); const idx = value.lastIndexOf("/"); return idx >= 0 ? value.slice(0, idx) : ""; }
function lineArray(text) { return String(text ?? "").split("\n"); }

const LANGUAGE_BY_EXT = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  json: "json", jsonc: "json", json5: "json",
  html: "xml", htm: "xml", xml: "xml", svg: "xml", vue: "xml", svelte: "xml", astro: "xml", plist: "xml",
  css: "css", scss: "scss", less: "less",
  md: "markdown", markdown: "markdown", mdx: "markdown",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin", kts: "kotlin", swift: "swift",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", m: "objectivec", mm: "objectivec",
  cs: "csharp", php: "php", sh: "bash", bash: "bash", zsh: "bash", yml: "yaml", yaml: "yaml",
  toml: "ini", ini: "ini", env: "ini", sql: "sql", graphql: "graphql", gql: "graphql", lua: "lua", pl: "perl", r: "r",
  diff: "diff", patch: "diff", txt: "plaintext", wasm: "wasm", vb: "vbnet",
};
const LANGUAGE_BY_NAME = { dockerfile: "dockerfile", makefile: "makefile", gnumakefile: "makefile", ".bashrc": "bash", ".zshrc": "bash", ".gitignore": "plaintext" };
const HIGHLIGHT_LIMIT = 400_000;

function languageFor(path) {
  const base = baseName(path).toLowerCase();
  const byName = LANGUAGE_BY_NAME[base];
  if (byName) return byName;
  const ext = base.includes(".") ? base.split(".").pop() : "";
  return LANGUAGE_BY_EXT[ext] || null;
}
function escapeHtml(text) { return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function splitHighlighted(html) {
  const lines = [];
  const open = [];
  let current = "";
  let last = 0;
  const re = /<span class="([^"]*)">|<\/span>|\n/g;
  let match;
  while ((match = re.exec(html))) {
    current += html.slice(last, match.index);
    last = re.lastIndex;
    if (match[0] === "\n") {
      lines.push(current + "</span>".repeat(open.length));
      current = open.map((name) => `<span class="${name}">`).join("");
    } else if (match[0] === "</span>") {
      open.pop();
      current += match[0];
    } else {
      open.push(match[1]);
      current += match[0];
    }
  }
  current += html.slice(last);
  lines.push(current + "</span>".repeat(open.length));
  return lines;
}
function highlightLines(text, path) {
  const source = String(text ?? "");
  const hljs = window.hljs;
  const language = languageFor(path);
  if (hljs && language && source.length <= HIGHLIGHT_LIMIT && hljs.getLanguage(language)) {
    try { return splitHighlighted(hljs.highlight(source, { language, ignoreIllegals: true }).value); } catch {}
  }
  return source.split("\n").map(escapeHtml);
}

function diffLines(a, b) {
  const n = a.length, m = b.length;
  const rows = [];
  let start = 0;
  while (start < n && start < m && a[start] === b[start]) start++;
  let endA = n, endB = m;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  for (let i = 0; i < start; i++) rows.push({ kind: "equal", old: i, new: i });
  const la = endA - start, lb = endB - start;
  const removed = [], added = [];
  const flush = () => {
    const count = Math.max(removed.length, added.length);
    for (let x = 0; x < count; x++) rows.push({ kind: x < removed.length && x < added.length ? "modified" : x < removed.length ? "removed" : "added", old: x < removed.length ? removed[x] : null, new: x < added.length ? added[x] : null });
    removed.length = 0;
    added.length = 0;
  };
  if (la * lb > 8_000_000) {
    for (let i = 0; i < la; i++) removed.push(start + i);
    for (let j = 0; j < lb; j++) added.push(start + j);
    flush();
  } else {
    const width = lb + 1;
    const dp = new Uint32Array((la + 1) * width);
    for (let i = la - 1; i >= 0; i--) for (let j = lb - 1; j >= 0; j--) {
      dp[i * width + j] = a[start + i] === b[start + j] ? dp[(i + 1) * width + j + 1] + 1 : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
    let i = 0, j = 0;
    while (i < la || j < lb) {
      if (i < la && j < lb && a[start + i] === b[start + j]) { flush(); rows.push({ kind: "equal", old: start + i, new: start + j }); i++; j++; }
      else if (j < lb && (i >= la || dp[i * width + j + 1] >= dp[(i + 1) * width + j])) { added.push(start + j); j++; }
      else { removed.push(start + i); i++; }
    }
    flush();
  }
  for (let k = 0; k < n - endA; k++) rows.push({ kind: "equal", old: endA + k, new: endB + k });
  return rows;
}
function visibleRowSet(rows, context) {
  const keep = new Set();
  rows.forEach((row, index) => {
    if (row.kind === "equal") return;
    for (let k = Math.max(0, index - context); k <= Math.min(rows.length - 1, index + context); k++) keep.add(k);
  });
  return keep;
}
function statusColor(status) { return status === "added" ? "text-zot-good" : status === "deleted" ? "text-zot-bad" : status === "renamed" ? "text-zot-warn" : "text-zot-accent"; }
function statusLabel(status) { return status ? status[0].toUpperCase() + status.slice(1) : ""; }
function scopeLabel(scope) { return scope === "git-diff" ? "Git diff" : scope === "last-commit" ? "Last commit" : scope === "commit" ? "Commit" : "All files"; }
function scopeHint(scope) {
  if (scope === "git-diff") return "Review working tree changes against HEAD.";
  if (scope === "last-commit") return "Review the last commit against its parent.";
  if (scope === "commit") return "Review a selected commit against its parent.";
  return "Review the current working tree snapshot.";
}
function scopeInstance(scope, commitSha) { return scope === "commit" ? `${scope}:${commitSha || ""}` : scope; }
function cacheKey(scope, commitSha, fileId) { return `${scopeInstance(scope, commitSha)}:${fileId}`; }
function getComparison(file, scope, commitSha) {
  if (!file) return null;
  if (scope === "git-diff") return file.gitDiff;
  if (scope === "last-commit") return file.lastCommit;
  if (scope === "commit") return commitSha ? file.commitComparisons?.[commitSha] || null : null;
  return null;
}
function displayPath(file, scope, commitSha) { return getComparison(file, scope, commitSha)?.displayPath || file?.path || ""; }
function filePath(file, scope, commitSha) { const cmp = getComparison(file, scope, commitSha); return cmp?.newPath || cmp?.oldPath || file?.path || ""; }
function canShowFile(file, scope, commitSha) {
  if (scope === "git-diff") return file.inGitDiff;
  if (scope === "last-commit") return file.inLastCommit;
  if (scope === "commit") return !!commitSha && !!file.commitComparisons?.[commitSha];
  return file.hasWorkingTreeFile;
}
function scopedFiles(scope, commitSha) { return (reviewData.files || []).filter((file) => canShowFile(file, scope, commitSha)); }
function requestId() { return `request:${Date.now()}:${Math.random().toString(16).slice(2)}`; }
function commentId() { return `${Date.now()}:${Math.random().toString(16).slice(2)}`; }
function normalize(value) { return String(value || "").trim().toLowerCase().replace(/\s+/g, ""); }
function scoreMatch(query, candidate) {
  if (!query) return 0;
  let qi = 0, score = 0, prev = -2, first = -1;
  for (let i = 0; i < candidate.length && qi < query.length; i++) {
    if (candidate[i] !== query[qi]) continue;
    if (first < 0) first = i;
    score += 10;
    if (i === prev + 1) score += 8;
    const p = i > 0 ? candidate[i - 1] : "";
    if (i === 0 || "/_-.".includes(p)) score += 12;
    prev = i;
    qi++;
  }
  if (qi !== query.length) return -1;
  return score + Math.max(0, 20 - first);
}
function filterFiles(files, query) {
  const q = normalize(query);
  if (!q) return files;
  return files.map((file) => {
    const path = String(file.path || "").toLowerCase();
    const base = baseName(path);
    const s = Math.max(scoreMatch(q, path), scoreMatch(q, base) + 40);
    return { file, score: s + (base.startsWith(q) ? 120 : path.includes(q) ? 35 : 0) };
  }).filter((entry) => entry.score >= 0).sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path)).map((entry) => entry.file);
}

function Button(props) {
  const { active, danger, children, className, ...rest } = props;
  return h("button", {
    ...rest,
    className: cls(
      "rounded-md border px-3 py-1.5 text-xs font-medium transition disabled:cursor-default disabled:opacity-50",
      active ? "border-zot-accent/50 bg-zot-accent/15 text-zot-accent" : danger ? "border-zot-border bg-zot-panel text-zot-text hover:border-zot-bad/50 hover:bg-zot-bad/10 hover:text-zot-bad" : "border-zot-border bg-zot-panel text-zot-text hover:bg-zot-panel-2",
      className,
    ),
  }, children);
}

function TextModal({ title, description, initialValue, saveLabel, onSave, onClose }) {
  const [value, setValue] = useState(initialValue || "");
  useEffect(() => {
    const onKey = (event) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return h("div", { className: "fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-5 backdrop-blur-sm", onMouseDown: (event) => { if (event.target === event.currentTarget) onClose(); } },
    h("div", { className: "w-full max-w-2xl rounded-xl border border-zot-border bg-zot-panel p-5 shadow-2xl" },
      h("div", { className: "text-base font-semibold text-white" }, title),
      h("div", { className: "mt-1 text-sm text-zot-muted" }, description),
      h("textarea", { autoFocus: true, value, onChange: (event) => setValue(event.target.value), className: "scrollbar-thin mt-4 min-h-44 w-full resize-y rounded-lg border border-zot-border bg-zot-bg p-3 text-sm text-zot-text outline-none focus:border-zot-accent" }),
      h("div", { className: "mt-4 flex justify-end gap-2" },
        h(Button, { onClick: onClose }, "Cancel"),
        h(Button, { active: true, onClick: () => { onSave(value.trim()); onClose(); } }, saveLabel || "Save"),
      ),
    ),
  );
}

function Header({ scope, filesCount, commentsCount, hasOverall, onOverall, onCancel, onSubmit }) {
  return h("header", { className: "flex h-14 shrink-0 items-center justify-between gap-4 border-b border-zot-border bg-[#0b0f18] px-4" },
    h("div", { className: "min-w-0" },
      h("div", { className: "text-sm font-semibold text-white" }, "zot peek"),
      h("div", { className: "truncate text-[11px] text-zot-muted" }, reviewData.repoRoot || ""),
    ),
    h("div", { className: "flex min-w-0 items-center gap-2" },
      h("div", { className: "hidden max-w-[26rem] truncate text-[11px] text-zot-muted md:block" }, `${scopeLabel(scope)}, ${filesCount} file(s), ${commentsCount} comment(s)${hasOverall ? ", overall note" : ""}`),
      h(Button, { onClick: onOverall }, "Overall note"),
      h(Button, { danger: true, onClick: onCancel }, "Cancel"),
      h(Button, { active: true, onClick: onSubmit }, "Finish review"),
    ),
  );
}

function Sidebar({ scope, setScope, commitSha, setCommitSha, activeFileId, setActiveFileId, query, setQuery, reviewed, comments, visibleFiles }) {
  const allCounts = {
    "git-diff": scopedFiles("git-diff", commitSha).length,
    "last-commit": scopedFiles("last-commit", commitSha).length,
    commit: scopedFiles("commit", commitSha).length,
    "all-files": scopedFiles("all-files", commitSha).length,
  };
  const scopes = [["git-diff", "Git diff"], ["last-commit", "Last commit"], ["commit", "Commits"], ["all-files", "All files"]];
  return h("aside", { className: "flex w-[310px] shrink-0 flex-col border-r border-zot-border bg-zot-bg" },
    h("div", { className: "border-b border-zot-border p-3" },
      h("div", { className: "mb-2 text-[11px] font-semibold uppercase tracking-wide text-zot-muted" }, "Scope"),
      h("div", { className: "mb-3 flex flex-wrap gap-2" }, scopes.map(([key, label]) => h(Button, { key, active: scope === key, disabled: allCounts[key] === 0, onClick: () => setScope(key) }, `${label}${allCounts[key] ? ` (${allCounts[key]})` : ""}`))),
      scope === "commit" && h("select", { value: commitSha || "", onChange: (event) => setCommitSha(event.target.value || null), className: "mb-3 w-full rounded-md border border-zot-border bg-zot-panel px-2 py-2 text-xs text-zot-text outline-none focus:border-zot-accent" },
        (reviewData.commits || []).map((commit) => h("option", { key: commit.sha, value: commit.sha }, `${commit.shortSha} ${commit.subject}`)),
      ),
      h("input", { value: query, onChange: (event) => setQuery(event.target.value), placeholder: "Search files", className: "w-full rounded-md border border-zot-border bg-zot-panel px-3 py-2 text-sm text-zot-text outline-none placeholder:text-zot-muted focus:border-zot-accent" }),
    ),
    h("div", { className: "scrollbar-thin min-h-0 flex-1 overflow-auto p-2" },
      visibleFiles.length === 0 ? h("div", { className: "p-3 text-sm text-zot-muted" }, "No files in this view.") : visibleFiles.map((file) => {
        const count = comments.filter((c) => c.fileId === file.id && c.scope === scope && (scope !== "commit" || c.commitSha === commitSha)).length;
        const status = getComparison(file, scope, commitSha)?.status || file.worktreeStatus;
        const active = file.id === activeFileId;
        return h("button", { key: file.id, onClick: () => setActiveFileId(file.id), className: cls("mb-1 flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left transition", active ? "bg-zot-panel-2 text-white" : "text-zot-text hover:bg-zot-panel") },
          h("span", { className: "min-w-0" },
            h("span", { className: "flex items-center gap-2" },
              h("span", { className: cls("text-[10px]", reviewed[file.id] ? "text-zot-good" : "text-zot-muted") }, reviewed[file.id] ? "●" : "○"),
              h("span", { className: "truncate text-sm" }, baseName(file.path)),
            ),
            h("span", { className: "mt-0.5 block truncate pl-5 text-[11px] text-zot-muted" }, parentName(file.path) || file.path),
          ),
          h("span", { className: "flex shrink-0 items-center gap-2" },
            count > 0 && h("span", { className: "rounded-full bg-zot-panel px-1.5 text-[10px] text-zot-text" }, count),
            status && h("span", { className: cls("text-xs font-semibold", statusColor(status)) }, statusLabel(status)[0]),
          ),
        );
      }),
    ),
  );
}

function CommentCard({ comment, onChange, onDelete }) {
  return h("div", { className: "rounded-lg border border-zot-border bg-zot-panel p-3" },
    h("div", { className: "mb-2 flex items-center justify-between gap-2" },
      h("div", { className: "text-xs font-semibold text-zot-muted" }, comment.side === "file" ? "File comment" : `${comment.side === "original" ? "Original" : "Modified"} line ${comment.startLine}`),
      h("button", { onClick: onDelete, className: "text-xs text-zot-muted hover:text-zot-bad" }, "Delete"),
    ),
    h("textarea", { value: comment.body, onChange: (event) => onChange(event.target.value), placeholder: "Leave a comment", className: "scrollbar-thin min-h-24 w-full resize-y rounded-md border border-zot-border bg-zot-bg p-2 text-sm text-zot-text outline-none focus:border-zot-accent" }),
  );
}

function CodePane({ title, rows, html, side, canComment, visible, comments, onAddComment, scrollRef, onScroll }) {
  const rendered = [];
  let lastIndex = -1;
  rows.forEach((row, index) => {
    if (visible && !visible.has(index)) return;
    if (visible && lastIndex >= 0 && index !== lastIndex + 1) {
      rendered.push(h("div", { key: `gap:${index}`, className: "select-none border-b border-zot-border/30 bg-zot-panel/60 px-4 py-0.5 text-[11px] text-zot-muted" }, `... ${index - lastIndex - 1} unchanged line(s)`));
    }
    lastIndex = index;
    const lineIndex = side === "original" ? row.old : row.new;
    if (lineIndex == null) {
      rendered.push(h("div", { key: index, className: "diff-filler grid min-w-max grid-cols-[4rem_2rem_1fr] border-b border-zot-border/30" }, h("div"), h("div"), h("pre", { className: "px-2 py-0.5" }, " ")));
      return;
    }
    const lineNo = lineIndex + 1;
    const changed = row.kind !== "equal";
    const hasComment = comments.some((c) => c.side === side && c.startLine === lineNo);
    rendered.push(h("div", { key: index, className: cls("group grid min-w-max grid-cols-[4rem_2rem_1fr] border-b border-zot-border/30", changed && (side === "original" ? "diff-removed" : "diff-added"), hasComment && "bg-zot-accent/10") },
      h("div", { className: "select-none px-2 py-0.5 text-right text-zot-muted" }, lineNo),
      h("button", { disabled: !canComment, onClick: () => onAddComment(side, lineNo), className: cls("select-none px-2 py-0.5 text-zot-muted", canComment ? "opacity-0 hover:text-zot-accent group-hover:opacity-100" : "opacity-20") }, "+"),
      h("pre", { className: "code-line whitespace-pre-wrap break-words px-2 py-0.5", dangerouslySetInnerHTML: { __html: html[lineIndex] || " " } }),
    ));
  });
  return h("section", { className: "flex min-w-0 flex-1 flex-col overflow-hidden border-r border-zot-border last:border-r-0" },
    h("div", { className: "shrink-0 border-b border-zot-border bg-zot-panel px-3 py-2 text-xs font-semibold text-zot-muted" }, title),
    h("div", { ref: scrollRef, onScroll, className: "scrollbar-thin code-font min-h-0 flex-1 overflow-auto bg-[#090d14] text-[12px] leading-5" }, rendered.length ? rendered : h("div", { className: "p-4 text-sm text-zot-muted" }, "No changed lines to show.")),
  );
}

function MainPane({ scope, commitSha, file, contents, loading, error, comments, setComments, reviewed, setReviewed, hideUnchanged, setHideUnchanged, wrap, setWrap, onFileComment }) {
  const comparison = getComparison(file, scope, commitSha);
  const showsDiff = !!comparison;
  const fileComments = file ? comments.filter((c) => c.fileId === file.id && c.scope === scope && (scope !== "commit" || c.commitSha === commitSha) && c.side === "file") : [];
  const inlineComments = file ? comments.filter((c) => c.fileId === file.id && c.scope === scope && (scope !== "commit" || c.commitSha === commitSha) && c.side !== "file") : [];
  const updateComment = (id, body) => setComments((items) => items.map((item) => item.id === id ? { ...item, body } : item));
  const deleteComment = (id) => setComments((items) => items.filter((item) => item.id !== id));
  const addInline = (side, line) => {
    if (!file) return;
    setComments((items) => [...items, { id: commentId(), fileId: file.id, scope, commitSha: scope === "commit" ? commitSha : undefined, side, startLine: line, endLine: line, body: "" }]);
  };

  const originalText = contents?.originalContent || "";
  const modifiedText = contents?.modifiedContent || "";
  const originalPath = comparison?.oldPath || file?.path || "";
  const modifiedPath = comparison?.newPath || file?.path || "";
  const originalLines = useMemo(() => lineArray(originalText), [originalText]);
  const modifiedLines = useMemo(() => lineArray(modifiedText), [modifiedText]);
  const originalHtml = useMemo(() => highlightLines(originalText, originalPath), [originalText, originalPath]);
  const modifiedHtml = useMemo(() => highlightLines(modifiedText, modifiedPath), [modifiedText, modifiedPath]);
  const rows = useMemo(() => showsDiff ? diffLines(originalLines, modifiedLines) : modifiedLines.map((_, i) => ({ kind: "equal", old: i, new: i })), [showsDiff, originalLines, modifiedLines]);
  const visible = useMemo(() => showsDiff && hideUnchanged ? visibleRowSet(rows, 3) : null, [showsDiff, hideUnchanged, rows]);
  const leftRef = useRef(null);
  const rightRef = useRef(null);
  const syncing = useRef(false);
  const syncScroll = (target) => (event) => {
    if (syncing.current || !target.current) return;
    syncing.current = true;
    target.current.scrollTop = event.currentTarget.scrollTop;
    target.current.scrollLeft = event.currentTarget.scrollLeft;
    requestAnimationFrame(() => { syncing.current = false; });
  };

  if (!file) return h("main", { className: "flex min-w-0 flex-1 items-center justify-center text-zot-muted" }, "No file selected.");
  return h("main", { className: "flex min-w-0 flex-1 flex-col bg-zot-bg" },
    h("div", { className: "flex shrink-0 items-center justify-between gap-4 border-b border-zot-border bg-zot-bg px-4 py-2" },
      h("div", { className: "min-w-0" },
        h("div", { className: "truncate text-sm font-semibold text-white" }, displayPath(file, scope, commitSha)),
        h("div", { className: "mt-0.5 text-[11px] text-zot-muted" }, scopeHint(scope)),
      ),
      h("div", { className: "flex shrink-0 items-center gap-2" },
        h(Button, { active: !!reviewed[file.id], onClick: () => setReviewed((value) => ({ ...value, [file.id]: !value[file.id] })) }, reviewed[file.id] ? "Reviewed" : "Mark reviewed"),
        h(Button, { onClick: () => setWrap((value) => !value) }, `Wrap: ${wrap ? "on" : "off"}`),
        showsDiff && h(Button, { active: hideUnchanged, onClick: () => setHideUnchanged((value) => !value) }, hideUnchanged ? "Show full file" : "Changed areas"),
        h(Button, { onClick: onFileComment }, "File comment"),
      ),
    ),
    fileComments.length > 0 && h("div", { className: "scrollbar-thin max-h-56 shrink-0 space-y-3 overflow-auto border-b border-zot-border p-3" }, fileComments.map((comment) => h(CommentCard, { key: comment.id, comment, onChange: (body) => updateComment(comment.id, body), onDelete: () => deleteComment(comment.id) }))),
    error ? h("div", { className: "m-4 rounded-lg border border-zot-bad/40 bg-zot-bad/10 p-4 text-sm text-zot-bad" }, error)
      : loading ? h("div", { className: "m-4 rounded-lg border border-zot-border bg-zot-panel p-4 text-sm text-zot-muted" }, "Loading file contents...")
      : h("div", { className: cls("min-h-0 flex-1 overflow-hidden", wrap ? "" : "[&_pre]:whitespace-pre") },
        showsDiff ? h("div", { className: "flex h-full min-w-0" },
          h(CodePane, { title: "Original", rows, html: originalHtml, side: "original", canComment: comparison.hasOriginal, visible, comments: inlineComments, onAddComment: addInline, scrollRef: leftRef, onScroll: syncScroll(rightRef) }),
          h(CodePane, { title: "Modified", rows, html: modifiedHtml, side: "modified", canComment: comparison.hasModified, visible, comments: inlineComments, onAddComment: addInline, scrollRef: rightRef, onScroll: syncScroll(leftRef) }),
        ) : h(CodePane, { title: filePath(file, scope, commitSha), rows, html: modifiedHtml, side: "modified", canComment: true, visible: null, comments: inlineComments, onAddComment: addInline }),
      ),
    inlineComments.length > 0 && h("div", { className: "scrollbar-thin grid max-h-72 shrink-0 grid-cols-1 gap-3 overflow-auto border-t border-zot-border p-3 xl:grid-cols-2" }, inlineComments.map((comment) => h(CommentCard, { key: comment.id, comment, onChange: (body) => updateComment(comment.id, body), onDelete: () => deleteComment(comment.id) }))),
  );
}

function App() {
  const initialScope = (reviewData.files || []).some((f) => f.inGitDiff) ? "git-diff" : (reviewData.files || []).some((f) => f.inLastCommit) ? "last-commit" : (reviewData.commits || []).length ? "commit" : "all-files";
  const [scope, setScopeValue] = useState(initialScope);
  const [commitSha, setCommitShaValue] = useState(reviewData.commits?.[0]?.sha || null);
  const [activeFileId, setActiveFileId] = useState(null);
  const [query, setQuery] = useState("");
  const [comments, setComments] = useState([]);
  const [overallComment, setOverallComment] = useState("");
  const [reviewed, setReviewed] = useState({});
  const [contents, setContents] = useState({});
  const [errors, setErrors] = useState({});
  const [pending, setPending] = useState({});
  const [hideUnchanged, setHideUnchanged] = useState(false);
  const [wrap, setWrap] = useState(true);
  const [modal, setModal] = useState(null);

  const files = useMemo(() => scopedFiles(scope, commitSha), [scope, commitSha]);
  const visibleFiles = useMemo(() => filterFiles(files, query), [files, query]);
  const activeFile = useMemo(() => files.find((file) => file.id === activeFileId) || files[0] || null, [files, activeFileId]);

  const setScope = (next) => {
    if (scopedFiles(next, commitSha).length === 0) return;
    setScopeValue(next);
    setActiveFileId(null);
  };
  const setCommitSha = (sha) => {
    setCommitShaValue(sha);
    setScopeValue("commit");
    setActiveFileId(null);
  };

  const key = activeFile ? cacheKey(scope, commitSha, activeFile.id) : null;
  useEffect(() => {
    if (!activeFile || !key || contents[key] || errors[key] || pending[key]) return;
    const id = requestId();
    setPending((value) => ({ ...value, [key]: id }));
    window.reviewBridge?.send({ type: "request-file", requestId: id, fileId: activeFile.id, scope, commitSha: scope === "commit" ? commitSha : undefined });
  }, [activeFile?.id, scope, commitSha]);

  useEffect(() => {
    window.__reviewReceive = (message) => {
      if (!message || typeof message !== "object") return;
      const key = cacheKey(message.scope, message.commitSha, message.fileId);
      if (message.type === "file-data") {
        setContents((value) => ({ ...value, [key]: { originalContent: message.originalContent, modifiedContent: message.modifiedContent } }));
        setErrors((value) => { const next = { ...value }; delete next[key]; return next; });
        setPending((value) => { const next = { ...value }; delete next[key]; return next; });
      } else if (message.type === "file-error") {
        setErrors((value) => ({ ...value, [key]: message.message || "Unknown error" }));
        setPending((value) => { const next = { ...value }; delete next[key]; return next; });
      }
    };
  }, []);

  const submit = () => {
    window.reviewBridge?.send({ type: "submit", overallComment: overallComment.trim(), comments: comments.map((c) => ({ ...c, body: c.body.trim() })).filter((c) => c.body.length > 0) });
    window.reviewBridge?.close();
  };
  const cancel = () => {
    window.reviewBridge?.send({ type: "cancel" });
    window.reviewBridge?.close();
  };
  const addFileComment = () => {
    if (!activeFile) return;
    setModal({ title: `File comment for ${displayPath(activeFile, scope, commitSha)}`, description: `This comment applies to the whole file in ${scopeLabel(scope).toLowerCase()}.`, saveLabel: "Add comment", initialValue: "", onSave: (body) => body && setComments((items) => [...items, { id: commentId(), fileId: activeFile.id, scope, commitSha: scope === "commit" ? commitSha : undefined, side: "file", startLine: null, endLine: null, body }]) });
  };

  return h("div", { className: "flex h-full w-full flex-col overflow-hidden" },
    h(Header, { scope, filesCount: files.length, commentsCount: comments.length, hasOverall: !!overallComment, onOverall: () => setModal({ title: "Overall review note", description: "This note is placed above the inline comments in the generated prompt.", saveLabel: "Save note", initialValue: overallComment, onSave: setOverallComment }), onCancel: cancel, onSubmit: submit }),
    h("div", { className: "flex min-h-0 flex-1" },
      h(Sidebar, { scope, setScope, commitSha, setCommitSha, activeFileId: activeFile?.id, setActiveFileId, query, setQuery, reviewed, comments, visibleFiles }),
      h(MainPane, { scope, commitSha, file: activeFile, contents: key ? contents[key] : null, loading: key ? !!pending[key] : false, error: key ? errors[key] : null, comments, setComments, reviewed, setReviewed, hideUnchanged, setHideUnchanged, wrap, setWrap, onFileComment: addFileComment }),
    ),
    modal && h(TextModal, { ...modal, onClose: () => setModal(null) }),
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(h(App));
