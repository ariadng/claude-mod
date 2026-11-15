# session-hud

A Claude Code mod that keeps the facts about your session in view: a status line under the prompt, and a side pane with this computer, the current project, Claude's task list and its subagents.

## Status line

Under the prompt, on one row:

```
you@example.com • Opus 5.5 Medium • 5H 6% 2:49PM • Weekly 24% Nov 16 3:59AM • Context 45% of 1M
```

- The signed-in account's email.
- The active model and the effort level actually in force.
- The 5-hour and weekly usage limits, each with when it resets.
- How full the context window is, and its size.

Percentages are green below 70%, yellow from 70% and red from 90%. Everything refreshes every minute and after each reply; the context figure updates live.

## Side pane

A 30-column pane beside the conversation, in four sections:

- **This computer** (titled with the machine's name): its local IP address, CPU and RAM use (every 3 seconds), and how full the disk under the working directory is, labelled SSD or HDD.
- **This Project**: the working directory and its git branch.
- **Progress**: Claude's task list. The task in progress has a spinner and a moving highlight. At most 5 tasks show; ctrl+t (or `t` while the pane has the keyboard) shows them all.
- **Subagents**: every subagent started in the session, with its model, name, status and task.

When a conversation is resumed, Claude Code starts it with an empty task list. The mod rebuilds the list from the conversation's own task calls and writes it back, so the pane and Claude both keep the same tasks.

`/account-usage` refreshes the status line on demand.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install session-hud --marketplace ariadng/claude-mod
```

Answer `y` to add the marketplace, then pick a scope.

From a shell:

```
claude plugin install session-hud --marketplace ariadng/claude-mod
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `ariadng/claude-mod`, then Add plugin.

## Requirements and notes

- The pane's icons are Nerd Font glyphs. Use a Nerd Font, or a terminal that draws them itself, such as Ghostty.
- The pane docks beside the conversation in fullscreen mode at 110 columns or wider.
- Usage limits are read from the account usage endpoint Claude Code's own login can reach, falling back to the figures in the last reply. The endpoint is undocumented and may change.
- Restoring the task list writes Claude Code's task files (`~/.claude/tasks/<session id>/`) in the format Claude Code itself writes. A future Claude Code version could change that format.
- Tested on macOS. The Linux and Windows code paths (machine name, IP address, CPU, RAM, disk) use those systems' standard commands but have not been run there.
