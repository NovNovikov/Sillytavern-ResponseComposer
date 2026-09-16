# Multi-Stage Response Composer

SillyTavern extension that constructs one ordinary assistant reply from a sequential pipeline:

```text
PRE blocks → MAIN → POST blocks → one saved assistant message
```

`MAIN` is SillyTavern's normal generation. The extension does not replace its generation controls or create a second chat message. PRE and POST stages can make extra LLM requests or insert static text; their output is assembled around the MAIN result before the reply is committed.

## Features

- Sequential `PRE → MAIN → POST` pipeline.
- LLM and static-text auxiliary blocks.
- Per-block enable switch, output visibility, regex processing and output extraction.
- Any block can run always, when the preceding output matches a JavaScript RegExp, when the assembled MAIN prompt contains text, or when a Quick Reply returns `true`.
- PRE results are propagated after chat history and before Post-History Instruction.
- POST results are assembled into the same visible assistant message as MAIN.
- Swipe, regenerate and continue support. A block can be kept on a swipe; its current switch setting controls the next swipe while the source swipe supplies the stored output.
- Only MAIN reasoning is retained as normal reasoning. Auxiliary reasoning is discarded.
- Hidden stage data and assembly data are kept per swipe in message metadata; discarded output is not saved.
- A failed auxiliary block is omitted and later blocks continue. Stopping the generation still stops the whole pipeline.
- Abort and finalizer failures use Tavern's normal generation cleanup path.

## Requirements

This extension requires the accompanying SillyTavern core hooks. Vanilla SillyTavern does not currently provide the generation-finalizer and Prompt Manager APIs used here.

The required core commits are bundled with the extension. They were created against the `release` checkout whose base commit is `9d7e6ab64`.

### One-click core installation

Double-click [`Install-Core-Hooks.cmd`](Install-Core-Hooks.cmd), choose the SillyTavern source directory (the folder containing `.git` and `public\script.js`), and let it complete. It applies the bundled hooks in the required order.

The installer checks the hook version. On a fresh checkout it applies the full series; on a checkout with an earlier Composer hook series it applies only the missing update. It is not tied to a specific SillyTavern fork or commit: it tries to apply the required patch with Git's three-way merge. If the selected version has incompatible source changes, Git reports a conflict and the installer aborts its own attempt, leaving the checkout unchanged. It also refuses a checkout with uncommitted changes and checks for an existing rebase. Git for Windows is required.

For unattended use, pass the checkout path explicitly:

```powershell
.\Install-Core-Hooks.ps1 -SillyTavernPath 'L:\path\to\SillyTavern'
```

The Connection Manager extension is needed for a block that selects a Connection Profile. A block can otherwise fall back to the currently selected Chat Completion connection.

## Installation

Clone this repository into the user's third-party extension directory:

```powershell
git clone https://github.com/NovNovikov/Sillytavern-ResponseComposer.git `
  SillyTavernData\default-user\extensions\st-message-constructor
```

For development, a directory junction or symbolic link to this repository works as well. Restart SillyTavern or use `Ctrl+F5` after updating the extension.

## Creating a pipeline

1. Enable the composer and create a pipeline preset.
2. Add PRE blocks above `MAIN MESSAGE` and POST blocks below it.
3. Choose `Generate with LLM` or `Static Text` for each auxiliary block.
4. Select its Connection Profile and, when applicable, its Prompt OAI Preset.
5. Choose whether the output is visible, hidden, or discarded after use.

Stages always execute in screen order. MAIN cannot be removed and always uses the normal SillyTavern generation flow.

### Connection Profile and Prompt OAI Preset

These fields intentionally have separate jobs:

- **Connection Profile** selects API source, endpoint, model, credentials and the profile's generation preset. Its preset supplies request settings, including Custom endpoint **Additional Parameters** such as `chat_template_kwargs`.
- **Prompt OAI Preset** selects Prompt Manager composition for the auxiliary request: prompt order, Character/Persona/Personality/Scenario, World Info and checkpoint entries. It does not replace the profile's request settings.

With **Empty Preset**, no Prompt Manager prompt is assembled. The manual options under **Add additional instructions** separately control Persona Description/Char Description/Char Personality, Scenario, Worldbook and Summarized Checkpoints. For a Chat Completion profile, Composer sends these parts and the selected history as structured system/user/assistant messages so the backend's chat template is applied to the same role structure as MAIN. Hidden chat messages are excluded in every auxiliary history path. The Summarized Checkpoints option is shown only while the Checkpoint Summarize extension is installed and enabled. **Empty Preset: last chat messages** limits the manually assembled history to its last `N` visible messages; `0` includes the full visible chat history. Connection Profile request parameters still apply.

### Output and conditions

`Show result to subsequent blocks` makes a block's processed output available as pipeline context to later stages. Any block can test the immediately preceding additional block with a JavaScript RegExp, test whether the assembled MAIN prompt contains case-sensitive text, or run a named Quick Reply and continue only when it returns `true`, `1`, `yes` or `on`. A Generate block whose condition is false makes no LLM request and returns an empty result.

**Invert condition** reverses any condition except **Always**: it runs for an empty preceding block, a non-matching pattern, absent prompt text, or a Quick Reply result other than `true`.

**Prompt contains text** uses Tavern's normal dry-run prompt assembly. A PRE block checks the prompt that MAIN will receive after preceding PRE outputs have been propagated. A POST block checks the prompt that a further MAIN generation would receive at that point, including the current MAIN reply and preceding POST outputs. It does not send a request to the model.

**Use Regex and QR** is the master switch for both behaviours below. When it is enabled, **Apply SillyTavern Regex and before-generation Quick Replies** on a Generate block runs the active Quick Replies marked **Execute before message generation** immediately before Composer assembles that block's request. It uses Tavern's standard Quick Reply lifecycle, so global, chat and character Quick Reply sets follow their ordinary enablement and recursion safeguards.

The same block option also processes the assembled prompt with SillyTavern Regex before sending it and processes the returned output afterward. Prompt processing uses Tavern's prompt-only Regex Scripts: chat-completion messages use their user/assistant placement and a text-completion prompt uses User Input. A Static Text block has no request, so its option is labelled **Apply SillyTavern Regex** and only processes its output. **Output Extraction** then accepts a JavaScript RegExp; if it has a capture group, the first capture group becomes the output; otherwise the entire match is used.

## Development

The extension source is plain browser JavaScript. A quick syntax check is sufficient for local edits:

```powershell
node --check index.js
```

The settings and chat data used by the extension remain in SillyTavern's user-data directory and are not part of this repository.
