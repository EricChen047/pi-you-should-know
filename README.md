# You Should Know

A separately implemented Pi extension that periodically asks a configured observer model to inspect excerpts of the current session and shows only grounded, potentially useful reminders. Inspired by the product idea in [pi-you-should-know](https://github.com/aliceisjustplaying/pi-you-should-know); no upstream code or prompts were copied.

## Install

Install the package from GitHub:

```sh
pi install git:github.com/EricChen047/pi-you-should-know@v0.1.0
```

Run `/reload` in an existing session after installing or updating it. To update a Git installation, run `pi update --extensions`. To remove it, run:

```sh
pi remove git:github.com/EricChen047/pi-you-should-know
```

For local development, use `pi -e ./index.ts` or install the repository directory as a local package. Observation is disabled for new sessions by default.

## Usage

- `/ysk on`: enable observation in the current session branch.
- When a reminder appears in **fullscreen** TUI mode, click **Got it**, **View details**, or **Dismiss**. Opening the details does not dismiss the reminder. The details view can also put the finding in the editor for discussion; it never submits it automatically.
- Press **Ctrl+Alt+Y** to open the same actions without using the mouse; navigate with the arrow keys and Enter. In the details view, use the arrow keys or mouse wheel to scroll, `D` to discuss, and Esc to close. Existing editor text is preserved in the interactive TUI.
- In regular TUI mode, the terminal owns mouse input, so use **Ctrl+Alt+Y** or `/ysk` instead of clicking. The shortcut requires terminal support and may be intercepted by the OS or terminal; `/ysk` is the fallback. RPC clients also use `/ysk` because Pi's RPC UI does not support custom widgets or the shortcut.
- `/ysk status`: show the observer model, thinking level, state, check count, and separate usage.
- `/ysk model`: choose an authenticated observer model; use `/ysk model provider/model-id` to specify one directly, or `/ysk model current` to follow the main model. Model IDs can contain `/`.
- `/ysk thinking`: choose a level supported by the observer model, or use a command such as `/ysk thinking high`.
- `/ysk check`: request a manual check, subject to the same limit.
- `/ysk off`: disable observation, request cancellation of in-flight work, and clear the current reminder.
- `/ysk reset`: reset the displayed check counters while retaining cumulative usage; this is optional and does not affect the observer schedule.

When enabled, the observer attempts a check after every six completed agent turns with no fixed per-branch check limit. No further checks run while a reminder is pending. The observer runs asynchronously, has no tools, and never injects messages into the main agent automatically. Its interface is in English; model-generated reminders remain in the user's language.

The observer model and thinking level do not change the main agent. Defaults are the current main model and `low`. Selectable levels are those the model declares among `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; `off` is not offered. Models without thinking support receive no thinking parameter. Checks pause if the selected model does not support the configured level. Actual behavior depends on the provider.

New-session defaults are stored in `<agent-dir>/you-should-know/config.json` (normally `~/.pi/agent/you-should-know/config.json`), without session content. Each session branch retains its own settings snapshot; changing global defaults elsewhere does not silently change an enabled branch's provider. Changes made in the current branch take effect immediately. Changing providers while enabled requires confirmation; a virtual model may route to another provider.

The switch, reminders, and deduplication history are stored on the active Pi session branch. They are not included in model context or shared between projects. `/tree` restores the selected branch's state; `/new` and `/fork` start with observation off and no reminder history, using the global model defaults. Disabling the observer, changing model or thinking, navigating sessions or branches, or sending a new user input requests cancellation of an old check and discards stale results.

## Privacy and cost

Enabling observation sends **text excerpts and tool calls/results from the current session** to the selected observer model provider again. They may contain sensitive information and **are not automatically redacted**. Only text from the current active branch is sent, capped at 48,000 characters overall and 8,000 per item; images, thinking blocks, system prompts, tool definitions, and extension-internal messages are excluded. The observer must cite text from the excerpt, but it can still miss important issues or interpret them incorrectly.

Each request has a 45-second timeout, no automatic retries, and a requested maximum of 900 output tokens; providers may not enforce that limit. Overlong output triggers cancellation. There is no fixed check-count or strict monetary limit; cancelled or timed-out requests may still incur charges. `/ysk status` shows provider-reported usage and estimated cost, which may be incomplete after cancellation, timeout, or missing provider usage. Observer usage is not included in Pi's normal session totals or status bar.

## Offline verification

Node.js 26 and Python 3 are required. The tests start isolated Pi subprocesses with an in-memory mock model; they do not use the network or real credentials:

```sh
node --test tests/*.test.mjs
python3 tests/pi-tui-test.py
```
