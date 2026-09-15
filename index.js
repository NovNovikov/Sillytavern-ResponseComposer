import {
    eventSource,
    event_types,
    extension_prompt_roles,
    extension_prompt_types,
    getMaxContextTokens,
    registerGenerationFinalizer,
    saveSettingsDebounced,
} from '../../../../script.js';
import { extension_settings, extensionNames, getContext } from '../../../extensions.js';
import { Popup } from '../../../popup.js';
import { removeReasoningFromString } from '../../../reasoning.js';
import { getWorldInfoPrompt } from '../../../world-info.js';
import { getRegexedString, regex_placement } from '../../regex/engine.js';

const MODULE_NAME = 'st-message-constructor';
const PANEL_ID = 'st-message-constructor-panel';
const EMPTY_PRESET = '__STMC_EMPTY_PRESET__';
const PIPELINE_VERSION = 1;

let initialized = false;
let renderVersion = 0;
let auxiliaryDepth = 0;
let activeRun = null;
let unregisterFinalizer = null;
let diagnosticSequence = 0;
let diagnosticEntries = [];
let lastDiagnosticRun = null;
let pendingStateRestores = [];

const PIPELINE_PROMPT_KEY = 'st-message-constructor-pipeline-context';
const PIPELINE_METADATA_KEY = 'multiStageComposer';
const DIAGNOSTIC_LIMIT = 80;

function newId() {
    return globalThis.crypto?.randomUUID?.() ?? `stmc-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function newAdditionalInstructions() {
    return {
        enabled: false,
        beginning: '',
        includeCharacter: false,
        includeWorldbook: false,
        includeCheckpoints: false,
        postHistory: '',
    };
}

function isCheckpointSummarizeAvailable() {
    const extensionId = extensionNames.find(name => name.toLowerCase().replaceAll(/[^a-z0-9]/g, '').includes('checkpointsummarize'));
    return Boolean(extensionId && !extension_settings.disabledExtensions?.includes(extensionId));
}

function newBlock(position = 'pre') {
    return {
        id: newId(),
        name: 'Additional Block',
        enabled: true,
        type: 'generate',
        staticText: '',
        runCondition: 'always',
        previousOutputPattern: '',
        promptText: '',
        quickReplySet: '',
        quickReplyLabel: '',
        position,
        connectionProfileId: '',
        oaiPresetId: EMPTY_PRESET,
        emptyHistoryMessageLimit: 0,
        visibility: 'visible',
        propagate: true,
        keepOnSwipe: false,
        additionalInstructions: newAdditionalInstructions(),
        regex: {
            applySillyTavernRegex: true,
            extraction: '',
        },
    };
}

function newPipelinePreset(name = 'New Pipeline') {
    return {
        version: PIPELINE_VERSION,
        id: newId(),
        name,
        enabled: true,
        useRegex: true,
        main: {
            connectionProfileId: '',
        },
        blocks: [],
    };
}

function ensureSettings() {
    const defaults = {
        version: PIPELINE_VERSION,
        presets: [newPipelinePreset('Default Pipeline')],
        activePresetId: '',
    };
    extension_settings[MODULE_NAME] ??= defaults;
    const settings = extension_settings[MODULE_NAME];
    settings.version ??= PIPELINE_VERSION;
    settings.presets = Array.isArray(settings.presets) && settings.presets.length ? settings.presets : defaults.presets;
    settings.activePresetId ??= settings.presets[0].id;
    if (!settings.presets.some(preset => preset.id === settings.activePresetId)) {
        settings.activePresetId = settings.presets[0].id;
    }
    return settings;
}

function getSettings() {
    return ensureSettings();
}

function getActivePreset() {
    const settings = getSettings();
    return settings.presets.find(preset => preset.id === settings.activePresetId) ?? settings.presets[0];
}

function saveSettings() {
    saveSettingsDebounced();
}

function clone(value) {
    return structuredClone(value);
}

function escapeHtml(value) {
    const node = document.createElement('div');
    node.textContent = String(value ?? '');
    return node.innerHTML;
}

function getExtensionDirectory() {
    const path = new URL(import.meta.url).pathname;
    return path.slice(0, path.lastIndexOf('/'));
}

function getConnectionProfiles() {
    const profiles = getContext()?.extensionSettings?.connectionManager?.profiles;
    return Array.isArray(profiles) ? profiles : [];
}

function profileOptions(selectedId) {
    const options = ['<option value="">Current MAIN profile</option>'];
    for (const profile of getConnectionProfiles()) {
        const selected = profile.id === selectedId ? ' selected' : '';
        options.push(`<option value="${escapeHtml(profile.id)}"${selected}>${escapeHtml(profile.name)}</option>`);
    }
    return options.join('');
}

function getOaiPresetNames() {
    return [...document.querySelectorAll('#settings_preset_openai option')]
        .map(option => option.textContent?.trim())
        .filter(Boolean);
}

function oaiPresetOptions(selectedId) {
    const options = [`<option value="${EMPTY_PRESET}"${selectedId === EMPTY_PRESET ? ' selected' : ''}>Empty Preset</option>`];
    for (const name of getOaiPresetNames()) {
        const selected = name === selectedId ? ' selected' : '';
        options.push(`<option value="${escapeHtml(name)}"${selected}>${escapeHtml(name)}</option>`);
    }
    return options.join('');
}

function getPanel() {
    return document.getElementById(PANEL_ID);
}

function getChatDiagnostics(messageId = null) {
    const chat = getContext().chat ?? [];
    const message = Number.isInteger(messageId) ? chat[messageId] : null;
    return {
        chat: chat.length,
        messageId: Number.isInteger(messageId) ? messageId : undefined,
        messageExists: Number.isInteger(messageId) ? Boolean(message) : undefined,
        messageLength: typeof message?.mes === 'string' ? message.mes.length : undefined,
    };
}

function renderDiagnostics() {
    const output = getPanel()?.querySelector('#stmc-diagnostics-output');
    if (!output) return;
    output.textContent = diagnosticEntries.length
        ? diagnosticEntries.map(entry => {
            const details = Object.entries(entry.details)
                .filter(([, value]) => value !== undefined)
                .map(([key, value]) => `${key}=${String(value)}`)
                .join(' ');
            return `${entry.time} #${entry.runId ?? '-'} ${entry.stage}${details ? ` ${details}` : ''}`;
        }).join('\n')
        : 'No pipeline run recorded yet.';
}

function tracePipeline(run, stage, details = {}) {
    const target = run ?? activeRun ?? lastDiagnosticRun;
    if (!target) return;
    diagnosticEntries.push({
        time: new Date().toLocaleTimeString([], { hour12: false, fractionalSecondDigits: 3 }),
        runId: target.diagnosticId,
        stage,
        details,
    });
    diagnosticEntries = diagnosticEntries.slice(-DIAGNOSTIC_LIMIT);
    renderDiagnostics();
}

function getBlock(preset, id) {
    return preset.blocks.find(block => block.id === id);
}

function isStaticBlock(block) {
    return block.type === 'static';
}

function getRunCondition(block) {
    return ['always', 'previous_nonempty', 'previous_matches', 'prompt_contains', 'quick_reply'].includes(block.runCondition)
        ? block.runCondition
        : 'always';
}

function renderBlock(block, isOpen = false) {
    const instructions = block.additionalInstructions ?? newAdditionalInstructions();
    const isDiscard = block.visibility === 'discard';
    const isEnabled = block.enabled !== false;
    const isStatic = isStaticBlock(block);
    const isPresetRegexEnabled = getActivePreset()?.useRegex !== false;
    const runCondition = getRunCondition(block);
    const isEmptyPreset = block.oaiPresetId === EMPTY_PRESET;
    const hasCheckpointSummarize = isCheckpointSummarizeAvailable();
    return `
        <details class="stmc-block${isEnabled ? '' : ' stmc-block-disabled'}" data-block-id="${escapeHtml(block.id)}"${isOpen ? ' open' : ''}>
            <summary>
                <span class="stmc-block-name">${escapeHtml(block.name || 'Additional Block')}</span>
                <span class="stmc-block-position">${block.position === 'pre' ? 'PRE' : 'POST'}</span>
                <div class="stmc-block-summary-actions">
                    <button type="button" class="stmc-block-header-action fa-solid fa-trash-can" data-action="delete" aria-label="Delete block" title="Delete block"></button>
                    <button type="button" class="stmc-block-header-action fa-solid fa-arrow-up" data-action="move-up" aria-label="Move block up" title="Move block up"></button>
                    <button type="button" class="stmc-block-header-action fa-solid fa-arrow-down" data-action="move-down" aria-label="Move block down" title="Move block down"></button>
                    <button type="button" class="stmc-block-header-action ${block.position === 'pre' ? 'fa-solid fa-arrow-right' : 'fa-solid fa-arrow-left'}" data-action="move-across" aria-label="Move block ${block.position === 'pre' ? 'after' : 'before'} MAIN" title="Move block ${block.position === 'pre' ? 'after' : 'before'} MAIN"></button>
                    <button type="button" class="stmc-block-toggle fa-solid ${isEnabled ? 'fa-toggle-on' : 'fa-toggle-off'}" data-action="toggle-block" role="switch" aria-checked="${isEnabled}" title="${isEnabled ? 'Disable block' : 'Enable block'}"></button>
                </div>
            </summary>
            <div class="stmc-block-content">
                <div class="stmc-grid">
                    <label class="stmc-field"><span>Name</span><input class="text_pole" data-field="name" value="${escapeHtml(block.name)}"></label>
                    <label class="stmc-field"><span>Block Type</span><select class="text_pole" data-field="type">
                        <option value="generate"${isStatic ? '' : ' selected'}>Generate with LLM</option>
                        <option value="static"${isStatic ? ' selected' : ''}>Static Text</option>
                    </select></label>
                    <label class="stmc-field"${isStatic ? ' hidden' : ''}><span>Connection Profile</span><select class="text_pole" data-field="connectionProfileId">${profileOptions(block.connectionProfileId)}</select></label>
                    <label class="stmc-field"${isStatic ? ' hidden' : ''}><span>Prompt OAI Preset</span><select class="text_pole" data-field="oaiPresetId">${oaiPresetOptions(block.oaiPresetId)}</select></label>
                    <label class="stmc-field"><span>Visibility</span><select class="text_pole" data-field="visibility">
                        <option value="visible"${block.visibility === 'visible' ? ' selected' : ''}>Visible</option>
                        <option value="hidden"${block.visibility === 'hidden' ? ' selected' : ''}>Hidden / Internal</option>
                        <option value="discard"${isDiscard ? ' selected' : ''}>Discard after use</option>
                    </select></label>
                </div>
                <p class="stmc-hint"${isStatic ? ' hidden' : ''}>The Connection Profile supplies API settings and Additional Parameters. Prompt OAI Preset controls prompt composition.</p>
                <label class="stmc-field"${isStatic || !isEmptyPreset ? ' hidden' : ''}><span>Empty Preset: last chat messages</span><input class="text_pole" type="number" min="0" step="1" data-field="emptyHistoryMessageLimit" value="${escapeHtml(block.emptyHistoryMessageLimit ?? 0)}"><small>0 includes all chat messages.</small></label>
                <div class="stmc-options">
                    <label><input type="checkbox" data-field="propagate"${block.propagate ? ' checked' : ''}> Show result to subsequent blocks</label>
                    <label${isStatic ? ' hidden' : ''}><input type="checkbox" data-field="keepOnSwipe"${block.keepOnSwipe ? ' checked' : ''}${isDiscard ? ' disabled' : ''}> Do not regenerate on Swipe</label>
                    <label${isStatic ? ' hidden' : ''}><input type="checkbox" data-field="additionalInstructions.enabled"${instructions.enabled ? ' checked' : ''}> Add additional instructions</label>
                    <label${isPresetRegexEnabled ? '' : ' hidden'}><input type="checkbox" data-field="regex.applySillyTavernRegex"${block.regex?.applySillyTavernRegex ? ' checked' : ''}> ${isStatic ? 'Apply SillyTavern Regex' : 'Apply SillyTavern Regex and before-generation Quick Replies'}</label>
                </div>
                <div class="stmc-static-fields"${isStatic ? '' : ' hidden'}>
                    <label class="stmc-field"><span>Text</span><textarea class="text_pole" data-field="staticText">${escapeHtml(block.staticText ?? '')}</textarea></label>
                    <label class="stmc-field"><span>Run Condition</span><select class="text_pole" data-field="runCondition">
                        <option value="always"${runCondition === 'always' ? ' selected' : ''}>Always</option>
                        <option value="previous_nonempty"${runCondition === 'previous_nonempty' ? ' selected' : ''}>Previous block produced text</option>
                        <option value="previous_matches"${runCondition === 'previous_matches' ? ' selected' : ''}>Previous block output matches pattern</option>
                        <option value="prompt_contains"${runCondition === 'prompt_contains' ? ' selected' : ''}>Prompt contains text</option>
                        <option value="quick_reply"${runCondition === 'quick_reply' ? ' selected' : ''}>Quick Reply returns true</option>
                    </select></label>
                    <label class="stmc-field"${runCondition === 'previous_matches' ? '' : ' hidden'}><span>Previous Output Pattern</span><textarea class="text_pole" data-field="previousOutputPattern" placeholder="JavaScript RegExp">${escapeHtml(block.previousOutputPattern ?? '')}</textarea></label>
                    <label class="stmc-field"${runCondition === 'prompt_contains' ? '' : ' hidden'}><span>Prompt Text</span><textarea class="text_pole" data-field="promptText" placeholder="Case-sensitive text from the assembled MAIN prompt">${escapeHtml(block.promptText ?? '')}</textarea></label>
                    <div class="stmc-grid"${runCondition === 'quick_reply' ? '' : ' hidden'}>
                        <label class="stmc-field"><span>Quick Reply Set</span><input class="text_pole" data-field="quickReplySet" value="${escapeHtml(block.quickReplySet ?? '')}" placeholder="Set name"></label>
                        <label class="stmc-field"><span>Quick Reply Label</span><input class="text_pole" data-field="quickReplyLabel" value="${escapeHtml(block.quickReplyLabel ?? '')}" placeholder="Quick Reply label"></label>
                    </div>
                </div>
                <div class="stmc-instructions"${!isStatic && instructions.enabled ? '' : ' hidden'}>
                    <label class="stmc-field"><span>Beginning Instruction</span><textarea class="text_pole" data-field="additionalInstructions.beginning">${escapeHtml(instructions.beginning)}</textarea></label>
                    <div class="stmc-options"${isEmptyPreset ? '' : ' hidden'}>
                        <label><input type="checkbox" data-field="additionalInstructions.includeCharacter"${instructions.includeCharacter ? ' checked' : ''}> Persona, Character Description, Personality & Scenario</label>
                        <label><input type="checkbox" data-field="additionalInstructions.includeWorldbook"${instructions.includeWorldbook ? ' checked' : ''}> Worldbook</label>
                        <label${hasCheckpointSummarize ? '' : ' hidden'}><input type="checkbox" data-field="additionalInstructions.includeCheckpoints"${instructions.includeCheckpoints ? ' checked' : ''}> Summarized Checkpoints</label>
                    </div>
                    <p class="stmc-hint"${isEmptyPreset ? ' hidden' : ''}>Character, World Info, checkpoints, and prompt order are taken from the selected OAI preset's Prompt Manager.</p>
                    <label class="stmc-field"><span>Post-History Instruction</span><textarea class="text_pole" data-field="additionalInstructions.postHistory">${escapeHtml(instructions.postHistory)}</textarea></label>
                </div>
                <label class="stmc-field"><span>Output Extraction</span><textarea class="text_pole" data-field="regex.extraction" placeholder="JavaScript RegExp; first capture group is kept">${escapeHtml(block.regex?.extraction ?? '')}</textarea></label>
            </div>
        </details>`;
}

function insertButton(position, index) {
    return `<div class="stmc-insert-row"><button class="menu_button" data-add-position="${position}" data-add-index="${index}" title="Add block">+</button></div>`;
}

function renderPipeline() {
    const panel = getPanel();
    const preset = getActivePreset();
    const pipeline = panel?.querySelector('#stmc-pipeline');
    if (!pipeline) return;

    const openBlockIds = new Set([...pipeline.querySelectorAll('details.stmc-block[open]')]
        .map(element => element.dataset.blockId));
    const pre = preset.blocks.filter(block => block.position === 'pre');
    const post = preset.blocks.filter(block => block.position === 'post');
    const preHtml = pre.flatMap((block, index) => [insertButton('pre', index), renderBlock(block, openBlockIds.has(block.id))]).join('');
    const postHtml = post.flatMap((block, index) => [insertButton('post', index), renderBlock(block, openBlockIds.has(block.id))]).join('');
    pipeline.innerHTML = `${preHtml}${insertButton('pre', pre.length)}
        <div class="stmc-main-marker">MAIN MESSAGE<small>Standard SillyTavern Generation</small></div>
        ${postHtml}${insertButton('post', post.length)}`;
}

function renderPresetManager() {
    const panel = getPanel();
    const settings = getSettings();
    const presetSelect = panel?.querySelector('#stmc-preset');
    if (!presetSelect) return;
    presetSelect.innerHTML = settings.presets.map(preset => `<option value="${escapeHtml(preset.id)}"${preset.id === settings.activePresetId ? ' selected' : ''}>${escapeHtml(preset.name)}</option>`).join('');
    const preset = getActivePreset();
    panel.querySelector('#stmc-enabled').checked = !!preset.enabled;
    panel.querySelector('#stmc-use-regex').checked = !!preset.useRegex;
}

function render() {
    renderPresetManager();
    renderPipeline();
}

function setNestedValue(target, path, value) {
    const keys = path.split('.');
    const finalKey = keys.pop();
    let current = target;
    for (const key of keys) current = current[key] ??= {};
    current[finalKey] = value;
}

function insertBlock(position, index) {
    const preset = getActivePreset();
    const positions = preset.blocks.reduce((count, block, allIndex) => {
        if (block.position === position) count.push(allIndex);
        return count;
    }, []);
    const block = newBlock(position);
    const insertAt = positions[index] ?? (position === 'pre'
        ? (preset.blocks.findIndex(candidate => candidate.position === 'post') === -1 ? preset.blocks.length : preset.blocks.findIndex(candidate => candidate.position === 'post'))
        : preset.blocks.length);
    preset.blocks.splice(insertAt, 0, block);
    saveSettings();
    render();
}

function moveBlock(block, direction) {
    const preset = getActivePreset();
    const currentIndex = preset.blocks.indexOf(block);
    const adjacentIndex = currentIndex + direction;
    if (adjacentIndex < 0 || adjacentIndex >= preset.blocks.length || preset.blocks[adjacentIndex].position !== block.position) return;
    [preset.blocks[currentIndex], preset.blocks[adjacentIndex]] = [preset.blocks[adjacentIndex], preset.blocks[currentIndex]];
    saveSettings();
    render();
}

function moveBlockAcrossMain(block) {
    block.position = block.position === 'pre' ? 'post' : 'pre';
    saveSettings();
    render();
}

function normalizeImportedPreset(value) {
    if (!value || typeof value !== 'object' || !Array.isArray(value.blocks)) {
        throw new Error('The selected file is not a Pipeline Preset.');
    }
    const preset = clone(value);
    preset.version = PIPELINE_VERSION;
    preset.id = newId();
    preset.name = String(preset.name || 'Imported Pipeline');
    preset.enabled = preset.enabled !== false;
    preset.useRegex = preset.useRegex !== false;
    preset.main = { connectionProfileId: String(preset.main?.connectionProfileId ?? '') };
    preset.blocks = preset.blocks.map(block => ({
        ...newBlock(block.position === 'post' ? 'post' : 'pre'),
        ...block,
        id: newId(),
        enabled: block.enabled !== false,
        type: block.type === 'static' ? 'static' : 'generate',
        staticText: String(block.staticText ?? ''),
        runCondition: getRunCondition(block),
        previousOutputPattern: String(block.previousOutputPattern ?? ''),
        promptText: String(block.promptText ?? ''),
        quickReplySet: String(block.quickReplySet ?? ''),
        quickReplyLabel: String(block.quickReplyLabel ?? ''),
        position: block.position === 'post' ? 'post' : 'pre',
        additionalInstructions: { ...newAdditionalInstructions(), ...(block.additionalInstructions ?? {}) },
        regex: { applySillyTavernRegex: true, extraction: '', ...(block.regex ?? {}) },
    }));
    return preset;
}

function downloadPreset(preset) {
    const blob = new Blob([JSON.stringify(preset, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${preset.name.replaceAll(/[^a-z0-9-_]+/gi, '_') || 'pipeline'}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
}

async function promptName(title, initialValue) {
    return await Popup.show.input(title, '', initialValue);
}

function bindEvents() {
    const panel = getPanel();
    if (!panel || panel.dataset.bound === 'true') return;
    panel.dataset.bound = 'true';

    panel.querySelector('#stmc-enabled').addEventListener('input', event => {
        getActivePreset().enabled = event.target.checked;
        saveSettings();
    });
    panel.querySelector('#stmc-use-regex').addEventListener('input', event => {
        getActivePreset().useRegex = event.target.checked;
        saveSettings();
        renderPipeline();
    });
    panel.querySelector('#stmc-preset').addEventListener('change', event => {
        getSettings().activePresetId = event.target.value;
        saveSettings();
        render();
    });
    panel.querySelector('#stmc-new-preset').addEventListener('click', async () => {
        const name = await promptName('New Pipeline Preset', 'New Pipeline');
        if (!name) return;
        const preset = newPipelinePreset(String(name));
        getSettings().presets.push(preset);
        getSettings().activePresetId = preset.id;
        saveSettings();
        render();
    });
    panel.querySelector('#stmc-save-preset').addEventListener('click', () => {
        const profileId = getContext()?.extensionSettings?.connectionManager?.selectedProfile ?? '';
        getActivePreset().main.connectionProfileId = profileId;
        saveSettings();
        toastr.success('Pipeline Preset saved.');
    });
    panel.querySelector('#stmc-save-as-preset').addEventListener('click', async () => {
        const source = getActivePreset();
        const name = await promptName('Save Pipeline Preset As', `${source.name} Copy`);
        if (!name) return;
        const preset = clone(source);
        preset.id = newId();
        preset.name = String(name);
        getSettings().presets.push(preset);
        getSettings().activePresetId = preset.id;
        saveSettings();
        render();
    });
    panel.querySelector('#stmc-rename-preset').addEventListener('click', async () => {
        const preset = getActivePreset();
        const name = await promptName('Rename Pipeline Preset', preset.name);
        if (!name) return;
        preset.name = String(name);
        saveSettings();
        renderPresetManager();
    });
    panel.querySelector('#stmc-delete-preset').addEventListener('click', () => {
        const settings = getSettings();
        if (settings.presets.length === 1) {
            toastr.warning('At least one Pipeline Preset must remain.');
            return;
        }
        settings.presets = settings.presets.filter(preset => preset.id !== settings.activePresetId);
        settings.activePresetId = settings.presets[0].id;
        saveSettings();
        render();
    });
    panel.querySelector('#stmc-export-preset').addEventListener('click', () => downloadPreset(getActivePreset()));
    panel.querySelector('#stmc-import-preset').addEventListener('click', () => panel.querySelector('#stmc-import-file').click());
    panel.querySelector('#stmc-import-file').addEventListener('change', async event => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        try {
            const preset = normalizeImportedPreset(JSON.parse(await file.text()));
            getSettings().presets.push(preset);
            getSettings().activePresetId = preset.id;
            saveSettings();
            render();
            toastr.success('Pipeline Preset imported.');
        } catch (error) {
            console.error(`${MODULE_NAME}: import failed`, error);
            toastr.error(error.message || 'Could not import Pipeline Preset.');
        }
    });
    panel.querySelector('#stmc-clear-diagnostics').addEventListener('click', () => {
        diagnosticEntries = [];
        renderDiagnostics();
    });
    panel.querySelector('#stmc-pipeline').addEventListener('click', event => {
        const addButton = event.target.closest('[data-add-position]');
        if (addButton) {
            insertBlock(addButton.dataset.addPosition, Number(addButton.dataset.addIndex));
            return;
        }
        const button = event.target.closest('[data-action]');
        if (!button) return;
        const block = getBlock(getActivePreset(), button.closest('[data-block-id]')?.dataset.blockId);
        if (!block) return;
        if (button.closest('summary') || button.dataset.action === 'toggle-block' || button.dataset.action === 'delete') {
            event.preventDefault();
            event.stopPropagation();
        }
        switch (button.dataset.action) {
            case 'toggle-block':
                block.enabled = block.enabled === false;
                saveSettings();
                renderPipeline();
                break;
            case 'move-up': moveBlock(block, -1); break;
            case 'move-down': moveBlock(block, 1); break;
            case 'move-across': moveBlockAcrossMain(block); break;
            case 'delete':
                getActivePreset().blocks = getActivePreset().blocks.filter(candidate => candidate.id !== block.id);
                saveSettings();
                render();
                break;
        }
    });
    const updateBlockField = event => {
        const field = event.target.dataset.field;
        if (!field) return;
        const block = getBlock(getActivePreset(), event.target.closest('[data-block-id]')?.dataset.blockId);
        if (!block) return;
        const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
        setNestedValue(block, field, value);
        if (field === 'visibility' && value === 'discard') block.keepOnSwipe = false;
        if (field === 'type' && value === 'static') block.keepOnSwipe = false;
        saveSettings();
        if (field === 'name') {
            event.target.closest('details').querySelector('.stmc-block-name').textContent = value || 'Additional Block';
        }
        if (field === 'visibility' || field === 'additionalInstructions.enabled' || field === 'type' || field === 'runCondition' || field === 'oaiPresetId') renderPipeline();
    };
    panel.querySelector('#stmc-pipeline').addEventListener('input', updateBlockField);
    panel.querySelector('#stmc-pipeline').addEventListener('change', updateBlockField);
}

async function renderUI() {
    const container = document.getElementById('extensions_settings2');
    if (!container) return;
    const currentVersion = ++renderVersion;
    const settingsPath = `${getExtensionDirectory()}/settings.html`;
    let html;
    try {
        html = await $.get(settingsPath);
    } catch (error) {
        console.error(`${MODULE_NAME}: unable to load settings`, error);
        toastr.error('Multi-Stage Response Composer settings could not be loaded.');
        return;
    }
    if (currentVersion !== renderVersion) return;
    document.querySelectorAll(`#${PANEL_ID}`).forEach(node => node.remove());
    container.insertAdjacentHTML('beforeend', html);
    bindEvents();
    render();
    renderDiagnostics();
}

function formatPipelineContext(entries) {
    const parts = entries
        .filter(entry => entry?.propagate && typeof entry.output === 'string' && entry.output.trim())
        .map(entry => `[${entry.name || 'Additional Block'}]\n${entry.output.trim()}`);
    return parts.length
        ? `[Pipeline Context]\n${parts.join('\n\n')}\n[End Pipeline Context]\nUse this context to produce the normal assistant response.`
        : '';
}

function setPipelineContext(entries, key = PIPELINE_PROMPT_KEY) {
    getContext().setExtensionPrompt(
        key,
        formatPipelineContext(entries),
        extension_prompt_types.IN_CHAT,
        0,
        false,
        extension_prompt_roles.SYSTEM,
    );
}

function clearPipelineContext(key = PIPELINE_PROMPT_KEY) {
    getContext().setExtensionPrompt(key, '', extension_prompt_types.NONE, 0, false, extension_prompt_roles.SYSTEM);
}

function isAbortError(error) {
    return error?.name === 'AbortError' || /abort|cancel/i.test(String(error?.message ?? error ?? ''));
}

function assertRunActive(run) {
    if (run !== activeRun || run.aborted) {
        throw new DOMException('Multi-stage generation was aborted.', 'AbortError');
    }
}

function getSelectedProfileId() {
    return String(document.querySelector('#connection_profiles')?.value ?? '');
}

function getSelectedOaiPresetName() {
    return String(document.querySelector('#settings_preset_openai option:checked')?.textContent ?? '').trim();
}

async function waitForEvent(eventName, action) {
    let timeoutId;
    const eventPromise = new Promise(resolve => eventSource.once(eventName, resolve));
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`Timed out waiting for ${eventName}.`)), 15000);
    });
    try {
        action();
        return await Promise.race([eventPromise, timeoutPromise]);
    } finally {
        clearTimeout(timeoutId);
    }
}

async function switchConnectionProfile(profileId) {
    const select = document.querySelector('#connection_profiles');
    const target = String(profileId ?? '');
    if (!(select instanceof HTMLSelectElement) || select.value === target) return;
    if (![...select.options].some(option => option.value === target)) {
        throw new Error(`Connection Profile \"${target}\" is no longer available.`);
    }
    await waitForEvent(event_types.CONNECTION_PROFILE_LOADED, () => {
        select.value = target;
        select.dispatchEvent(new Event('change', { bubbles: true }));
    });
}

async function switchOaiPreset(presetName) {
    const select = document.querySelector('#settings_preset_openai');
    const target = String(presetName ?? '').trim();
    if (!(select instanceof HTMLSelectElement) || !target || getSelectedOaiPresetName() === target) return;
    const option = [...select.options].find(candidate => candidate.textContent?.trim() === target);
    if (!option) throw new Error(`OAI Preset \"${target}\" is no longer available.`);
    await waitForEvent(event_types.OAI_PRESET_CHANGED_AFTER, () => {
        select.value = option.value;
        $(select).trigger('change');
    });
}

async function restoreTavernState(snapshot) {
    if (!snapshot) return;
    try {
        await switchConnectionProfile(snapshot.connectionProfileId);
        await switchOaiPreset(snapshot.oaiPresetName);
    } catch (error) {
        console.error(`${MODULE_NAME}: failed to restore temporary generation state`, error);
        toastr.error('Multi-Stage Composer could not restore the previous connection settings.');
    }
}

function createPersistedBlock(block, output, reusedOnSwipe, skipped = false) {
    return {
        id: block.id,
        name: block.name,
        type: isStaticBlock(block) ? 'static' : 'generate',
        position: block.position,
        visibility: block.visibility,
        propagate: !!block.propagate,
        reusedOnSwipe: !!reusedOnSwipe,
        skipped: !!skipped,
        output,
    };
}

function findSourceBlock(run, block) {
    return run.sourcePipeline?.blocks?.find(candidate => candidate?.id === block.id && candidate?.position === block.position);
}

function getKeepOnSwipeSetting(run, block) {
    if (run.type !== 'swipe') return Boolean(block.keepOnSwipe);
    // Source snapshots preserve the block order and prior output. The switch
    // is a user command for the next swipe, so honor its current value when
    // the active preset still contains this stable block ID.
    const currentBlock = getActivePreset()?.blocks?.find(candidate => candidate?.id === block.id && candidate?.position === block.position);
    return currentBlock ? Boolean(currentBlock.keepOnSwipe) : Boolean(block.keepOnSwipe);
}

function getSourcePipeline(type, sourceSwipeId = null) {
    const target = getContext().chat.at(-1);
    if (!target?.extra?.[PIPELINE_METADATA_KEY]) return null;
    if (type === 'swipe') {
        const sourceId = Number.isInteger(sourceSwipeId) ? sourceSwipeId : Number(target.swipe_id) - 1;
        return target.swipe_info?.[sourceId]?.extra?.[PIPELINE_METADATA_KEY]
            ?? target.extra?.[PIPELINE_METADATA_KEY]
            ?? null;
    }
    return target.extra?.[PIPELINE_METADATA_KEY] ?? null;
}

function createRun(type, options = {}) {
    const sourcePipeline = ['swipe', 'continue'].includes(type) ? getSourcePipeline(type, options.sourceSwipeId) : null;
    const preset = sourcePipeline?.presetSnapshot ?? getActivePreset();
    if (!preset?.enabled) return null;
    const run = {
        type,
        diagnosticId: ++diagnosticSequence,
        presetSnapshot: clone(preset),
        sourcePipeline: sourcePipeline ? clone(sourcePipeline) : null,
        records: [],
        propagated: [],
        originalState: {
            connectionProfileId: getSelectedProfileId(),
            oaiPresetName: getSelectedOaiPresetName(),
        },
        mainStateApplied: false,
        aborted: false,
        finalized: false,
        continueMessage: null,
    };
    lastDiagnosticRun = run;
    tracePipeline(run, 'run-created', { type, ...getChatDiagnostics() });
    return run;
}

function buildSupplementaryInstruction(run, block, entries) {
    const instructions = block.additionalInstructions ?? newAdditionalInstructions();
    const parts = [];
    if (instructions.enabled && instructions.beginning.trim()) parts.push(instructions.beginning.trim());
    const pipelineContext = formatPipelineContext(entries);
    if (pipelineContext) parts.push(pipelineContext);
    if (instructions.enabled && instructions.postHistory.trim()) parts.push(instructions.postHistory.trim());
    return parts.join('\n\n');
}

function getCheckpointText() {
    const checkpointState = getContext().chatMetadata?.checkpoint_summarize;
    const blocks = Array.isArray(checkpointState?.blocks) ? checkpointState.blocks : [];
    const summaries = blocks
        .filter(block => block?.locked === true && block?.inject !== false && String(block?.summary ?? '').trim())
        .map(block => String(block.summary).trim());
    return summaries.length ? `[Summarized Checkpoints]\n${summaries.join('\n\n')}\n[End Summarized Checkpoints]` : '';
}

async function getWorldbookText(context) {
    const scanChat = (context.chat ?? [])
        .filter(message => !message?.is_system)
        .map(message => String(message.mes ?? ''))
        .reverse();
    const result = await getWorldInfoPrompt(scanChat, getMaxContextTokens(), false, { trigger: 'normal' });
    return [result?.worldInfoBefore, result?.worldInfoString, result?.worldInfoAfter]
        .map(value => String(value ?? '').trim())
        .filter(Boolean)
        .join('\n\n');
}

async function buildEmptyPresetPrompt(run, block, entries, context) {
    const instructions = block.additionalInstructions ?? newAdditionalInstructions();
    const parts = [
        ...getEmptyPresetContextParts(block, context),
        ...await getEmptyPresetWorldbookParts(block, context),
        ...getEmptyPresetCheckpointParts(block),
    ];
    const history = getEmptyPresetHistory(block, context)
        .map(message => `${message.is_user ? context.name1 : (message.name || context.name2)}: ${String(message.mes ?? '')}`)
        .join('\n\n');
    if (history) parts.push(history);
    const pipelineContext = formatPipelineContext(entries);
    if (pipelineContext) parts.push(pipelineContext);
    if (instructions.enabled && instructions.postHistory.trim()) parts.push(instructions.postHistory.trim());
    return parts.join('\n\n');
}

function getEmptyPresetContextParts(block, context) {
    const instructions = block.additionalInstructions ?? newAdditionalInstructions();
    const parts = [];
    if (instructions.enabled && instructions.beginning.trim()) parts.push(instructions.beginning.trim());
    if (instructions.enabled && instructions.includeCharacter) {
        const fields = context.getCharacterCardFields?.() ?? {};
        const characterParts = [fields.persona, fields.description, fields.personality, fields.scenario]
            .map(value => String(value ?? '').trim())
            .filter(Boolean);
        if (characterParts.length) parts.push(characterParts.join('\n\n'));
    }
    return parts;
}

async function getEmptyPresetWorldbookParts(block, context) {
    const instructions = block.additionalInstructions ?? newAdditionalInstructions();
    if (!(instructions.enabled && instructions.includeWorldbook)) return [];
    const worldbook = await getWorldbookText(context);
    return worldbook ? [worldbook] : [];
}

function getEmptyPresetCheckpointParts(block) {
    const instructions = block.additionalInstructions ?? newAdditionalInstructions();
    if (!(instructions.enabled && instructions.includeCheckpoints)) return [];
    const checkpoints = getCheckpointText();
    return checkpoints ? [checkpoints] : [];
}

function getEmptyPresetHistory(block, context) {
    const historyLimit = Math.max(0, Math.floor(Number(block.emptyHistoryMessageLimit) || 0));
    const historyMessages = (context.chat ?? []).filter(message => !message?.is_system);
    return historyLimit > 0 ? historyMessages.slice(-historyLimit) : historyMessages;
}

async function buildEmptyPresetMessages(run, block, entries, context) {
    const instructions = block.additionalInstructions ?? newAdditionalInstructions();
    const messages = [];
    const leadingContext = [
        ...getEmptyPresetContextParts(block, context),
        ...await getEmptyPresetWorldbookParts(block, context),
        ...getEmptyPresetCheckpointParts(block),
    ];
    for (const content of leadingContext) {
        messages.push({ role: 'system', content });
    }
    for (const message of getEmptyPresetHistory(block, context)) {
        const role = message.is_user ? 'user' : 'assistant';
        const converted = { role, content: String(message.mes ?? '') };
        if (!message.is_user && message.name && message.name !== context.name2) {
            converted.name = message.name;
        }
        messages.push(converted);
    }
    const pipelineContext = formatPipelineContext(entries);
    if (pipelineContext) messages.push({ role: 'system', content: pipelineContext });
    if (instructions.enabled && instructions.postHistory.trim()) {
        messages.push({ role: 'system', content: instructions.postHistory.trim() });
    }
    return messages;
}

function resolveAuxiliaryProfile(context, block) {
    const profileId = String(block.connectionProfileId || getSelectedProfileId());
    if (!profileId || !context.ConnectionManagerRequestService) return null;
    const profile = context.ConnectionManagerRequestService.getProfile(profileId);
    const type = context.ConnectionManagerRequestService.validateProfile(profile).selected;
    return {
        id: profileId,
        type,
        // The block's OAI preset is a Prompt Manager preset. Request settings,
        // including Custom endpoint "Additional Parameters", stay attached to
        // the Connection Profile and must also work with Empty Preset.
        promptPresetName: block.oaiPresetId === EMPTY_PRESET ? null : block.oaiPresetId,
    };
}

async function buildAuxiliaryPrompt(run, block, entries, context, profile) {
    const supplementaryInstruction = buildSupplementaryInstruction(run, block, entries);
    const usesOaiPreset = block.oaiPresetId !== EMPTY_PRESET;
    if (usesOaiPreset && (profile?.type === 'openai' || (!profile && context.mainApi === 'openai'))) {
        return await context.prepareChatCompletionMessages({
            messages: context.chat,
            presetName: profile?.promptPresetName || (block.oaiPresetId === EMPTY_PRESET ? null : block.oaiPresetId),
            supplementaryInstruction,
            type: run.type,
        });
    }

    if (block.oaiPresetId === EMPTY_PRESET && profile?.type === 'openai') {
        return await buildEmptyPresetMessages(run, block, entries, context);
    }

    if (block.oaiPresetId === EMPTY_PRESET) {
        return await buildEmptyPresetPrompt(run, block, entries, context);
    }

    // Text Completion backends have no OAI Prompt Manager. Preserve a compact
    // text prompt for them while Chat Completion blocks use the preset builder.
    const history = (context.chat ?? [])
        .filter(message => !message?.is_system)
        .map(message => `${message.is_user ? context.name1 : (message.name || context.name2)}: ${String(message.mes ?? '')}`)
        .join('\n\n');
    return [supplementaryInstruction, history].filter(Boolean).join('\n\n');
}

function getPromptRegexPlacement(message) {
    return message?.role === 'assistant'
        ? regex_placement.AI_OUTPUT
        : regex_placement.USER_INPUT;
}

function processPromptContent(content, placement) {
    if (typeof content === 'string') {
        return getRegexedString(content, placement, { isPrompt: true });
    }
    if (!Array.isArray(content)) return content;
    return content.map(part => {
        if (!part || typeof part !== 'object' || typeof part.text !== 'string') return part;
        return {
            ...part,
            text: getRegexedString(part.text, placement, { isPrompt: true }),
        };
    });
}

function processBlockPrompt(run, block, prompt) {
    if (!(run.presetSnapshot.useRegex && block.regex?.applySillyTavernRegex)) return prompt;
    if (typeof prompt === 'string') {
        return getRegexedString(prompt, regex_placement.USER_INPUT, { isPrompt: true });
    }
    if (!Array.isArray(prompt)) return prompt;
    return prompt.map(message => {
        if (!message || typeof message !== 'object') return message;
        return {
            ...message,
            content: processPromptContent(message.content, getPromptRegexPlacement(message)),
        };
    });
}

function appliesRegexAndQuickReplies(run, block) {
    return Boolean(run.presetSnapshot.useRegex && block.regex?.applySillyTavernRegex);
}

async function executeBeforeGenerationQuickReplies(run, block) {
    if (!appliesRegexAndQuickReplies(run, block)) return false;

    // Quick Replies exposes its "Execute before message generation" automation
    // through Tavern's normal generation lifecycle, not through its public API.
    // Emitting the same event before assembling this auxiliary request lets the
    // active global, chat and character QR sets run with their usual safeguards.
    await eventSource.emit(event_types.GENERATION_AFTER_COMMANDS, 'quiet', {
        signal: run.abortSignal ?? null,
        stMessageConstructor: true,
        blockId: block.id,
    }, false);
    assertRunActive(run);
    return true;
}

function processBlockOutput(run, block, rawOutput) {
    let output = removeReasoningFromString(String(rawOutput ?? '')).trim();
    const afterReasoningLength = output.length;
    if (appliesRegexAndQuickReplies(run, block)) {
        // Match Tavern's normal assistant-response path. Passing isPrompt here
        // selects prompt-only scripts, which may intentionally erase their input.
        output = getRegexedString(output, regex_placement.AI_OUTPUT);
    }
    const afterRegexLength = output.length;
    const extraction = String(block.regex?.extraction ?? '').trim();
    if (extraction) {
        let match;
        try {
            match = new RegExp(extraction, 's').exec(output);
        } catch (error) {
            throw new Error(`Output Extraction in \"${block.name}\" is not a valid regular expression: ${error.message}`);
        }
        if (!match) {
            throw new Error(`Output Extraction in \"${block.name}\" did not match the generated output.`);
        }
        output = String(match[1] ?? match[0] ?? '').trim();
    }
    tracePipeline(run, 'auxiliary-output-processed', {
        position: block.position,
        afterReasoningLength,
        afterRegexLength,
        afterExtractionLength: output.length,
        regexApplied: appliesRegexAndQuickReplies(run, block),
        extractionEnabled: Boolean(extraction),
    });
    return output;
}

async function generateBlock(run, block, entries) {
    assertRunActive(run);
    tracePipeline(run, 'auxiliary-start', { position: block.position, ...getChatDiagnostics() });
    auxiliaryDepth++;
    try {
        const quickReplyLifecycleDispatched = await executeBeforeGenerationQuickReplies(run, block);
        const context = getContext();
        const profile = resolveAuxiliaryProfile(context, block);
        const auxiliaryEntries = run.pendingUserText
            ? [...entries, { name: 'Pending User Message', output: run.pendingUserText, propagate: true }]
            : entries;
        const rawPrompt = await buildAuxiliaryPrompt(run, block, auxiliaryEntries, context, profile);
        const prompt = processBlockPrompt(run, block, rawPrompt);
        tracePipeline(run, 'auxiliary-prompt-processed', {
            position: block.position,
            regexApplied: appliesRegexAndQuickReplies(run, block),
            quickReplyLifecycleDispatched,
            promptKind: Array.isArray(prompt) ? 'chat-completion' : typeof prompt,
            ...getChatDiagnostics(),
        });
        tracePipeline(run, 'auxiliary-request-route', {
            position: block.position,
            transport: profile ? 'connection-manager' : 'main-api',
            apiType: profile?.type ?? context.mainApi,
            promptKind: Array.isArray(prompt) ? 'chat-completion' : typeof prompt,
            usesPromptManager: block.oaiPresetId !== EMPTY_PRESET,
            // Connection Manager wraps a string in a user message for Chat
            // Completion, so both prompt shapes reach the server as messages.
            serverRequestShape: profile?.type === 'openai' ? 'messages' : 'prompt',
            ...getChatDiagnostics(),
        });
        // generateQuietPrompt() re-enters Generate(), which owns the active chat,
        // input field and streaming UI. Auxiliary stages must never take ownership
        // of those objects. Do not switch the connection-profile or preset UI here:
        // those change events may reload the active chat while MAIN is unpersisted.
        let rawOutput;
        let rawReasoning = '';
        if (profile) {
            const result = await context.ConnectionManagerRequestService.sendRequest(
                profile.id,
                prompt,
                undefined,
                {
                    stream: false,
                    signal: run.abortSignal ?? null,
                    extractData: true,
                    // Do not override profile.preset. Connection Manager applies
                    // that preset to the request, including custom_include_body.
                    includePreset: true,
                    includeInstruct: true,
                },
            );
            rawOutput = typeof result === 'string' ? result : result?.content ?? '';
            rawReasoning = typeof result === 'string' ? '' : String(result?.reasoning ?? '');
        } else if (context.mainApi === 'openai' && block.oaiPresetId !== EMPTY_PRESET) {
            rawOutput = await context.withChatCompletionPreset(block.oaiPresetId, () => context.generateRaw({ prompt }));
        } else {
            rawOutput = await context.generateRaw({ prompt });
        }
        assertRunActive(run);
        const output = processBlockOutput(run, block, rawOutput);
        tracePipeline(run, 'auxiliary-complete', {
            position: block.position,
            rawContentLength: String(rawOutput ?? '').length,
            rawReasoningLength: rawReasoning.length,
            outputLength: output.length,
            ...getChatDiagnostics(),
        });
        return output;
    } finally {
        auxiliaryDepth--;
    }
}

function quickReplyReturnedTrue(result) {
    if (result === true) return true;
    return ['true', '1', 'yes', 'on'].includes(String(result ?? '').trim().toLowerCase());
}

function flattenPromptContent(value) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(flattenPromptContent).filter(Boolean).join('\n');
    if (!value || typeof value !== 'object') return '';
    if (typeof value.text === 'string') return value.text;
    if ('content' in value) return flattenPromptContent(value.content);
    return '';
}

function getPromptPreviewEntries(run) {
    return run.mainPromptPreviewEntry
        ? run.propagated.filter(entry => entry !== run.mainPromptPreviewEntry)
        : run.propagated;
}

function addMainPreviewToChat(run, context) {
    const preview = run.mainPromptPreview;
    if (!preview || preview.isStreaming || !Array.isArray(context.chat)) return () => { };

    const chat = context.chat;
    const previewText = preview.type === 'continue'
        ? `${String(run.continueMessage?.message?.mes ?? '')}${preview.text}`
        : preview.text;
    const targetIndex = preview.type === 'continue'
        ? chat.length - 1
        : preview.messageId;
    const target = chat[targetIndex];

    if (target && !target.is_user) {
        const originalText = target.mes;
        target.mes = previewText;
        return () => { target.mes = originalText; };
    }

    const virtualMessage = {
        name: context.name2,
        is_user: false,
        mes: previewText,
    };
    chat.push(virtualMessage);
    return () => {
        const index = chat.lastIndexOf(virtualMessage);
        if (index !== -1) chat.splice(index, 1);
    };
}

function temporarilyRemoveRegeneratedMessage(run, context) {
    // GENERATION_BEFORE_MAIN for Regenerate runs before core removes the old
    // assistant reply. Remove it while PRE or a prompt preview is running so
    // both receive the same history as the real MAIN request.
    if (run.type !== 'regenerate' || run.mainPromptPreview || !Array.isArray(context.chat)) return () => { };
    const chat = context.chat;
    const index = chat.length - 1;
    const message = chat[index];
    if (!message || message.is_user) return () => { };
    chat.splice(index, 1);
    return () => chat.splice(Math.min(index, chat.length), 0, message);
}

/**
 * Builds the prompt through Tavern's dry-run generation path. This is the same
 * Prompt Manager, World Info and history assembly used by MAIN, without making
 * a model request. The temporary pipeline context represents the blocks that
 * have already run at this point in the pipeline.
 */
async function getCurrentMainPromptText(run) {
    const context = getContext();
    let promptCaptured = false;
    let promptText = '';
    const capturePrompt = (data, dryRun) => {
        if (!dryRun) return;
        promptCaptured = true;
        promptText = flattenPromptContent(data?.prompt ?? data?.input ?? '');
    };

    const previewEntries = getPromptPreviewEntries(run);
    const removeMainPreview = addMainPreviewToChat(run, context);
    const restoreRegeneratedMessage = temporarilyRemoveRegeneratedMessage(run, context);
    setPipelineContext(previewEntries);
    eventSource.once(event_types.GENERATE_AFTER_DATA, capturePrompt);
    try {
        // Passing a signal preserves the abort controller owned by the live
        // pipeline generation. The dry run only assembles data and never calls
        // the backend.
        await context.generate(run.type, { signal: new AbortController().signal }, true);
        assertRunActive(run);
        if (!promptCaptured) {
            throw new Error('Tavern did not return a prepared MAIN prompt.');
        }
        return promptText;
    } finally {
        eventSource.removeListener(event_types.GENERATE_AFTER_DATA, capturePrompt);
        restoreRegeneratedMessage();
        removeMainPreview();
        setPipelineContext(run.propagated);
    }
}

async function shouldRunStaticBlock(run, block, previousOutput) {
    const condition = getRunCondition(block);
    if (condition === 'always') return true;
    if (condition === 'previous_nonempty') return Boolean(previousOutput);
    if (condition === 'previous_matches') {
        const pattern = String(block.previousOutputPattern ?? '').trim();
        if (!pattern) {
            throw new Error(`Previous Output Pattern in "${block.name}" is empty.`);
        }
        try {
            return new RegExp(pattern, 's').test(previousOutput);
        } catch (error) {
            throw new Error(`Previous Output Pattern in "${block.name}" is not a valid regular expression: ${error.message}`);
        }
    }
    if (condition === 'prompt_contains') {
        const text = String(block.promptText ?? '');
        if (!text) {
            throw new Error(`Prompt Text in "${block.name}" is empty.`);
        }
        const prompt = await getCurrentMainPromptText(run);
        const matched = prompt.includes(text);
        tracePipeline(run, 'prompt-condition-checked', {
            position: block.position,
            promptLength: prompt.length,
            matched,
            ...getChatDiagnostics(),
        });
        return matched;
    }
    const setName = String(block.quickReplySet ?? '').trim();
    const label = String(block.quickReplyLabel ?? '').trim();
    if (!setName || !label) {
        throw new Error(`Quick Reply Set and Quick Reply Label are required in "${block.name}".`);
    }
    if (typeof globalThis.quickReplyApi?.executeQuickReply !== 'function') {
        throw new Error('The Quick Replies extension is unavailable. Enable it to use this condition.');
    }
    run.currentBlockName = block.name;
    const result = await globalThis.quickReplyApi.executeQuickReply(setName, label, {
        previousOutput,
        blockId: block.id,
        blockName: block.name,
        pipelineType: run.type,
    });
    assertRunActive(run);
    return quickReplyReturnedTrue(result);
}

async function executeBlock(run, block, { allowSwipeReuse = false } = {}) {
    tracePipeline(run, 'block-start', { position: block.position, blockType: isStaticBlock(block) ? 'static' : 'generate', ...getChatDiagnostics() });
    if (isStaticBlock(block)) {
        run.currentBlockName = block.name;
        const previousOutput = String(run.records.at(-1)?.output ?? '').trim();
        const skipped = !await shouldRunStaticBlock(run, block, previousOutput);
        const output = skipped ? '' : processBlockOutput(run, block, block.staticText);
        const record = createPersistedBlock(block, output, false, skipped);
        run.records.push(record);
        if (record.propagate && output) run.propagated.push(record);
        tracePipeline(run, 'block-complete', { position: block.position, skipped, outputLength: output.length, ...getChatDiagnostics() });
        return record;
    }
    const sourceBlock = allowSwipeReuse ? findSourceBlock(run, block) : null;
    const keepOnSwipe = getKeepOnSwipeSetting(run, block);
    if (allowSwipeReuse) {
        tracePipeline(run, 'block-reuse-check', {
            position: block.position,
            keepOnSwipe,
            snapshotKeepOnSwipe: Boolean(block.keepOnSwipe),
            sourceFound: Boolean(sourceBlock),
            sourceHasStoredOutput: typeof sourceBlock?.output === 'string',
            sourceVisibility: sourceBlock?.visibility ?? null,
            ...getChatDiagnostics(),
        });
    }
    const source = keepOnSwipe ? sourceBlock : null;
    if (source && typeof source.output === 'string') {
        const record = createPersistedBlock(block, source.output, true);
        run.records.push(record);
        if (record.propagate) run.propagated.push(record);
        tracePipeline(run, 'block-reused', { position: block.position, outputLength: record.output.length, ...getChatDiagnostics() });
        return record;
    }
    run.currentBlockName = block.name;
    const output = await generateBlock(run, block, run.propagated);
    const record = createPersistedBlock(block, output, false);
    run.records.push(record);
    if (record.propagate) run.propagated.push(record);
    tracePipeline(run, 'block-complete', { position: block.position, outputLength: output.length, ...getChatDiagnostics() });
    return record;
}

async function executePreBlocks(run) {
    const blocks = run.presetSnapshot.blocks.filter(block => block.position === 'pre' && block.enabled !== false);
    if (run.type === 'continue') {
        for (const block of blocks) {
            const source = findSourceBlock(run, block);
            if (typeof source?.output !== 'string') {
                if (block.visibility === 'discard' && block.propagate) {
                    throw new Error(`Continue cannot reuse PRE block \"${block.name}\": its propagated output was discarded by design.`);
                }
                console.warn(`${MODULE_NAME}: PRE block \"${block.name}\" has no persisted output for Continue.`);
                continue;
            }
            const record = createPersistedBlock(block, source.output, true, source.skipped);
            run.records.push(record);
            if (record.propagate) run.propagated.push(record);
        }
        return;
    }
    for (const block of blocks) {
        await executeBlock(run, block, { allowSwipeReuse: run.type === 'swipe' });
    }
}

async function applyMainState(run) {
    if (run.presetSnapshot.main?.connectionProfileId) {
        await switchConnectionProfile(run.presetSnapshot.main.connectionProfileId);
    }
    run.mainStateApplied = true;
    setPipelineContext(run.propagated);
}

function getVisibleAssembly(records, position) {
    return records
        .filter(record => record.position === position && record.visibility === 'visible' && typeof record.output === 'string' && record.output.trim())
        .map(record => record.output.trim())
        .join('\n\n');
}

function assembleMessage(pre, main, post) {
    return [pre, main, post].filter(value => String(value ?? '').trim()).join('\n\n');
}

function buildPipelineFinalization(run, main) {
    const assembly = {
        pre: getVisibleAssembly(run.records, 'pre'),
        main: String(main ?? ''),
        post: getVisibleAssembly(run.records, 'post'),
        dirty: false,
    };
    const pipelineRun = {
        version: PIPELINE_VERSION,
        presetSnapshot: clone(run.presetSnapshot),
        blocks: run.records.map(record => {
            const persisted = clone(record);
            if (persisted.visibility === 'discard') delete persisted.output;
            return persisted;
        }),
        assembly,
    };
    return {
        text: assembleMessage(assembly.pre, assembly.main, assembly.post),
        extraPatch: { [PIPELINE_METADATA_KEY]: pipelineRun },
    };
}

async function finalizeRun(context) {
    const run = activeRun;
    if (!run || run.finalized || run.type !== context.type) return undefined;
    run.finalized = true;
    run.abortSignal = context.abortSignal;
    tracePipeline(run, 'finalizer-enter', {
        type: context.type,
        streaming: context.isStreaming,
        inputLength: String(context.text ?? '').length,
        reasoningLength: String(context.reasoning ?? '').length,
        rawAssistantOutputLength: String(context.rawAssistantOutput ?? '').length,
        ...getChatDiagnostics(context.messageId),
    });
    try {
        assertRunActive(run);
        clearPipelineContext();
        const main = String(context.text ?? '');
        run.main = main;
        const postEntries = [...run.propagated];
        if (!context.isStreaming) {
            const mainEntry = { name: 'MAIN', output: main, propagate: true };
            postEntries.push(mainEntry);
            // Non-streaming finalization happens before core saves MAIN into
            // chat. Prompt preview therefore supplies a temporary assistant
            // message and omits this context-only MAIN entry to avoid adding it
            // twice under different roles.
            run.mainPromptPreviewEntry = mainEntry;
        }
        run.mainPromptPreview = {
            type: context.type,
            text: main,
            messageId: context.messageId,
            isStreaming: context.isStreaming,
        };
        run.propagated = postEntries;
        for (const block of run.presetSnapshot.blocks.filter(block => block.position === 'post' && block.enabled !== false)) {
            await executeBlock(run, block, { allowSwipeReuse: run.type === 'swipe' });
        }
        const result = buildPipelineFinalization(run, main);
        tracePipeline(run, 'finalizer-return', { outputLength: result.text.length, ...getChatDiagnostics(context.messageId) });
        return result;
    } catch (error) {
        if (isAbortError(error)) {
            const result = buildPipelineFinalization(run, context.text);
            tracePipeline(run, 'finalizer-aborted', { outputLength: result.text.length, ...getChatDiagnostics(context.messageId) });
            return result;
        }
        const message = `Multi-Stage Composer: block failed${run.currentBlockName ? ` (${run.currentBlockName})` : ''}: ${error.message || error}`;
        // A POST block runs after streaming has created the normal assistant reply.
        // Keep that completed MAIN reply when an auxiliary block fails instead of
        // making core roll back the whole intermediary message.
        console.error(message, error);
        toastr.error(message);
        const result = buildPipelineFinalization(run, context.text);
        tracePipeline(run, 'finalizer-fallback', { outputLength: result.text.length, ...getChatDiagnostics(context.messageId) });
        return result;
    } finally {
        clearPipelineContext();
        // Switching profiles may make another extension reload the chat. At this
        // point a streaming assistant message has not been persisted yet, so defer
        // the UI change until core confirms the generation save has completed.
        pendingStateRestores.push({ snapshot: run.originalState, diagnosticId: run.diagnosticId });
        tracePipeline(run, 'state-restore-deferred', getChatDiagnostics(context.messageId));
        activeRun = null;
    }
}

async function prepareRun(type, options, dryRun) {
    if (dryRun || auxiliaryDepth > 0 || !['normal', 'regenerate', 'swipe', 'continue'].includes(type)) return;
    if (activeRun?.aborted) {
        clearPipelineContext();
        await restoreTavernState(activeRun.originalState);
        activeRun = null;
    }
    if (activeRun) return;
    const run = createRun(type, options);
    if (!run) return;
    activeRun = run;
    try {
        tracePipeline(run, 'prepare-start', { type, ...getChatDiagnostics() });
        // GENERATION_BEFORE_MAIN runs after core has committed a new user message.
        // Its text is now already present in chat history, so do not duplicate it in
        // auxiliary prompts or the pipeline context.
        run.pendingUserText = '';
        if (type === 'continue') {
            const message = getContext().chat.at(-1);
            const main = run.sourcePipeline?.assembly?.main;
            if (!message || typeof main !== 'string') {
                throw new Error('This message has no usable Multi-Stage Composer assembly for Continue.');
            }
            run.continueMessage = { message, mes: message.mes };
            message.mes = main;
        }
        await applyMainState(run);
        // Core deletes the old assistant message for Regenerate only after this
        // hook returns. PRE must nevertheless see the same history as the new
        // MAIN request, so remove it temporarily and restore it for core to
        // perform its normal replacement.
        const restoreRegeneratedMessage = temporarilyRemoveRegeneratedMessage(run, getContext());
        try {
            // Static PRE conditions can preview the actual MAIN prompt. Apply
            // the selected MAIN connection state first, then refresh pipeline
            // context after PRE has produced its propagated entries.
            await executePreBlocks(run);
            setPipelineContext(run.propagated);
        } finally {
            restoreRegeneratedMessage();
        }
        tracePipeline(run, 'pre-complete', { ...getChatDiagnostics() });
        tracePipeline(run, 'main-context-ready', { ...getChatDiagnostics() });
    } catch (error) {
        tracePipeline(run, 'prepare-failed', { ...getChatDiagnostics() });
        if (!isAbortError(error)) {
            toastr.error(`Multi-Stage Composer: PRE block failed: ${error.message || error}`);
        }
        if (run.continueMessage) run.continueMessage.message.mes = run.continueMessage.mes;
        clearPipelineContext();
        await restoreTavernState(run.originalState);
        activeRun = null;
        throw error;
    }
}

function installPipelineRuntime() {
    unregisterFinalizer?.();
    unregisterFinalizer = registerGenerationFinalizer(finalizeRun);
    eventSource.on(event_types.GENERATION_BEFORE_MAIN, prepareRun);
    eventSource.on(event_types.GENERATION_STOPPED, () => {
        if (activeRun) {
            tracePipeline(activeRun, 'generation-stopped', getChatDiagnostics());
            activeRun.aborted = true;
        }
    });
    eventSource.on(event_types.MESSAGE_RECEIVED, (messageId, type) => {
        tracePipeline(null, 'message-received', { type, ...getChatDiagnostics(messageId) });
    });
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (messageId, type) => {
        tracePipeline(null, 'message-rendered', { type, ...getChatDiagnostics(messageId) });
    });
    eventSource.on(event_types.MESSAGE_DELETED, () => {
        const stack = String(new Error().stack ?? '').split('\n').slice(1, 4).map(line => line.trim()).join(' | ');
        tracePipeline(null, 'message-deleted', { ...getChatDiagnostics(), stack });
    });
    eventSource.on(event_types.GENERATION_ENDED, async () => {
        if (auxiliaryDepth > 0) return;
        const run = activeRun;
        tracePipeline(run, 'generation-ended', getChatDiagnostics());
        // A normal run owns its cleanup in finalizeRun(). GENERATION_ENDED is global
        // and may also be emitted by auxiliary work, so only use it to clean up an
        // explicitly stopped pipeline.
        if (!run?.aborted) return;
        tracePipeline(run, 'generation-ended-aborted', getChatDiagnostics());
        clearPipelineContext();
        if (run.continueMessage) run.continueMessage.message.mes = run.continueMessage.mes;
        await restoreTavernState(run.originalState);
        activeRun = null;
    });
    eventSource.on(event_types.GENERATION_SAVED, async () => {
        const restores = pendingStateRestores;
        pendingStateRestores = [];
        for (const restore of restores) {
            tracePipeline(lastDiagnosticRun, 'state-restore-after-save', { diagnosticId: restore.diagnosticId, ...getChatDiagnostics() });
            await restoreTavernState(restore.snapshot);
        }
    });
}

function installApi() {
    window.STMessageConstructor = {
        getActivePreset: () => clone(getActivePreset()),
        getPipelinePresets: () => clone(getSettings().presets),
    };
}

export async function init() {
    if (initialized) return;
    initialized = true;
    ensureSettings();
    installApi();
    installPipelineRuntime();
    eventSource.on(event_types.APP_READY, renderUI);
    eventSource.on(event_types.EXTENSION_SETTINGS_LOADED, renderUI);
    await renderUI();
}

jQuery(() => void init());
