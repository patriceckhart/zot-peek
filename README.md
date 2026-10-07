# zot-peek

A [zot](https://www.zot.sh) extension that opens a browser based code review window for your repository. Browse the working tree diff, the last commit, or any recent commit side by side, leave inline comments, and hand the collected feedback back to zot as a ready-to-paste prompt.

## Features

- Side by side review of the working tree against `HEAD`, the last commit against its parent, or any of the last 50 commits.
- Aligned line diff with added, removed and modified rows highlighted, plus a "changed areas" mode that collapses unchanged code with context.
- Syntax highlighting via highlight.js for common languages (TypeScript, JavaScript, Go, Rust, Python, CSS, HTML, JSON, YAML, Markdown and more).
- Inline comments on original or modified lines, whole file comments, and an overall review note.
- Fuzzy file search and per file "reviewed" markers.
- On finish, the feedback is composed into a numbered prompt with file and line references and copied to the clipboard.
- The result is also shown in a zot panel in case clipboard access fails.

## Requirements

- [Bun](https://bun.sh) on `$PATH` (the extension runs from source via `bun`, no prebuilt binary is shipped).
- `git` on `$PATH` and a git repository as the working directory.
- A browser. The review UI loads React, Tailwind and highlight.js from public CDNs, so it needs network access the first time.
- A working [zot](https://github.com/patriceckhart/zot) installation with support for the `open_panel` command response.

## Install

```bash
zot ext install https://github.com/patriceckhart/zot-peek
```

Or clone / copy this directory into your zot extensions folder. zot will pick it up automatically based on `extension.json` (it's enabled by default).

## Usage

- Type `/peek` inside zot. A local server starts on a random port and your default browser opens the review window.
- Pick a scope in the sidebar: `Git diff`, `Last commit`, `Commits` (with a commit picker) or `All files`.
- Click a file to open it. Hover a line and press `+` to add an inline comment. Use `File comment` for whole file notes and `Overall note` for a general remark.
- Toggle `Wrap` and `Changed areas` in the file header, mark files as reviewed as you go.
- Press `Finish review` to generate the prompt. It is copied to the clipboard and shown in the zot panel. Paste it into the zot editor with `cmd+v`.
- `Cancel` closes the window without producing a prompt.

The generated prompt looks like this:

```
Please address the following feedback

Overall note goes here.

1. [git diff] src/app.ts:42 (new)
   Handle the null case here.
2. [last commit] README.md
   Mention the new flag.
```

## Files

| File | Purpose |
|------|---------|
| `extension.json` | zot extension manifest. |
| `index.ts` | Extension source: git integration, local server, prompt composition. |
| `web/index.html` | Review UI shell, theme and syntax highlighting styles. |
| `web/app.js` | Review UI (React), diffing and highlighting logic. |

## License

MIT
